import { Buffer } from "node:buffer";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

import {
  CargoDenyInstallerError,
  downloadVerifiedArchive,
  extractVerifiedBinary,
  probeVerifiedBinary,
  verifyCachedBinary,
} from "./install-cargo-deny.mjs";

const TOOL_SPEC_URL = new URL("./wasm-pack-tool.json", import.meta.url);
const MAX_PATH_BYTES = 4095;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export class WasmPackInstallerError extends Error {
  constructor(message) {
    super(`[install-wasm-pack] ${message}`);
    this.name = "WasmPackInstallerError";
  }
}

function fail(message) {
  throw new WasmPackInstallerError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, description) {
  if (!isRecord(value)) fail(`${description} must be an object`);
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(`${description} keys must be exactly ${expected.join(", ")}`);
  }
}

function assertPositiveInteger(value, description) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${description} must be a positive safe integer`);
  }
}

function assertAbsoluteSafePath(value, description) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${description} must be a bounded absolute path without controls`);
  }
  return value;
}

function validateToolSpec(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "name",
      "version",
      "platform",
      "arch",
      "archive",
      "binary",
    ],
    "tool specification",
  );
  if (value.schemaVersion !== 1) fail("unsupported tool specification schema");
  if (value.name !== "wasm-pack") fail("tool name must be wasm-pack");
  if (!VERSION_PATTERN.test(value.version)) fail("tool version is invalid");
  if (value.platform !== "linux" || value.arch !== "x64") {
    fail("tool specification must target Linux x64");
  }

  assertExactKeys(
    value.archive,
    ["url", "size", "sha256"],
    "archive specification",
  );
  const expectedArchiveUrl =
    `https://github.com/wasm-bindgen/wasm-pack/releases/download/v${value.version}/` +
    `wasm-pack-v${value.version}-x86_64-unknown-linux-musl.tar.gz`;
  if (value.archive.url !== expectedArchiveUrl) {
    fail("archive URL does not match the pinned wasm-pack release");
  }
  assertPositiveInteger(value.archive.size, "archive size");
  if (!SHA256_PATTERN.test(value.archive.sha256))
    fail("archive SHA-256 is invalid");

  assertExactKeys(
    value.binary,
    ["entry", "filename", "size", "sha256", "versionOutput", "mode"],
    "binary specification",
  );
  if (
    value.binary.entry !==
    `wasm-pack-v${value.version}-x86_64-unknown-linux-musl/wasm-pack`
  ) {
    fail("binary archive entry does not match the pinned release");
  }
  if (value.binary.filename !== "wasm-pack")
    fail("binary filename must be wasm-pack");
  assertPositiveInteger(value.binary.size, "binary size");
  if (!SHA256_PATTERN.test(value.binary.sha256))
    fail("binary SHA-256 is invalid");
  if (value.binary.versionOutput !== `wasm-pack ${value.version}`) {
    fail("binary version output does not match the pinned release");
  }
  if (value.binary.mode !== "0755") fail("binary mode must be 0755");
  return value;
}

function deepFreeze(value) {
  if (isRecord(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

let parsedToolSpec;
try {
  parsedToolSpec = validateToolSpec(
    JSON.parse(await readFile(TOOL_SPEC_URL, "utf8")),
  );
} catch (error) {
  if (error instanceof WasmPackInstallerError) throw error;
  fail("tool specification could not be loaded; details withheld");
}

export const WASM_PACK_TOOL = deepFreeze(parsedToolSpec);

export function assertSupportedWasmPackPlatform(
  platform = process.platform,
  architecture = process.arch,
) {
  if (
    platform !== WASM_PACK_TOOL.platform ||
    architecture !== WASM_PACK_TOOL.arch
  ) {
    fail(
      `unsupported platform ${platform}/${architecture}; expected ${WASM_PACK_TOOL.platform}/${WASM_PACK_TOOL.arch}`,
    );
  }
}

function translateSharedInstallerError(error) {
  if (!(error instanceof CargoDenyInstallerError)) return error;
  return new WasmPackInstallerError(
    error.message.replace(/^\[install-cargo-deny\]\s*/, ""),
  );
}

const downloadWasmPackArchive = (archive, destination) =>
  downloadVerifiedArchive(archive, destination, { toolLabel: "wasm-pack" });
const extractWasmPackBinary = (archivePath, binary, destination) =>
  extractVerifiedBinary(archivePath, binary, destination, {
    toolLabel: "wasm-pack",
  });
const verifyWasmPackBinary = (target, binary) =>
  verifyCachedBinary(target, binary, { toolLabel: "wasm-pack" });
const probeWasmPackBinary = (target, binary) =>
  probeVerifiedBinary(target, binary, { toolLabel: "wasm-pack" });

export async function installWasmPack(
  installDirectory,
  {
    platform = process.platform,
    architecture = process.arch,
    downloadArchive = downloadWasmPackArchive,
    extractBinary = extractWasmPackBinary,
    verifyBinary = verifyWasmPackBinary,
    probeBinary = probeWasmPackBinary,
  } = {},
) {
  assertSupportedWasmPackPlatform(platform, architecture);
  assertAbsoluteSafePath(installDirectory, "--install-dir");
  const normalizedDirectory = resolve(installDirectory);
  assertAbsoluteSafePath(normalizedDirectory, "normalized install directory");
  await mkdir(normalizedDirectory, { mode: 0o755, recursive: true });
  const directoryMetadata = await lstat(normalizedDirectory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    fail("install directory must be a real directory, not a symlink");
  }
  if ((await realpath(normalizedDirectory)) !== normalizedDirectory) {
    fail("install directory must not resolve through a symlink");
  }

  const target = join(normalizedDirectory, WASM_PACK_TOOL.binary.filename);
  assertAbsoluteSafePath(target, "wasm-pack install target");
  try {
    if (await verifyBinary(target, WASM_PACK_TOOL.binary)) {
      probeBinary(target, WASM_PACK_TOOL.binary);
      return target;
    }

    const stagingDirectory = await mkdtemp(
      join(normalizedDirectory, ".wasm-pack-install-"),
    );
    try {
      const archivePath = join(stagingDirectory, "wasm-pack.tar.gz");
      const stagedBinary = join(stagingDirectory, "wasm-pack");
      await downloadArchive(WASM_PACK_TOOL.archive, archivePath);
      await extractBinary(archivePath, WASM_PACK_TOOL.binary, stagedBinary);
      if (!(await verifyBinary(stagedBinary, WASM_PACK_TOOL.binary))) {
        fail("staged wasm-pack binary failed final verification");
      }
      await rename(stagedBinary, target);
      if (!(await verifyBinary(target, WASM_PACK_TOOL.binary))) {
        fail("installed wasm-pack binary failed final verification");
      }
      probeBinary(target, WASM_PACK_TOOL.binary);
      return target;
    } finally {
      await rm(stagingDirectory, { force: true, recursive: true });
    }
  } catch (error) {
    throw translateSharedInstallerError(error);
  }
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--install-dir") {
    fail(
      "usage: node scripts/install-wasm-pack.mjs --install-dir <absolute-path>",
    );
  }
  return argv[1];
}

async function main() {
  const target = await installWasmPack(parseArguments(process.argv.slice(2)));
  process.stdout.write(`Verified wasm-pack installed at ${target}\n`);
}

export function formatWasmPackInstallerError(error) {
  return error instanceof WasmPackInstallerError
    ? error.message
    : "[install-wasm-pack] installation failed; details withheld";
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${formatWasmPackInstallerError(error)}\n`);
    process.exitCode = 1;
  });
}
