import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL, URL } from "node:url";

const TOOL_SPEC_URL = new URL("./cargo-deny-tool.json", import.meta.url);
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 2;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 4095;
const SYSTEM_TAR = "/usr/bin/tar";
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const FIXED_CHILD_ENV = Object.freeze({
  HOME: "/tmp",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
});

export class CargoDenyInstallerError extends Error {
  constructor(message) {
    super(`[install-cargo-deny] ${message}`);
    this.name = "CargoDenyInstallerError";
  }
}

function fail(message) {
  throw new CargoDenyInstallerError(message);
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

function assertString(value, description) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    fail(`${description} must be a non-empty bounded string`);
  }
  return value;
}

function assertPositiveInteger(value, description) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${description} must be a positive safe integer`);
  }
  return value;
}

function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertAbsoluteSafePath(value, description) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    hasControlCharacters(value)
  ) {
    fail(`${description} must be a bounded absolute path without controls`);
  }
  return value;
}

function validateDownloadUrl(value, description) {
  const source = assertString(value, description);
  let url;
  try {
    url = new URL(source);
  } catch {
    fail(`${description} must be an HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash ||
    !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)
  ) {
    fail(`${description} is outside the fixed HTTPS download policy`);
  }
  return url;
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
      "rustToolchain",
      "archive",
      "binary",
    ],
    "tool specification",
  );
  if (value.schemaVersion !== 1) fail("unsupported tool specification schema");
  if (value.name !== "cargo-deny") fail("tool name must be cargo-deny");
  if (!VERSION_PATTERN.test(value.version)) fail("tool version is invalid");
  if (value.platform !== "linux" || value.arch !== "x64") {
    fail("tool specification must target Linux x64");
  }
  if (!VERSION_PATTERN.test(value.rustToolchain)) {
    fail("Rust toolchain version is invalid");
  }

  assertExactKeys(
    value.archive,
    ["url", "size", "sha256"],
    "archive specification",
  );
  validateDownloadUrl(value.archive.url, "archive URL");
  const expectedArchiveUrl =
    `https://github.com/EmbarkStudios/cargo-deny/releases/download/${value.version}/` +
    `cargo-deny-${value.version}-x86_64-unknown-linux-musl.tar.gz`;
  if (value.archive.url !== expectedArchiveUrl) {
    fail("archive URL does not match the pinned cargo-deny release");
  }
  assertPositiveInteger(value.archive.size, "archive size");
  if (!SHA256_PATTERN.test(value.archive.sha256)) {
    fail("archive SHA-256 is invalid");
  }

  assertExactKeys(
    value.binary,
    ["entry", "filename", "size", "sha256", "versionOutput", "mode"],
    "binary specification",
  );
  if (
    value.binary.entry !==
    `cargo-deny-${value.version}-x86_64-unknown-linux-musl/cargo-deny`
  ) {
    fail("binary archive entry does not match the pinned release");
  }
  if (value.binary.filename !== "cargo-deny") {
    fail("binary filename must be cargo-deny");
  }
  assertPositiveInteger(value.binary.size, "binary size");
  if (!SHA256_PATTERN.test(value.binary.sha256)) {
    fail("binary SHA-256 is invalid");
  }
  if (value.binary.versionOutput !== `cargo-deny ${value.version}`) {
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
  if (error instanceof CargoDenyInstallerError) throw error;
  fail("tool specification could not be loaded; details withheld");
}
export const CARGO_DENY_TOOL = deepFreeze(parsedToolSpec);

export function assertSupportedPlatform(
  platform = process.platform,
  architecture = process.arch,
) {
  if (
    platform !== CARGO_DENY_TOOL.platform ||
    architecture !== CARGO_DENY_TOOL.arch
  ) {
    fail(
      `unsupported platform ${platform}/${architecture}; expected ${CARGO_DENY_TOOL.platform}/${CARGO_DENY_TOOL.arch}`,
    );
  }
}

async function writeChunk(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0)
      fail("failed to make progress writing verified data");
    offset += bytesWritten;
  }
}

async function readStreamChunk(reader, idleTimeoutMs, controller) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("stream idle timeout"));
        }, idleTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function validateTimeout(value, maximum, description) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(`${description} is outside the allowed range`);
  }
  return value;
}

export async function downloadVerifiedArchive(
  archive,
  destination,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    idleTimeoutMs = DOWNLOAD_IDLE_TIMEOUT_MS,
  } = {},
) {
  assertExactKeys(archive, ["url", "size", "sha256"], "archive specification");
  const initialUrl = validateDownloadUrl(archive.url, "archive URL");
  const expectedSize = assertPositiveInteger(archive.size, "archive size");
  if (!SHA256_PATTERN.test(archive.sha256)) fail("archive SHA-256 is invalid");
  assertAbsoluteSafePath(destination, "archive destination");
  validateTimeout(timeoutMs, DOWNLOAD_TIMEOUT_MS, "download timeout");
  validateTimeout(
    idleTimeoutMs,
    DOWNLOAD_IDLE_TIMEOUT_MS,
    "download idle timeout",
  );

  const controller = new globalThis.AbortController();
  const totalTimer = setTimeout(() => controller.abort(), timeoutMs);
  let currentUrl = initialUrl;
  let response;
  try {
    for (
      let redirectCount = 0;
      redirectCount <= MAX_REDIRECTS;
      redirectCount += 1
    ) {
      response = await fetchImpl(currentUrl, {
        headers: Object.freeze({
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
          "User-Agent": "webpage-mcp-cargo-deny-installer/1",
        }),
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        if (redirectCount === MAX_REDIRECTS) {
          fail("cargo-deny download exceeded the redirect limit");
        }
        const location = response.headers.get("location");
        if (!location) fail("cargo-deny download redirect omitted Location");
        const redirected = validateDownloadUrl(
          new URL(location, currentUrl).href,
          "redirect URL",
        );
        if (
          currentUrl.hostname === "github.com" &&
          redirected.hostname !== "release-assets.githubusercontent.com"
        ) {
          fail(
            "cargo-deny download redirect did not target GitHub release assets",
          );
        }
        if (
          currentUrl.hostname === "release-assets.githubusercontent.com" &&
          redirected.hostname !== currentUrl.hostname
        ) {
          fail("cargo-deny release asset redirected outside its fixed host");
        }
        currentUrl = redirected;
        continue;
      }
      break;
    }

    if (!response || response.status !== 200 || !response.body) {
      await response?.body?.cancel().catch(() => {});
      fail(
        `cargo-deny download returned HTTP ${response?.status ?? "unknown"}`,
      );
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      if (
        !/^\d+$/.test(contentLength) ||
        Number(contentLength) !== expectedSize
      ) {
        await response.body.cancel().catch(() => {});
        fail("cargo-deny archive Content-Length does not match the pin");
      }
    }

    const handle = await open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    const digest = createHash("sha256");
    let totalBytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await readStreamChunk(
          reader,
          idleTimeoutMs,
          controller,
        );
        if (done) break;
        const bytes = Buffer.from(value);
        if (totalBytes + bytes.length > expectedSize) {
          fail("cargo-deny archive exceeded its pinned size");
        }
        await writeChunk(handle, bytes, totalBytes);
        digest.update(bytes);
        totalBytes += bytes.length;
      }
      if (totalBytes !== expectedSize) {
        fail("cargo-deny archive size does not match the pin");
      }
      if (controller.signal.aborted) {
        fail("cargo-deny archive download exceeded its timeout");
      }
      if (digest.digest("hex") !== archive.sha256) {
        fail("cargo-deny archive SHA-256 does not match the pin");
      }
      await handle.sync();
    } finally {
      await reader.cancel().catch(() => {});
      await handle.close();
    }
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    if (controller.signal.aborted) {
      fail("cargo-deny archive download timed out or exceeded its bounds");
    }
    throw error;
  } finally {
    clearTimeout(totalTimer);
  }
}

async function collectBoundedDiagnostics(stream) {
  let bytes = 0;
  let truncated = false;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_DIAGNOSTIC_BYTES) truncated = true;
  }
  return { bytes, truncated };
}

function childExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
}

export async function extractVerifiedBinary(
  archivePath,
  binary,
  destination,
  { spawnImpl = spawn, timeoutMs = EXTRACT_TIMEOUT_MS } = {},
) {
  assertAbsoluteSafePath(archivePath, "archive path");
  assertAbsoluteSafePath(destination, "binary destination");
  assertExactKeys(
    binary,
    ["entry", "filename", "size", "sha256", "versionOutput", "mode"],
    "binary specification",
  );
  assertString(binary.entry, "binary archive entry");
  const expectedSize = assertPositiveInteger(binary.size, "binary size");
  if (!SHA256_PATTERN.test(binary.sha256)) fail("binary SHA-256 is invalid");
  if (binary.mode !== "0755") fail("binary mode must be 0755");
  validateTimeout(timeoutMs, EXTRACT_TIMEOUT_MS, "extraction timeout");

  const handle = await open(
    destination,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  let child;
  let timer;
  try {
    child = spawnImpl(SYSTEM_TAR, ["-xOzf", archivePath, "--", binary.entry], {
      env: FIXED_CHILD_ENV,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitPromise = childExit(child);
    const diagnosticsPromise = collectBoundedDiagnostics(child.stderr);
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The outer timeout/result handling still fails closed.
      }
    }, timeoutMs);
    const digest = createHash("sha256");
    let totalBytes = 0;
    let streamError;
    try {
      for await (const chunk of child.stdout) {
        const bytes = Buffer.from(chunk);
        if (totalBytes + bytes.length > expectedSize) {
          child.kill("SIGKILL");
          fail("extracted cargo-deny binary exceeded its pinned size");
        }
        await writeChunk(handle, bytes, totalBytes);
        digest.update(bytes);
        totalBytes += bytes.length;
      }
    } catch (error) {
      streamError = error;
      child.kill("SIGKILL");
    }
    const [{ code, signal }, diagnostics] = await Promise.all([
      exitPromise,
      diagnosticsPromise,
    ]);
    if (timedOut) fail("cargo-deny extraction timed out");
    if (streamError) throw streamError;
    if (code !== 0) {
      fail(
        `cargo-deny extraction failed with ${signal ? `signal ${signal}` : `exit code ${code}`}; stderr captured ${diagnostics.bytes} bytes${diagnostics.truncated ? "; output limit reached" : ""}; contents withheld`,
      );
    }
    if (totalBytes !== expectedSize) {
      fail("extracted cargo-deny binary size does not match the pin");
    }
    if (digest.digest("hex") !== binary.sha256) {
      fail("extracted cargo-deny binary SHA-256 does not match the pin");
    }
    await handle.chmod(0o755);
    await handle.sync();
  } finally {
    clearTimeout(timer);
    try {
      child?.kill("SIGKILL");
    } catch {
      // Closing the staged output must not be skipped by a native kill error.
    }
    await handle.close();
  }
}

async function hashOpenFile(handle) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest("hex");
}

export async function verifyCachedBinary(target, binary) {
  assertAbsoluteSafePath(target, "cached binary path");
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (metadata.isSymbolicLink())
    fail("cached cargo-deny must not be a symlink");
  if (!metadata.isFile()) fail("cached cargo-deny must be a regular file");
  const handle = await open(
    target,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      fail("cached cargo-deny changed while it was being verified");
    }
    if (openedMetadata.size !== binary.size) {
      return false;
    }
    if ((openedMetadata.mode & 0o7777) !== 0o755) return false;
    const digest = await hashOpenFile(handle);
    const finalMetadata = await handle.stat();
    if (
      !finalMetadata.isFile() ||
      finalMetadata.dev !== openedMetadata.dev ||
      finalMetadata.ino !== openedMetadata.ino ||
      finalMetadata.size !== openedMetadata.size ||
      finalMetadata.size !== binary.size ||
      finalMetadata.mode !== openedMetadata.mode ||
      (finalMetadata.mode & 0o7777) !== 0o755
    ) {
      fail("cached cargo-deny changed while it was being hashed");
    }
    return digest === binary.sha256;
  } finally {
    await handle.close();
  }
}

export function probeCargoDeny(
  binaryPath,
  binary = CARGO_DENY_TOOL.binary,
  { spawnSyncImpl = spawnSync, timeoutMs = VERSION_TIMEOUT_MS } = {},
) {
  assertAbsoluteSafePath(binaryPath, "cargo-deny probe path");
  validateTimeout(timeoutMs, VERSION_TIMEOUT_MS, "version probe timeout");
  const result = spawnSyncImpl(binaryPath, ["--version"], {
    encoding: "utf8",
    env: FIXED_CHILD_ENV,
    maxBuffer: MAX_DIAGNOSTIC_BYTES,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    result.stdout.trim() !== binary.versionOutput
  ) {
    const stderrBytes = Buffer.byteLength(result.stderr ?? "", "utf8");
    fail(
      `cargo-deny version probe failed; stderr captured ${stderrBytes} bytes; contents withheld`,
    );
  }
}

export async function installCargoDeny(installDirectory) {
  assertSupportedPlatform();
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

  const target = join(normalizedDirectory, CARGO_DENY_TOOL.binary.filename);
  assertAbsoluteSafePath(target, "cargo-deny install target");
  if (await verifyCachedBinary(target, CARGO_DENY_TOOL.binary)) {
    probeCargoDeny(target);
    return target;
  }

  const stagingDirectory = await mkdtemp(
    join(normalizedDirectory, ".cargo-deny-install-"),
  );
  try {
    const archivePath = join(stagingDirectory, "cargo-deny.tar.gz");
    const stagedBinary = join(stagingDirectory, "cargo-deny");
    await downloadVerifiedArchive(CARGO_DENY_TOOL.archive, archivePath);
    await extractVerifiedBinary(
      archivePath,
      CARGO_DENY_TOOL.binary,
      stagedBinary,
    );
    if (!(await verifyCachedBinary(stagedBinary, CARGO_DENY_TOOL.binary))) {
      fail("staged cargo-deny binary failed final verification");
    }
    await rename(stagedBinary, target);
    if (!(await verifyCachedBinary(target, CARGO_DENY_TOOL.binary))) {
      fail("installed cargo-deny binary failed final verification");
    }
    probeCargoDeny(target);
    return target;
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--install-dir") {
    fail(
      "usage: node scripts/install-cargo-deny.mjs --install-dir <absolute-path>",
    );
  }
  return argv[1];
}

async function main() {
  const target = await installCargoDeny(parseArguments(process.argv.slice(2)));
  process.stdout.write(`Verified cargo-deny installed at ${target}\n`);
}

export function formatInstallerError(error) {
  return error instanceof CargoDenyInstallerError
    ? error.message
    : "[install-cargo-deny] installation failed; details withheld";
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${formatInstallerError(error)}\n`);
    process.exitCode = 1;
  });
}
