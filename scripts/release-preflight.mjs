import console from "node:console";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

function readArchiveJson(command, args, description) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_ARCHIVE_METADATA_BYTES,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `Unable to inspect ${description} with ${command}: ${result.error.message}`,
    );
  }
  invariant(
    result.status === 0,
    `Unable to inspect ${description}: ${result.stderr.trim() || `${command} exited with status ${result.status}`}`,
  );
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Invalid embedded JSON in ${description}: ${error.message}`,
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
  const packedPackage = readArchiveJson(
    "tar",
    ["-xOf", mcpPath, "package/package.json"],
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

  const extensionManifest = readArchiveJson(
    "unzip",
    ["-p", extensionPath, "manifest.json"],
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
