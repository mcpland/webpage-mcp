import console from "node:console";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  resolveChromeExtensionPublicKey,
  validateChromeExtensionPublicKey,
} from "./extension-public-key.mjs";
import { loadReviewedLegalFiles } from "./legal-notices.mjs";
import { validateUnifiedReleaseVersion } from "./unified-release-version.mjs";
import {
  MCP_NPM_SHRINKWRAP_PATH,
  parseMcpNpmShrinkwrap,
  verifyMcpNpmShrinkwrap,
} from "./mcp-npm-shrinkwrap.mjs";
import { loadMcpBundleComponents } from "./mcp-bundle-components.mjs";

const RELEASE_PACKAGES = [
  {
    path: "app/mcp-server/package.json",
    name: "webpage-mcp",
  },
  {
    path: "app/chrome-extension/package.json",
    name: "webpage-mcp-connector",
  },
];

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_METADATA_BYTES = 1024 * 1024;
const MCP_PACKAGE_CONTRACT = {
  description: "Webpage MCP server",
  main: "dist/index.js",
  bin: {
    "webpage-mcp": "./dist/cli.js",
    "webpage-mcp-server": "./dist/mcp/mcp-server-http.js",
    "webpage-mcp-stdio": "./dist/mcp/mcp-server-stdio.js",
  },
  files: [
    "dist",
    "LICENSE",
    "npm-shrinkwrap.json",
    "THIRD_PARTY_NOTICES.md",
    "THIRD_PARTY_COMPONENTS.json",
    "!dist/node_path.txt",
  ],
  engines: { node: ">=22.0.0" },
  license: "MIT",
  publishConfig: { access: "public", provenance: true },
  repository: {
    type: "git",
    url: "https://github.com/mcpland/webpage-mcp.git",
    directory: "app/mcp-server",
  },
  preferGlobal: true,
};
const MCP_PACKED_FIELDS = [
  "description",
  "main",
  "bin",
  "files",
  "engines",
  "license",
  "publishConfig",
  "repository",
  "preferGlobal",
  "dependencies",
  "overrides",
];
const MCP_RUNTIME_ENTRYPOINTS = [
  "package/dist/native-messaging-host.js",
  "package/dist/scripts/native-log-runner.js",
  "package/dist/scripts/postinstall.js",
  "package/dist/run_host.sh",
  "package/dist/run_host.bat",
];
// Keep the supervisor's first-party dependency edge explicit. Unlike the
// bundled host entrypoint, native-log-runner.js is emitted as CommonJS and
// requires this sibling module at process startup.
const MCP_LOCAL_RUNTIME_DEPENDENCIES = {
  "package/dist/scripts/native-log-runner.js": [
    "package/dist/scripts/native-log-policy.js",
  ],
};
const MCP_REQUIRED_RUNTIME_FILES = [
  ...MCP_RUNTIME_ENTRYPOINTS,
  ...new Set(Object.values(MCP_LOCAL_RUNTIME_DEPENDENCIES).flat()),
];
const EXTENSION_REQUIRED_PERMISSIONS = [
  "nativeMessaging",
  "tabs",
  "activeTab",
  "scripting",
  "userScripts",
  "contextMenus",
  "downloads",
  "webRequest",
  "webNavigation",
  "debugger",
  "history",
  "bookmarks",
  "offscreen",
  "notifications",
  "storage",
  "alarms",
  "sidePanel",
];
const DEFAULT_EXTENSION_BUILD_DIR = "app/chrome-extension/.output/chrome-mv3";
const EXTENSION_VERIFICATION_BUILD_MATCH = "build-match";
const EXTENSION_VERIFICATION_ARCHIVE_ONLY = "archive-only";
const RELEASE_PREFLIGHT_USAGE =
  "Usage: release-preflight.mjs <metadata|artifacts|npm-publish> [artifacts-dir] [--tag <vX.Y.Z>] [--ref <refs/tags/vX.Y.Z>] [--require-build-match|--archive-only]";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function verifyMcpSourcePackageContract(pkg, description) {
  invariant(isRecord(pkg), `${description} must contain a JSON object`);
  invariant(pkg.private !== true, `${description} may not be private`);
  for (const [field, expected] of Object.entries(MCP_PACKAGE_CONTRACT)) {
    invariant(
      isDeepStrictEqual(pkg[field], expected),
      `${description} ${field} must match the release contract`,
    );
  }
  invariant(
    isRecord(pkg.scripts) &&
      typeof pkg.scripts.postinstall === "string" &&
      pkg.scripts.postinstall.includes("dist/scripts/postinstall.js"),
    `${description} scripts.postinstall must invoke dist/scripts/postinstall.js`,
  );
  invariant(
    isRecord(pkg.dependencies) && Object.keys(pkg.dependencies).length > 0,
    `${description} must declare runtime dependencies`,
  );
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    invariant(
      typeof version === "string" &&
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
          version,
        ),
      `${description} runtime dependency ${name} must use an exact version`,
    );
  }
}

function normalizeArchivePath(
  rawName,
  description,
  { directory = false } = {},
) {
  invariant(
    typeof rawName === "string" && rawName.length > 0,
    `${description} contains an empty path`,
  );
  invariant(!rawName.includes("\0"), `${description} contains a NUL path`);
  invariant(
    !rawName.includes("\\"),
    `${description} contains a backslash path: ${rawName}`,
  );
  invariant(
    !rawName.startsWith("/") && !/^[A-Za-z]:/.test(rawName),
    `${description} contains an absolute path: ${rawName}`,
  );
  const path =
    directory && rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
  invariant(path.length > 0, `${description} contains an empty path`);
  const segments = path.split("/");
  invariant(
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    ),
    `${description} contains an unsafe path: ${rawName}`,
  );
  return path;
}

function normalizePackageTarget(rawPath, description) {
  invariant(
    typeof rawPath === "string" && rawPath.length > 0,
    `${description} must be a path`,
  );
  const normalized = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  return `package/${normalizeArchivePath(normalized, description)}`;
}

async function readJson(path, description) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${description}: ${error.message}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${description}: ${error.message}`);
  }
}

function normalizeReleaseTag(tag) {
  if (tag === undefined || tag === null || tag === "") {
    return undefined;
  }

  invariant(
    typeof tag === "string" && tag.startsWith("v"),
    `Release tag must use the v<version> form, received: ${String(tag)}`,
  );
  const version = tag.slice(1);
  return validateUnifiedReleaseVersion(version, "Release tag version");
}

export async function verifyReleaseMetadata({
  rootDir = process.cwd(),
  tag,
  environment = process.env,
} = {}) {
  const tagVersion = normalizeReleaseTag(tag);
  const extensionPublicKey = resolveChromeExtensionPublicKey(environment);
  const packages = [];

  for (const releasePackage of RELEASE_PACKAGES) {
    const pkg = await readJson(
      resolve(rootDir, releasePackage.path),
      releasePackage.path,
    );
    invariant(
      pkg.name === releasePackage.name,
      `${releasePackage.path} must have name ${releasePackage.name}, received: ${String(pkg.name)}`,
    );
    if (releasePackage.name === "webpage-mcp") {
      verifyMcpSourcePackageContract(pkg, releasePackage.path);
      for (const [name, bundledVersion] of loadMcpBundleComponents(rootDir)) {
        const runtimeVersion = pkg.dependencies[name];
        invariant(
          runtimeVersion === undefined || runtimeVersion === bundledVersion,
          `${releasePackage.path} dual-distributed dependency ${name} must match bundled version ${bundledVersion}`,
        );
      }
    }
    const version = validateUnifiedReleaseVersion(
      pkg.version,
      `${releasePackage.path} version`,
    );
    packages.push({ ...releasePackage, version });
  }

  const expectedVersion = packages[0].version;
  for (const pkg of packages.slice(1)) {
    invariant(
      pkg.version === expectedVersion,
      `Release package versions must match: ${packages[0].path}=${expectedVersion}, ${pkg.path}=${pkg.version}`,
    );
  }
  await verifyMcpNpmShrinkwrap({ rootDir });
  if (tagVersion !== undefined) {
    invariant(
      tagVersion === expectedVersion,
      `Release tag version ${tagVersion} does not match package version ${expectedVersion}`,
    );
  }

  return {
    version: expectedVersion,
    tagVersion,
    packages,
    extensionPublicKey,
  };
}

export async function verifyNpmPublishRef({
  rootDir = process.cwd(),
  ref,
  environment = process.env,
} = {}) {
  const prefix = "refs/tags/";
  invariant(
    typeof ref === "string" && ref.startsWith(prefix),
    `npm publish requires an exact refs/tags/v<version> ref, received: ${String(ref)}`,
  );
  const tag = ref.slice(prefix.length);
  const metadata = await verifyReleaseMetadata({
    rootDir,
    tag,
    environment,
  });
  const expectedRef = `${prefix}v${metadata.version}`;
  invariant(
    ref === expectedRef,
    `npm publish ref ${ref} does not exactly match ${expectedRef}`,
  );
  return { ...metadata, ref };
}

async function listFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, path)));
      continue;
    }
    invariant(
      entry.isFile(),
      `Release artifacts may not contain links or special files: ${path}`,
    );
    files.push(relative(rootDir, path).split(sep).join("/"));
  }
  return files.sort();
}

async function readBoundedFile(path, description) {
  const stats = await lstat(path);
  invariant(stats.isFile(), `${description} must be a regular file: ${path}`);
  invariant(
    stats.size > 0 && stats.size <= MAX_ARCHIVE_BYTES,
    `${description} must be between 1 byte and ${MAX_ARCHIVE_BYTES} bytes: ${path}`,
  );
  return readFile(path);
}

function parseArchiveJson(bytes, description) {
  invariant(
    bytes.length > 0 && bytes.length <= MAX_ARCHIVE_METADATA_BYTES,
    `${description} must be between 1 byte and ${MAX_ARCHIVE_METADATA_BYTES} bytes`,
  );
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Invalid embedded JSON in ${description}: ${error.message}`,
    );
  }
}

function decompressTarArchive(archive, description) {
  try {
    return gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES });
  } catch (error) {
    throw new Error(`Unable to inspect ${description}: ${error.message}`);
  }
}

function parseTarOctal(field, description, { allowEmpty = false } = {}) {
  const value = field.toString("utf8").replace(/\0.*$/s, "").trim();
  if (allowEmpty && value === "") return 0;
  invariant(/^[0-7]+$/.test(value), `Invalid tar ${description}: ${value}`);
  const parsed = Number.parseInt(value, 8);
  invariant(
    Number.isSafeInteger(parsed),
    `Invalid tar ${description}: ${value}`,
  );
  return parsed;
}

function inspectTarArchive(tar, description) {
  const entries = new Map();
  const canonicalNames = new Set();
  let terminated = false;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      invariant(
        offset + 1024 <= tar.length &&
          tar.subarray(offset, offset + 1024).every((byte) => byte === 0) &&
          tar.subarray(offset + 1024).every((byte) => byte === 0),
        `Invalid tar terminator in ${description}`,
      );
      terminated = true;
      break;
    }

    const readField = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "")
        .trim();
    const name = readField(0, 100);
    const prefix = readField(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    invariant(
      header.subarray(257, 262).toString("utf8") === "ustar",
      `Unsupported tar header format in ${description}: ${fullName}`,
    );
    const expectedChecksum = parseTarOctal(
      header.subarray(148, 156),
      `header checksum in ${description}`,
    );
    let actualChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    invariant(
      actualChecksum === expectedChecksum,
      `Tar header checksum mismatch in ${description}: ${fullName}`,
    );
    const size = parseTarOctal(
      header.subarray(124, 136),
      `entry size in ${description}`,
      { allowEmpty: true },
    );
    const mode = parseTarOctal(
      header.subarray(100, 108),
      `entry mode in ${description}`,
      { allowEmpty: true },
    );
    const type = String.fromCharCode(header[156] || 0);
    const isDirectory = type === "5";
    invariant(
      type === "\0" || type === "0" || isDirectory,
      `Release tar may not contain links or special entries: ${fullName}`,
    );
    const normalizedName = normalizeArchivePath(fullName, description, {
      directory: isDirectory,
    });
    invariant(
      !canonicalNames.has(normalizedName),
      `Duplicate tar entry in ${description}: ${normalizedName}`,
    );
    canonicalNames.add(normalizedName);
    invariant(
      (mode & 0o022) === 0,
      `Release tar entry may not be group/world writable: ${normalizedName}`,
    );
    invariant(
      !isDirectory || size === 0,
      `Tar directory entry must be empty in ${description}: ${normalizedName}`,
    );
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    invariant(
      Number.isSafeInteger(size) && dataEnd <= tar.length,
      `Truncated tar entry in ${description}: ${fullName}`,
    );

    entries.set(normalizedName, {
      name: normalizedName,
      bytes: Buffer.from(tar.subarray(dataStart, dataEnd)),
      isDirectory,
      mode,
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  invariant(entries.size > 0, `${description} contains no entries`);
  invariant(terminated, `${description} is missing its tar terminator`);
  return entries;
}

function readTarEntry(entries, entryName, description) {
  const entry = entries.get(entryName);
  invariant(
    entry && !entry.isDirectory,
    `Missing ${entryName} in ${description}`,
  );
  return entry.bytes;
}

function readTarEntryJson(entries, entryName, description) {
  return parseArchiveJson(
    readTarEntry(entries, entryName, description),
    description,
  );
}

function findZipEndOfCentralDirectory(archive, description) {
  invariant(archive.length >= 22, `${description} is not a valid ZIP archive`);
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error(`Unable to inspect ${description}: ZIP directory is missing`);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectZipArchive(archive, description) {
  const eocdOffset = findZipEndOfCentralDirectory(archive, description);
  invariant(
    archive.readUInt16LE(eocdOffset + 4) === 0 &&
      archive.readUInt16LE(eocdOffset + 6) === 0,
    `${description} may not be a multi-disk ZIP archive`,
  );
  const diskEntryCount = archive.readUInt16LE(eocdOffset + 8);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  invariant(
    entryCount !== 0xffff &&
      diskEntryCount === entryCount &&
      centralSize !== 0xffffffff &&
      centralOffset !== 0xffffffff &&
      centralOffset + centralSize === eocdOffset,
    `${description} uses unsupported ZIP64 or invalid directory metadata`,
  );
  invariant(entryCount > 0, `${description} contains no entries`);

  let offset = centralOffset;
  let totalUncompressedBytes = 0;
  const entries = new Map();
  const canonicalNames = new Set();
  const localRanges = [];
  for (let index = 0; index < entryCount; index += 1) {
    invariant(
      offset + 46 <= archive.length &&
        archive.readUInt32LE(offset) === 0x02014b50,
      `Invalid ZIP central directory in ${description}`,
    );
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const expectedCrc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const versionMadeBy = archive.readUInt16LE(offset + 4);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    invariant(
      nextOffset <= archive.length,
      `Truncated ZIP directory in ${description}`,
    );
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
    invariant(
      nameBytes.length > 0,
      `${description} contains an empty ZIP path`,
    );
    invariant(!nameBytes.includes(0), `${description} contains a NUL ZIP path`);
    invariant(
      (flags & ~0x800) === 0,
      `${description} contains encrypted or unsupported ZIP flags`,
    );
    invariant(
      (flags & 0x800) !== 0 || nameBytes.every((byte) => byte < 0x80),
      `${description} contains a non-ASCII path without the UTF-8 flag`,
    );
    const rawName = nameBytes.toString("utf8");
    invariant(
      (flags & 0x800) === 0 || Buffer.from(rawName, "utf8").equals(nameBytes),
      `${description} contains an invalid UTF-8 path`,
    );
    const isDirectory = rawName.endsWith("/");
    const name = normalizeArchivePath(rawName, description, {
      directory: isDirectory,
    });
    invariant(
      !canonicalNames.has(name),
      `Duplicate ZIP entry in ${description}: ${name}`,
    );
    canonicalNames.add(name);
    const sourcePlatform = versionMadeBy >>> 8;
    if (sourcePlatform === 3) {
      const unixMode = (externalAttributes >>> 16) & 0xffff;
      const unixType = unixMode & 0o170000;
      invariant(
        unixType === 0 || unixType === 0o100000 || unixType === 0o040000,
        `Release ZIP may not contain links or special entries: ${name}`,
      );
      invariant(
        unixType === 0 ||
          (isDirectory ? unixType === 0o040000 : unixType === 0o100000),
        `ZIP entry type disagrees with its path: ${name}`,
      );
    }
    invariant(
      compressedSize !== 0xffffffff &&
        uncompressedSize !== 0xffffffff &&
        compressedSize <= MAX_ARCHIVE_BYTES &&
        uncompressedSize <= MAX_ARCHIVE_BYTES,
      `${description} entry exceeds the ${MAX_ARCHIVE_BYTES}-byte limit: ${name}`,
    );
    totalUncompressedBytes += uncompressedSize;
    invariant(
      Number.isSafeInteger(totalUncompressedBytes) &&
        totalUncompressedBytes <= MAX_ARCHIVE_BYTES,
      `${description} expands beyond the ${MAX_ARCHIVE_BYTES}-byte limit`,
    );
    invariant(
      !isDirectory ||
        (compressedSize === 0 && uncompressedSize === 0 && method === 0),
      `ZIP directory entry must be empty and stored: ${name}`,
    );
    invariant(
      method === 0 || method === 8,
      `Unsupported ZIP compression method ${method} in ${description}`,
    );
    invariant(
      localOffset + 30 <= centralOffset &&
        archive.readUInt32LE(localOffset) === 0x04034b50,
      `Invalid local ZIP header for ${name}`,
    );
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localCrc = archive.readUInt32LE(localOffset + 14);
    const localCompressedSize = archive.readUInt32LE(localOffset + 18);
    const localUncompressedSize = archive.readUInt32LE(localOffset + 22);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    invariant(dataEnd <= centralOffset, `Truncated ZIP entry for ${name}`);
    invariant(
      localFlags === flags &&
        localMethod === method &&
        localCrc === expectedCrc &&
        localCompressedSize === compressedSize &&
        localUncompressedSize === uncompressedSize,
      `ZIP directory disagrees with local header for ${name}`,
    );
    invariant(
      archive
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .equals(nameBytes),
      `ZIP local header name mismatch for ${name}`,
    );
    const compressed = archive.subarray(dataStart, dataEnd);
    let bytes;
    if (method === 0) {
      bytes = Buffer.from(compressed);
    } else {
      try {
        bytes = inflateRawSync(compressed, {
          maxOutputLength: MAX_ARCHIVE_BYTES,
        });
      } catch (error) {
        throw new Error(`Unable to inspect ${description}: ${error.message}`);
      }
    }
    invariant(
      bytes.length === uncompressedSize,
      `ZIP entry size mismatch for ${name} in ${description}`,
    );
    invariant(
      crc32(bytes) === expectedCrc,
      `ZIP entry CRC mismatch for ${name} in ${description}`,
    );
    entries.set(name, { name, bytes, isDirectory });
    localRanges.push({ start: localOffset, end: dataEnd, name });

    offset = nextOffset;
  }

  invariant(
    offset === centralOffset + centralSize,
    `ZIP directory size mismatch in ${description}`,
  );

  localRanges.sort((left, right) => left.start - right.start);
  invariant(
    localRanges[0].start === 0,
    `${description} contains data before its first ZIP entry`,
  );
  for (let index = 1; index < localRanges.length; index += 1) {
    invariant(
      localRanges[index - 1].end === localRanges[index].start,
      `ZIP entries are overlapping or contain untracked data in ${description}: ${localRanges[index - 1].name}, ${localRanges[index].name}`,
    );
  }
  invariant(
    localRanges.at(-1).end === centralOffset,
    `${description} contains untracked data before its ZIP directory`,
  );
  return entries;
}

function readZipEntry(entries, entryName, description) {
  const entry = entries.get(entryName);
  invariant(
    entry && !entry.isDirectory,
    `Missing ${entryName} in ${description}`,
  );
  return entry.bytes;
}

function readZipEntryJson(entries, entryName, description) {
  return parseArchiveJson(
    readZipEntry(entries, entryName, description),
    description,
  );
}

function requireNonemptyArchiveFile(entries, path, description) {
  const entry = entries.get(path);
  invariant(entry && !entry.isDirectory, `Missing ${path} in ${description}`);
  invariant(
    entry.bytes.length > 0,
    `${path} in ${description} may not be empty`,
  );
  return entry;
}

function verifyStaticLocalCommonJsDependencies(entries, entryPath) {
  const source = requireNonemptyArchiveFile(
    entries,
    entryPath,
    "npm tarball",
  ).bytes.toString("utf8");
  const specifiers = new Set(
    Array.from(
      source.matchAll(/\brequire\(\s*["'](\.[^"']*)["']\s*\)/g),
      (match) => match[1],
    ),
  );
  for (const specifier of specifiers) {
    invariant(
      !specifier.includes("\\"),
      `npm runtime dependency must use a POSIX path: ${specifier}`,
    );
    const resolved = posix.normalize(
      posix.join(posix.dirname(entryPath), specifier),
    );
    invariant(
      resolved.startsWith("package/"),
      `npm runtime dependency escapes package/: ${specifier}`,
    );
    const candidates = posix.extname(resolved)
      ? [resolved]
      : [`${resolved}.js`, `${resolved}/index.js`];
    invariant(
      candidates.some((candidate) => {
        const entry = entries.get(candidate);
        return entry && !entry.isDirectory && entry.bytes.length > 0;
      }),
      `${entryPath} is missing local dependency ${specifier}`,
    );
  }
}

async function verifyPackedMcpPackage({
  packedPackage,
  sourcePackage,
  sourceShrinkwrap,
  bundleComponents,
  tarEntries,
}) {
  const { findExternalBundledDependency } =
    await import("./packed-javascript-policy.mjs");
  invariant(
    isRecord(packedPackage),
    "npm tarball package/package.json must contain an object",
  );
  for (const field of MCP_PACKED_FIELDS) {
    invariant(
      isDeepStrictEqual(packedPackage[field], sourcePackage[field]),
      `npm tarball package field ${field} does not match app/mcp-server/package.json`,
    );
  }
  invariant(
    packedPackage.scripts?.postinstall === sourcePackage.scripts?.postinstall,
    "npm tarball package field scripts.postinstall does not match app/mcp-server/package.json",
  );
  for (const [name, value] of Object.entries(packedPackage.dependencies)) {
    invariant(
      typeof value === "string" && !value.startsWith("workspace:"),
      `npm runtime dependency ${name} must be publishable and may not use workspace:`,
    );
  }
  const packedShrinkwrap = readTarEntry(
    tarEntries,
    "package/npm-shrinkwrap.json",
    "npm tarball npm-shrinkwrap.json",
  );
  invariant(
    packedShrinkwrap.equals(sourceShrinkwrap),
    "npm tarball npm-shrinkwrap.json does not match the reviewed repository source",
  );
  parseMcpNpmShrinkwrap(packedShrinkwrap, { sourcePackage: packedPackage });
  const bundledOnlyNames = [];
  for (const [name, bundledVersion] of bundleComponents) {
    const runtimeVersion = packedPackage.dependencies[name];
    invariant(
      runtimeVersion === undefined || runtimeVersion === bundledVersion,
      `npm tarball dual-distributed dependency ${name} must match bundled version ${bundledVersion}`,
    );
    if (runtimeVersion === undefined) bundledOnlyNames.push(name);
  }
  for (const entry of tarEntries.values()) {
    if (
      !entry.isDirectory &&
      entry.name.startsWith("package/dist/") &&
      entry.name.endsWith(".js")
    ) {
      invariant(
        findExternalBundledDependency(
          entry.bytes.toString("utf8"),
          bundledOnlyNames,
        ) === undefined,
        `${entry.name} leaves a bundled-only dependency external`,
      );
    }
  }
  for (const entry of tarEntries.values()) {
    invariant(
      entry.name === "package" || entry.name.startsWith("package/"),
      `npm tarball entry must stay under package/: ${entry.name}`,
    );
  }

  const mainPath = normalizePackageTarget(
    packedPackage.main,
    "npm package main",
  );
  requireNonemptyArchiveFile(tarEntries, mainPath, "npm tarball");
  invariant(isRecord(packedPackage.bin), "npm package bin must be an object");
  for (const [binName, binTarget] of Object.entries(packedPackage.bin)) {
    const binPath = normalizePackageTarget(
      binTarget,
      `npm package bin.${binName}`,
    );
    const entry = requireNonemptyArchiveFile(
      tarEntries,
      binPath,
      "npm tarball",
    );
    invariant(
      (entry.mode & 0o111) !== 0,
      `npm package bin.${binName} target must be executable: ${binPath}`,
    );
    invariant(
      entry.bytes.subarray(0, 2).toString("utf8") === "#!",
      `npm package bin.${binName} target must begin with a shebang: ${binPath}`,
    );
  }
  for (const path of MCP_REQUIRED_RUNTIME_FILES) {
    requireNonemptyArchiveFile(tarEntries, path, "npm tarball");
  }
  verifyStaticLocalCommonJsDependencies(
    tarEntries,
    "package/dist/scripts/native-log-runner.js",
  );
}

function requireStringPath(rawPath, description) {
  invariant(
    typeof rawPath === "string" && rawPath.length > 0,
    `${description} must be a path`,
  );
  return normalizeArchivePath(rawPath, description);
}

function verifyExtensionManifest({ manifest, zipEntries }) {
  invariant(isRecord(manifest), "Extension manifest must contain an object");
  invariant(
    manifest.manifest_version === 3,
    "Extension manifest_version must be 3",
  );
  invariant(
    manifest.minimum_chrome_version === "135",
    'Extension minimum_chrome_version must be exactly "135"',
  );
  invariant(
    typeof manifest.name === "string" && manifest.name.length > 0,
    "Extension manifest name must be non-empty",
  );
  invariant(
    typeof manifest.description === "string" && manifest.description.length > 0,
    "Extension manifest description must be non-empty",
  );

  invariant(
    Array.isArray(manifest.permissions),
    "Extension manifest permissions must be an array",
  );
  invariant(
    new Set(manifest.permissions).size === manifest.permissions.length &&
      manifest.permissions.every(
        (permission) => typeof permission === "string",
      ),
    "Extension manifest permissions must be unique strings",
  );
  for (const permission of EXTENSION_REQUIRED_PERMISSIONS) {
    invariant(
      manifest.permissions.includes(permission),
      `Extension manifest is missing required permission: ${permission}`,
    );
  }
  invariant(
    manifest.permissions.length === EXTENSION_REQUIRED_PERMISSIONS.length,
    "Extension manifest permissions contain an unexpected permission",
  );
  invariant(
    Array.isArray(manifest.host_permissions) &&
      manifest.host_permissions.includes("<all_urls>"),
    "Extension manifest host_permissions must include <all_urls>",
  );

  const requiredPaths = new Set([
    requireStringPath(
      manifest.background?.service_worker,
      "Extension background.service_worker",
    ),
    requireStringPath(
      manifest.action?.default_popup,
      "Extension action.default_popup",
    ),
    requireStringPath(manifest.options_ui?.page, "Extension options_ui.page"),
    requireStringPath(
      manifest.side_panel?.default_path,
      "Extension side_panel.default_path",
    ),
  ]);
  invariant(
    isRecord(manifest.icons) && Object.keys(manifest.icons).length > 0,
    "Extension manifest icons are required",
  );
  for (const [size, iconPath] of Object.entries(manifest.icons)) {
    invariant(
      /^\d+$/.test(size),
      `Extension manifest icon size is invalid: ${size}`,
    );
    requiredPaths.add(requireStringPath(iconPath, `Extension icon ${size}`));
  }
  invariant(
    typeof manifest.default_locale === "string" &&
      /^[A-Za-z0-9_]+$/.test(manifest.default_locale),
    "Extension manifest default_locale is invalid",
  );
  requiredPaths.add(`_locales/${manifest.default_locale}/messages.json`);
  invariant(
    Array.isArray(manifest.content_scripts) &&
      manifest.content_scripts.length > 0,
    "Extension manifest content_scripts are required",
  );
  for (const [index, contentScript] of manifest.content_scripts.entries()) {
    invariant(
      isRecord(contentScript),
      `Extension content_scripts[${index}] must be an object`,
    );
    invariant(
      Array.isArray(contentScript.js) && contentScript.js.length > 0,
      `Extension content_scripts[${index}].js must be non-empty`,
    );
    for (const scriptPath of contentScript.js) {
      requiredPaths.add(
        requireStringPath(scriptPath, `Extension content_scripts[${index}].js`),
      );
    }
    if (contentScript.css !== undefined) {
      invariant(
        Array.isArray(contentScript.css),
        `Extension content_scripts[${index}].css must be an array`,
      );
      for (const stylePath of contentScript.css) {
        requiredPaths.add(
          requireStringPath(
            stylePath,
            `Extension content_scripts[${index}].css`,
          ),
        );
      }
    }
  }
  for (const path of requiredPaths) {
    requireNonemptyArchiveFile(zipEntries, path, "extension zip");
  }
}

async function requireBuildDirectory(path) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Extension build directory is required for ZIP-to-build verification but was not found: ${path}`,
      );
    }
    throw error;
  }
  invariant(
    stats.isDirectory(),
    `Extension build path must be a directory: ${path}`,
  );
}

async function verifyExtensionBuildMatchesZip({
  rootDir,
  extensionBuildDir,
  zipEntries,
}) {
  const buildRoot = resolve(
    rootDir,
    extensionBuildDir ?? DEFAULT_EXTENSION_BUILD_DIR,
  );
  await requireBuildDirectory(buildRoot);

  const buildFiles = await listFiles(buildRoot);
  const zipFiles = [...zipEntries.values()]
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.name)
    .sort();
  invariant(
    isDeepStrictEqual(zipFiles, buildFiles),
    `Extension ZIP file list does not match build directory. Expected ${buildFiles.join(", ")}; received ${zipFiles.join(", ")}`,
  );
  let totalBytes = 0;
  for (const path of buildFiles) {
    const buildBytes = await readFile(join(buildRoot, path));
    totalBytes += buildBytes.length;
    invariant(
      Number.isSafeInteger(totalBytes) && totalBytes <= MAX_ARCHIVE_BYTES,
      `Extension build directory exceeds the ${MAX_ARCHIVE_BYTES}-byte limit`,
    );
    const buildHash = createHash("sha256").update(buildBytes).digest("hex");
    const zipHash = createHash("sha256")
      .update(zipEntries.get(path).bytes)
      .digest("hex");
    invariant(
      zipHash === buildHash,
      `Extension ZIP content does not match build directory: ${path}`,
    );
  }
  return true;
}

async function verifyArtifactLegalFiles({ rootDir, tarEntries, zipEntries }) {
  const [mcpLegal, extensionLegal] = await Promise.all([
    loadReviewedLegalFiles({ rootDir, artifactName: "mcp" }),
    loadReviewedLegalFiles({ rootDir, artifactName: "extension" }),
  ]);
  const requiredFiles = [
    {
      actual: readTarEntry(
        tarEntries,
        mcpLegal.archiveLicense,
        "npm tarball project LICENSE",
      ),
      expected: mcpLegal.license,
      description: "npm tarball project LICENSE",
    },
    {
      actual: readTarEntry(
        tarEntries,
        mcpLegal.archiveNotice,
        "npm tarball THIRD_PARTY_NOTICES.md",
      ),
      expected: mcpLegal.notice,
      description: "npm tarball THIRD_PARTY_NOTICES.md",
    },
    {
      actual: readTarEntry(
        tarEntries,
        mcpLegal.archiveInventory,
        "npm tarball THIRD_PARTY_COMPONENTS.json",
      ),
      expected: mcpLegal.inventory,
      description: "npm tarball THIRD_PARTY_COMPONENTS.json",
    },
    {
      actual: readZipEntry(
        zipEntries,
        extensionLegal.archiveLicense,
        "extension zip project LICENSE",
      ),
      expected: extensionLegal.license,
      description: "extension zip project LICENSE",
    },
    {
      actual: readZipEntry(
        zipEntries,
        extensionLegal.archiveNotice,
        "extension zip THIRD_PARTY_NOTICES.md",
      ),
      expected: extensionLegal.notice,
      description: "extension zip THIRD_PARTY_NOTICES.md",
    },
    {
      actual: readZipEntry(
        zipEntries,
        extensionLegal.archiveInventory,
        "extension zip THIRD_PARTY_COMPONENTS.json",
      ),
      expected: extensionLegal.inventory,
      description: "extension zip THIRD_PARTY_COMPONENTS.json",
    },
    {
      actual: readZipEntry(
        zipEntries,
        extensionLegal.archiveThirdPartyLicenses,
        "extension zip THIRD_PARTY_LICENSES.txt",
      ),
      expected: extensionLegal.thirdPartyLicenses,
      description: "extension zip THIRD_PARTY_LICENSES.txt",
    },
  ];
  for (const { actual, expected, description } of requiredFiles) {
    invariant(
      actual.equals(expected),
      `${description} does not match the reviewed repository source`,
    );
  }
}

function parseChecksumManifest(source) {
  const entries = new Map();
  for (const line of source.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
    invariant(match, `Invalid SHA256SUMS.txt line: ${line}`);
    const path = match[2].replace(/^\.\//, "");
    invariant(!entries.has(path), `Duplicate checksum entry: ${path}`);
    entries.set(path, match[1]);
  }
  return entries;
}

export async function verifyReleaseArtifacts({
  rootDir = process.cwd(),
  artifactsDir,
  extensionBuildDir,
  extensionVerificationMode = EXTENSION_VERIFICATION_BUILD_MATCH,
  tag,
  environment = process.env,
} = {}) {
  invariant(artifactsDir, "artifactsDir is required");
  invariant(
    extensionVerificationMode === EXTENSION_VERIFICATION_BUILD_MATCH ||
      extensionVerificationMode === EXTENSION_VERIFICATION_ARCHIVE_ONLY,
    `extensionVerificationMode must be ${EXTENSION_VERIFICATION_BUILD_MATCH} or ${EXTENSION_VERIFICATION_ARCHIVE_ONLY}`,
  );
  const metadata = await verifyReleaseMetadata({ rootDir, tag, environment });
  const mcpRelativePath = `mcp/webpage-mcp-${metadata.version}.tgz`;
  const extensionRelativePath = `extension/webpage-mcp-connector-${metadata.version}-chrome-extension.zip`;
  const expectedFiles = [
    "SHA256SUMS.txt",
    extensionRelativePath,
    mcpRelativePath,
  ].sort();
  const artifactRoot = resolve(artifactsDir);
  const actualFiles = await listFiles(artifactRoot);
  invariant(
    JSON.stringify(actualFiles) === JSON.stringify(expectedFiles),
    `Release artifact set does not match expectations. Expected ${expectedFiles.join(", ")}; received ${actualFiles.join(", ")}`,
  );

  const mcpPath = join(artifactRoot, mcpRelativePath);
  const extensionPath = join(artifactRoot, extensionRelativePath);
  const mcpArchive = await readBoundedFile(mcpPath, "npm tarball");
  const mcpTar = decompressTarArchive(mcpArchive, "npm tarball");
  const tarEntries = inspectTarArchive(mcpTar, "npm tarball");
  const extensionArchive = await readBoundedFile(
    extensionPath,
    "extension zip",
  );
  const zipEntries = inspectZipArchive(extensionArchive, "extension zip");
  await verifyArtifactLegalFiles({ rootDir, tarEntries, zipEntries });
  const packedPackage = readTarEntryJson(
    tarEntries,
    "package/package.json",
    "npm tarball package/package.json",
  );
  invariant(
    packedPackage.name === "webpage-mcp",
    "npm tarball package name must be webpage-mcp",
  );
  const packedPackageVersion = validateUnifiedReleaseVersion(
    packedPackage.version,
    "npm tarball package version",
  );
  invariant(
    packedPackageVersion === metadata.version,
    `npm tarball version ${packedPackageVersion} does not match release version ${metadata.version}`,
  );
  const [sourcePackage, sourceShrinkwrap] = await Promise.all([
    readJson(
      resolve(rootDir, "app/mcp-server/package.json"),
      "app/mcp-server/package.json",
    ),
    readFile(resolve(rootDir, MCP_NPM_SHRINKWRAP_PATH)),
  ]);
  await verifyPackedMcpPackage({
    packedPackage,
    sourcePackage,
    sourceShrinkwrap,
    bundleComponents: loadMcpBundleComponents(rootDir),
    tarEntries,
  });

  const extensionManifest = readZipEntryJson(
    zipEntries,
    "manifest.json",
    "extension zip manifest.json",
  );
  const packedExtensionVersion = validateUnifiedReleaseVersion(
    extensionManifest.version,
    "Extension manifest version",
  );
  invariant(
    packedExtensionVersion === metadata.version,
    `Extension manifest version ${packedExtensionVersion} does not match release version ${metadata.version}`,
  );
  const packedExtensionPublicKey =
    extensionManifest.key === undefined
      ? undefined
      : validateChromeExtensionPublicKey(extensionManifest.key);
  if (metadata.extensionPublicKey !== undefined) {
    invariant(
      packedExtensionPublicKey === metadata.extensionPublicKey,
      "Extension manifest public key does not match CHROME_EXTENSION_PUBLIC_KEY",
    );
  }
  verifyExtensionManifest({ manifest: extensionManifest, zipEntries });
  const extensionBuildCompared =
    extensionVerificationMode === EXTENSION_VERIFICATION_BUILD_MATCH
      ? await verifyExtensionBuildMatchesZip({
          rootDir,
          extensionBuildDir,
          zipEntries,
        })
      : false;

  const checksumSource = await readFile(
    join(artifactRoot, "SHA256SUMS.txt"),
    "utf8",
  );
  const checksums = parseChecksumManifest(checksumSource);
  const expectedChecksummedFiles = [
    extensionRelativePath,
    mcpRelativePath,
  ].sort();
  invariant(
    JSON.stringify([...checksums.keys()].sort()) ===
      JSON.stringify(expectedChecksummedFiles),
    `Checksum manifest must cover exactly the release archives. Expected ${expectedChecksummedFiles.join(", ")}; received ${[...checksums.keys()].sort().join(", ")}`,
  );
  for (const [path, expectedHash] of checksums) {
    const bytes = path === mcpRelativePath ? mcpArchive : extensionArchive;
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    invariant(actualHash === expectedHash, `SHA-256 mismatch for ${path}`);
  }

  return {
    ...metadata,
    artifactsDir: artifactRoot,
    files: actualFiles,
    extensionVerificationMode,
    extensionBuildCompared,
  };
}

function parseCliArguments(argv) {
  const [command, ...args] = argv;
  invariant(
    command === "metadata" ||
      command === "artifacts" ||
      command === "npm-publish",
    RELEASE_PREFLIGHT_USAGE,
  );
  let artifactsDir;
  let tag;
  let ref;
  let extensionVerificationMode;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--tag") {
      invariant(index + 1 < args.length, "--tag requires a value");
      tag = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--ref") {
      invariant(index + 1 < args.length, "--ref requires a value");
      ref = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--require-build-match" || argument === "--archive-only") {
      invariant(
        command === "artifacts",
        `${argument} is supported only by the artifacts command`,
      );
      invariant(
        extensionVerificationMode === undefined,
        "Extension verification mode may be specified only once",
      );
      extensionVerificationMode =
        argument === "--require-build-match"
          ? EXTENSION_VERIFICATION_BUILD_MATCH
          : EXTENSION_VERIFICATION_ARCHIVE_ONLY;
      continue;
    }
    invariant(
      command === "artifacts" && !artifactsDir && !argument.startsWith("--"),
      `Unexpected argument: ${argument}`,
    );
    artifactsDir = argument;
  }
  invariant(
    command !== "artifacts" || artifactsDir,
    "artifacts command requires an artifacts directory",
  );
  invariant(
    command !== "npm-publish" || ref,
    "npm-publish command requires --ref",
  );
  invariant(
    command === "npm-publish" || ref === undefined,
    "--ref is supported only by the npm-publish command",
  );
  invariant(
    command !== "npm-publish" || tag === undefined,
    "--tag is not supported by the npm-publish command; use --ref",
  );
  return {
    command,
    artifactsDir,
    tag,
    ref,
    extensionVerificationMode:
      extensionVerificationMode ?? EXTENSION_VERIFICATION_BUILD_MATCH,
  };
}

async function main() {
  const { command, artifactsDir, tag, ref, extensionVerificationMode } =
    parseCliArguments(process.argv.slice(2));
  const result =
    command === "metadata"
      ? await verifyReleaseMetadata({ tag })
      : command === "artifacts"
        ? await verifyReleaseArtifacts({
            artifactsDir,
            tag,
            extensionVerificationMode,
          })
        : await verifyNpmPublishRef({ ref });
  console.log(
    command === "metadata"
      ? `Release metadata verified for version ${result.version}.`
      : command === "artifacts"
        ? result.extensionBuildCompared
          ? `Release metadata and artifacts verified for version ${result.version}, including extension ZIP-to-build byte comparison.`
          : `Release metadata and archived payloads verified for version ${result.version}; extension ZIP-to-build comparison was explicitly skipped.`
        : `npm publish ref verified for version ${result.version}.`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(`Release preflight failed: ${error.message}`);
    process.exitCode = 1;
  });
}
