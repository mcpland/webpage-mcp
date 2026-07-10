import console from "node:console";
import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_METADATA_BYTES = 1024 * 1024;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  invariant(
    SEMVER_PATTERN.test(version),
    `Release tag must contain a valid semantic version, received: ${tag}`,
  );
  return version;
}

export async function verifyReleaseMetadata({
  rootDir = process.cwd(),
  tag,
} = {}) {
  const tagVersion = normalizeReleaseTag(tag);
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
    invariant(
      typeof pkg.version === "string" && SEMVER_PATTERN.test(pkg.version),
      `${releasePackage.path} must contain a valid semantic version, received: ${String(pkg.version)}`,
    );
    packages.push({ ...releasePackage, version: pkg.version });
  }

  const expectedVersion = packages[0].version;
  for (const pkg of packages.slice(1)) {
    invariant(
      pkg.version === expectedVersion,
      `Release package versions must match: ${packages[0].path}=${expectedVersion}, ${pkg.path}=${pkg.version}`,
    );
  }
  if (tagVersion !== undefined) {
    invariant(
      tagVersion === expectedVersion,
      `Release tag version ${tagVersion} does not match package version ${expectedVersion}`,
    );
  }

  return { version: expectedVersion, tagVersion, packages };
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

function readTarEntryJson(archive, entryName, description) {
  let tar;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES });
  } catch (error) {
    throw new Error(`Unable to inspect ${description}: ${error.message}`);
  }

  let found;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const readField = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "")
        .trim();
    const name = readField(0, 100);
    const prefix = readField(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const checksumField = readField(148, 8);
    invariant(
      /^[0-7]+$/.test(checksumField),
      `Invalid tar header checksum in ${description}`,
    );
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    invariant(
      checksum === Number.parseInt(checksumField, 8),
      `Tar header checksum mismatch in ${description}: ${fullName}`,
    );
    const sizeField = readField(124, 12);
    invariant(
      /^[0-7]+$/.test(sizeField),
      `Invalid tar entry size in ${description}: ${sizeField}`,
    );
    const size = Number.parseInt(sizeField, 8);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    invariant(
      Number.isSafeInteger(size) && dataEnd <= tar.length,
      `Truncated tar entry in ${description}: ${fullName}`,
    );

    if (fullName === entryName) {
      invariant(!found, `Duplicate ${entryName} in ${description}`);
      found = Buffer.from(tar.subarray(dataStart, dataEnd));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  invariant(found, `Missing ${entryName} in ${description}`);
  return parseArchiveJson(found, description);
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

function readZipEntryJson(archive, entryName, description) {
  const eocdOffset = findZipEndOfCentralDirectory(archive, description);
  invariant(
    archive.readUInt16LE(eocdOffset + 4) === 0 &&
      archive.readUInt16LE(eocdOffset + 6) === 0,
    `${description} may not be a multi-disk ZIP archive`,
  );
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  invariant(
    entryCount !== 0xffff &&
      centralSize !== 0xffffffff &&
      centralOffset !== 0xffffffff &&
      centralOffset + centralSize <= eocdOffset,
    `${description} uses unsupported ZIP64 or invalid directory metadata`,
  );

  let offset = centralOffset;
  let found;
  for (let index = 0; index < entryCount; index += 1) {
    invariant(
      offset + 46 <= archive.length && archive.readUInt32LE(offset) === 0x02014b50,
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
    const localOffset = archive.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    invariant(nextOffset <= archive.length, `Truncated ZIP directory in ${description}`);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    if (name === entryName) {
      invariant(!found, `Duplicate ${entryName} in ${description}`);
      invariant((flags & 0x1) === 0, `${description} may not contain encrypted metadata`);
      invariant(
        compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff &&
        uncompressedSize > 0 && uncompressedSize <= MAX_ARCHIVE_METADATA_BYTES,
        `${description} metadata exceeds the ${MAX_ARCHIVE_METADATA_BYTES}-byte limit`,
      );
      invariant(
        localOffset + 30 <= archive.length && archive.readUInt32LE(localOffset) === 0x04034b50,
        `Invalid local ZIP header for ${entryName}`,
      );
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const localFlags = archive.readUInt16LE(localOffset + 6);
      const localMethod = archive.readUInt16LE(localOffset + 8);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      invariant(dataEnd <= archive.length, `Truncated ZIP entry for ${entryName}`);
      invariant(
        localFlags === flags && localMethod === method,
        `ZIP directory disagrees with local header for ${entryName}`,
      );
      invariant(
        archive
          .subarray(localOffset + 30, localOffset + 30 + localNameLength)
          .equals(Buffer.from(entryName)),
        `ZIP local header name mismatch for ${entryName}`,
      );
      const compressed = archive.subarray(dataStart, dataEnd);
      if (method === 0) {
        found = Buffer.from(compressed);
      } else if (method === 8) {
        try {
          found = inflateRawSync(compressed, {
            maxOutputLength: MAX_ARCHIVE_METADATA_BYTES,
          });
        } catch (error) {
          throw new Error(`Unable to inspect ${description}: ${error.message}`);
        }
      } else {
        throw new Error(`Unsupported ZIP compression method ${method} in ${description}`);
      }
      invariant(
        found.length === uncompressedSize,
        `ZIP entry size mismatch for ${entryName} in ${description}`,
      );
      invariant(
        crc32(found) === expectedCrc,
        `ZIP entry CRC mismatch for ${entryName} in ${description}`,
      );
    }

    offset = nextOffset;
  }

  invariant(
    offset === centralOffset + centralSize,
    `ZIP directory size mismatch in ${description}`,
  );

  invariant(found, `Missing ${entryName} in ${description}`);
  return parseArchiveJson(found, description);
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
  tag,
} = {}) {
  invariant(artifactsDir, "artifactsDir is required");
  const metadata = await verifyReleaseMetadata({ rootDir, tag });
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
  const extensionArchive = await readBoundedFile(
    extensionPath,
    "extension zip",
  );
  const packedPackage = readTarEntryJson(
    mcpArchive,
    "package/package.json",
    "npm tarball package/package.json",
  );
  invariant(
    packedPackage.name === "webpage-mcp",
    "npm tarball package name must be webpage-mcp",
  );
  invariant(
    packedPackage.version === metadata.version,
    `npm tarball version ${String(packedPackage.version)} does not match release version ${metadata.version}`,
  );

  const extensionManifest = readZipEntryJson(
    extensionArchive,
    "manifest.json",
    "extension zip manifest.json",
  );
  invariant(
    extensionManifest.version === metadata.version,
    `Extension manifest version ${String(extensionManifest.version)} does not match release version ${metadata.version}`,
  );

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

  return { ...metadata, artifactsDir: artifactRoot, files: actualFiles };
}

function parseCliArguments(argv) {
  const [command, ...args] = argv;
  invariant(
    command === "metadata" || command === "artifacts",
    "Usage: release-preflight.mjs <metadata|artifacts> [artifacts-dir] [--tag <vX.Y.Z>]",
  );
  let artifactsDir;
  let tag;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--tag") {
      invariant(index + 1 < args.length, "--tag requires a value");
      tag = args[index + 1];
      index += 1;
      continue;
    }
    invariant(
      command === "artifacts" && !artifactsDir,
      `Unexpected argument: ${argument}`,
    );
    artifactsDir = argument;
  }
  invariant(
    command !== "artifacts" || artifactsDir,
    "artifacts command requires an artifacts directory",
  );
  return { command, artifactsDir, tag };
}

async function main() {
  const { command, artifactsDir, tag } = parseCliArguments(
    process.argv.slice(2),
  );
  const result =
    command === "metadata"
      ? await verifyReleaseMetadata({ tag })
      : await verifyReleaseArtifacts({ artifactsDir, tag });
  console.log(
    command === "metadata"
      ? `Release metadata verified for version ${result.version}.`
      : `Release metadata and artifacts verified for version ${result.version}.`,
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
