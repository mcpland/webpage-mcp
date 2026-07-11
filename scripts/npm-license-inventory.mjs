import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { gunzipSync } from "node:zlib";

export const NPM_INVENTORY_ARTIFACTS = Object.freeze({
  mcp: Object.freeze({
    rootPackage: "webpage-mcp",
    importer: "app/mcp-server",
    inventorySource: "app/mcp-server/THIRD_PARTY_COMPONENTS.json",
    archiveInventory: "package/THIRD_PARTY_COMPONENTS.json",
  }),
  extension: Object.freeze({
    rootPackage: "webpage-mcp-connector",
    importer: "app/chrome-extension",
    inventorySource: "app/chrome-extension/public/THIRD_PARTY_COMPONENTS.json",
    archiveInventory: "THIRD_PARTY_COMPONENTS.json",
  }),
});

export const INVENTORY_SCHEMA_VERSION = 1;
export const INVENTORY_SCOPE = "pnpm-production-closure";

const FIRST_PARTY_WORKSPACE_PACKAGES = new Set(["webpage-mcp-shared"]);
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_BYTES_PER_PACKAGE = 8 * 1024 * 1024;
const MAX_RETAINED_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_COMPONENTS = 4096;
const MAX_GRAPH_NODES = 100_000;
const MAX_GRAPH_DEPTH = 512;
const MAX_EVIDENCE_FILES = 32;
const MAX_TARBALL_COMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_TARBALL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_REFRESH_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TAR_ENTRIES = 250_000;
const PNPM_LIST_TIMEOUT_MS = 60_000;
const REFRESH_CONCURRENCY = 4;
const NPM_TARBALL_MIRROR_ORIGIN = "https://registry.npmmirror.com";
const TARBALL_TRANSPORT_IDLE_TIMEOUT_MS = 45_000;
const TARBALL_TRANSPORT_TOTAL_TIMEOUT_MS = 30 * 60_000;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA512_INTEGRITY_PATTERN = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const PACKAGE_NAME_PATTERN =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION_PATTERN = /^[0-9][A-Za-z0-9.+_-]*$/;
const EVIDENCE_FILE_PATTERN =
  /^(?:licen[cs]e(?:[._-].*)?|copying(?:[._-].*)?|notice(?:[._-].*)?|copyrightnotice(?:[._-].*)?|third[-_. ]?party(?:notices?|licenses?)(?:[._-].*)?)$/i;

const ALLOWED_DECLARED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 AND LGPL-3.0-or-later",
  "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "EPL-2.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
]);

const METADATA_ONLY_LICENSE_REVIEWS = new Map([
  ["drizzle-orm@0.45.2", "metadata-license-only"],
  ["guid-typescript@1.0.9", "canonical-isc-fallback"],
  ["markstream-react@0.0.20-beta.7", "metadata-license-only"],
  ["stream-markdown-parser@0.0.60", "metadata-license-only"],
  ["onnxruntime-common@1.14.0", "onnx-excluded-build-input"],
  ["onnxruntime-node@1.14.0", "onnx-excluded-build-input"],
  ["onnxruntime-web@1.14.0", "onnx-excluded-build-input"],
  ["onnxruntime-common@1.22.0", "onnx-vendored-runtime"],
  ["onnxruntime-web@1.22.0", "onnx-vendored-runtime"],
]);

const KNOWN_REVIEW_TAGS = new Set([
  "anthropic-non-spdx",
  "canonical-isc-fallback",
  "epl-source-availability",
  "metadata-license-only",
  "onnx-excluded-build-input",
  "onnx-vendored-runtime",
  "or-license-selection",
  "see-license-resolution",
  "sharp-lgpl-platform",
  "sharp-platform-package",
  "transformers-local-patch",
  "tslib-copyright-notice",
]);

const ROOT_KEYS = [
  "schemaVersion",
  "artifact",
  "importer",
  "scope",
  "firstPartyWorkspacePackages",
  "components",
];
const COMPONENT_KEYS = [
  "name",
  "version",
  "resolved",
  "integrity",
  "declaredLicense",
  "concludedLicense",
  "packageJsonSha256",
  "licenseEvidence",
  "sourceUrl",
  "patch",
  "review",
];
const EVIDENCE_KEYS = ["path", "sha256"];
const PATCH_KEYS = ["path", "sha256"];

function fail(message) {
  throw new Error(`[npm-license-inventory] ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function componentKey(name, version) {
  return `${name}@${version}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, description) {
  if (!isRecord(value)) fail(`${description} must be an object`);
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${description} keys must be exactly ${expected.join(", ")}`);
  }
}

function assertShortString(value, description, maximum = 4096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    fail(
      `${description} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return value;
}

function validateHttpsUrl(value, description) {
  const source = assertShortString(value, description, 4096);
  let url;
  try {
    url = new URL(source);
  } catch {
    fail(`${description} must be an HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    fail(`${description} must be a credential-free HTTPS URL`);
  }
  return source;
}

function validateRegistryUrl(value, name, version, description) {
  const source = validateHttpsUrl(value, description);
  const url = new URL(source);
  const basename = name.startsWith("@")
    ? name.slice(name.indexOf("/") + 1)
    : name;
  const expectedPath = `/${name}/-/${basename}-${version}.tgz`;
  if (
    url.hostname !== "registry.npmjs.org" ||
    url.port ||
    url.search ||
    url.pathname !== expectedPath
  ) {
    fail(`${description} must be the canonical npm registry tarball URL`);
  }
  return source;
}

function normalizeEvidencePath(rawPath, description) {
  const value = assertShortString(rawPath, description, 512);
  if (
    isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value === ".." ||
    value === "."
  ) {
    fail(`${description} must be a single package-root filename`);
  }
  return value;
}

function normalizePatchPath(rawPath, description) {
  const value = assertShortString(rawPath, description, 512);
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    !value.startsWith("patches/") ||
    !value.endsWith(".patch") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`${description} must be a normalized patches/*.patch path`);
  }
  return value;
}

async function readStableOpenedFile(path, initialStats, description) {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  ).catch(() => {
    fail(`${description} cannot be opened safely (details withheld)`);
  });
  try {
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      openedStats.dev !== initialStats.dev ||
      openedStats.ino !== initialStats.ino ||
      openedStats.size !== initialStats.size
    ) {
      fail(`${description} changed before it could be read safely`);
    }
    const bytes = Buffer.allocUnsafe(openedStats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) fail(`${description} changed while being read`);
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await handle.read(
      probe,
      0,
      1,
      bytes.length,
    );
    const finalStats = await handle.stat();
    if (
      trailingBytes !== 0 ||
      finalStats.size !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino
    ) {
      fail(`${description} changed while being read`);
    }
    return bytes;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("[npm-license-inventory]")
    ) {
      throw error;
    }
    fail(`${description} cannot be read safely (details withheld)`);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readBoundedFile(path, maximumBytes, description) {
  const stats = await lstat(path).catch(() => {
    fail(`${description} cannot be read (details withheld)`);
  });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail(`${description} must be a regular file`);
  }
  if (stats.size <= 0 || stats.size > maximumBytes) {
    fail(`${description} must be between 1 and ${maximumBytes} bytes`);
  }
  return readStableOpenedFile(path, stats, description);
}

function integrityHex(integrity, description) {
  const match = SHA512_INTEGRITY_PATTERN.exec(integrity);
  if (!match) fail(`${description} has invalid sha512 integrity`);
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 64)
    fail(`${description} has invalid sha512 digest length`);
  return digest.toString("hex");
}

function npmCacheDirectories() {
  const candidates = [];
  if (process.env.npm_config_cache) {
    const configured = process.env.npm_config_cache;
    if (
      configured.length > 4096 ||
      configured.includes("\0") ||
      !isAbsolute(configured)
    ) {
      fail(`npm cache path must be a bounded absolute path`);
    }
    candidates.push(configured);
  }
  candidates.push(join(homedir(), ".npm"));
  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

export async function readVerifiedCachedTarball({
  integrity,
  budget,
  description,
  cacheDirectories = npmCacheDirectories(),
} = {}) {
  const hex = integrityHex(integrity, description);
  for (const cacheDirectory of cacheDirectories) {
    const path = join(
      cacheDirectory,
      "_cacache/content-v2/sha512",
      hex.slice(0, 2),
      hex.slice(2, 4),
      hex.slice(4),
    );
    const pathStats = await lstat(path).catch((error) => {
      if (error?.code === "ENOENT") return null;
      fail(
        `${description} npm cache entry cannot be inspected (details withheld)`,
      );
    });
    if (!pathStats) continue;
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
      fail(`${description} npm cache entry must be a regular non-symlink file`);
    }
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    ).catch((error) => {
      if (error?.code === "ENOENT") return null;
      fail(
        `${description} npm cache entry cannot be opened safely (details withheld)`,
      );
    });
    if (!handle) continue;
    let bytes;
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.dev !== pathStats.dev ||
        stats.ino !== pathStats.ino ||
        stats.size !== pathStats.size
      ) {
        fail(
          `${description} npm cache entry must be a regular non-symlink file`,
        );
      }
      if (stats.size <= 0 || stats.size > MAX_TARBALL_COMPRESSED_BYTES) {
        fail(`${description} npm cache entry exceeds its byte limit`);
      }
      bytes = Buffer.allocUnsafe(stats.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (bytesRead === 0) {
          fail(`${description} npm cache entry changed while being read`);
        }
        offset += bytesRead;
      }
      const probe = Buffer.allocUnsafe(1);
      const { bytesRead: trailingBytes } = await handle.read(
        probe,
        0,
        1,
        bytes.length,
      );
      const finalStats = await handle.stat();
      if (
        trailingBytes !== 0 ||
        finalStats.size !== stats.size ||
        finalStats.dev !== stats.dev ||
        finalStats.ino !== stats.ino
      ) {
        fail(`${description} npm cache entry changed while being read`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("[npm-license-inventory]")
      ) {
        throw error;
      }
      fail(
        `${description} npm cache entry cannot be read safely (details withheld)`,
      );
    } finally {
      await handle.close().catch(() => {});
    }
    budget.bytes += bytes.length;
    budget.cacheBytes = (budget.cacheBytes ?? 0) + bytes.length;
    if (budget.bytes > MAX_REFRESH_DOWNLOAD_BYTES) {
      fail(`license inventory refresh exceeded its source byte budget`);
    }
    const actualHex = createHash("sha512").update(bytes).digest("hex");
    if (actualHex !== hex) {
      fail(`${description} npm cache entry does not match lock integrity`);
    }
    return bytes;
  }
  return undefined;
}

export async function readExistingInventoryForRefresh(path) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail(`existing inventory metadata cannot be read (details withheld)`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail(`existing inventory must be a regular non-symlink file`);
  }
  if (stats.size <= 0 || stats.size > MAX_INVENTORY_BYTES) {
    fail(`existing inventory exceeds its bounded refresh size`);
  }
  return readStableOpenedFile(path, stats, "existing inventory");
}

export function formatPnpmListFailure(rootPackage, error, stderr) {
  const code =
    typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : typeof error?.code === "number"
        ? String(error.code)
        : "unknown";
  const signal =
    typeof error?.signal === "string" && /^[A-Z0-9]+$/.test(error.signal)
      ? error.signal
      : "none";
  return `[npm-license-inventory] pnpm list failed for ${rootPackage} (code=${code}, signal=${signal}, stderrBytes=${Buffer.byteLength(typeof stderr === "string" ? stderr : "")}; contents withheld)`;
}

async function executePnpmList(rootDir, rootPackage) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : "pnpm";
  const args = [
    ...(npmExecPath ? [npmExecPath] : []),
    "--filter",
    rootPackage,
    "list",
    "--prod",
    "--json",
    "--depth",
    "Infinity",
  ];
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: rootDir,
        encoding: "utf8",
        maxBuffer: MAX_LIST_OUTPUT_BYTES,
        timeout: PNPM_LIST_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(formatPnpmListFailure(rootPackage, error, stderr)),
          );
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

function parseListOutput(source, artifactName) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) > MAX_LIST_OUTPUT_BYTES
  ) {
    fail(`${artifactName} pnpm list output exceeds its byte limit`);
  }
  let roots;
  try {
    roots = JSON.parse(source);
  } catch {
    fail(
      `${artifactName} pnpm list output is not valid JSON (details withheld)`,
    );
  }
  const artifact = NPM_INVENTORY_ARTIFACTS[artifactName];
  if (
    !Array.isArray(roots) ||
    roots.length !== 1 ||
    !isRecord(roots[0]) ||
    roots[0].name !== artifact.rootPackage
  ) {
    fail(
      `${artifactName} pnpm list must contain exactly ${artifact.rootPackage}`,
    );
  }

  const components = new Map();
  const firstPartyWorkspacePackages = new Set();
  const stack = [];
  const enqueueDependencies = (node, depth) => {
    for (const field of ["dependencies", "optionalDependencies"]) {
      const dependencies = node[field];
      if (dependencies === undefined) continue;
      if (!isRecord(dependencies)) {
        fail(`${artifactName} pnpm list ${field} must be an object`);
      }
      for (const [name, dependency] of Object.entries(dependencies)) {
        stack.push({ name, dependency, depth });
      }
    }
  };
  enqueueDependencies(roots[0], 1);
  let visitedNodes = 0;

  while (stack.length > 0) {
    const { name, dependency, depth } = stack.pop();
    visitedNodes += 1;
    if (visitedNodes > MAX_GRAPH_NODES) {
      fail(`${artifactName} production graph exceeds ${MAX_GRAPH_NODES} nodes`);
    }
    if (depth > MAX_GRAPH_DEPTH) {
      fail(`${artifactName} production graph exceeds depth ${MAX_GRAPH_DEPTH}`);
    }
    if (!PACKAGE_NAME_PATTERN.test(name) || !isRecord(dependency)) {
      fail(`${artifactName} production graph contains an invalid dependency`);
    }
    const version = assertShortString(
      dependency.version,
      `${artifactName} ${name} version`,
      256,
    );
    if (version.startsWith("link:")) {
      if (!FIRST_PARTY_WORKSPACE_PACKAGES.has(name)) {
        fail(
          `${artifactName} contains an unreviewed workspace dependency ${name}`,
        );
      }
      firstPartyWorkspacePackages.add(name);
      enqueueDependencies(dependency, depth + 1);
      continue;
    }
    if (!VERSION_PATTERN.test(version)) {
      fail(`${artifactName} ${name} has an unsupported version ${version}`);
    }
    const resolved = assertShortString(
      dependency.resolved,
      `${artifactName} ${name}@${version} resolved URL`,
      4096,
    );
    validateRegistryUrl(
      resolved,
      name,
      version,
      `${artifactName} ${name}@${version} resolved URL`,
    );
    const key = componentKey(name, version);
    const existing = components.get(key);
    const packagePath =
      typeof dependency.path === "string" && dependency.path.length <= 8192
        ? dependency.path
        : undefined;
    if (existing) {
      if (existing.resolved !== resolved) {
        fail(
          `${artifactName} ${key} resolves to conflicting registry archives`,
        );
      }
      if (packagePath) existing.paths.add(packagePath);
    } else {
      if (components.size >= MAX_COMPONENTS) {
        fail(
          `${artifactName} production closure exceeds ${MAX_COMPONENTS} components`,
        );
      }
      components.set(key, {
        name,
        version,
        resolved,
        paths: new Set(packagePath ? [packagePath] : []),
      });
    }
    enqueueDependencies(dependency, depth + 1);
  }

  return { components, firstPartyWorkspacePackages };
}

export async function collectProductionClosure({
  rootDir = process.cwd(),
  artifactName,
  listOutput,
} = {}) {
  const artifact = NPM_INVENTORY_ARTIFACTS[artifactName];
  if (!artifact) fail(`unknown artifact: ${String(artifactName)}`);
  const source =
    listOutput ?? (await executePnpmList(rootDir, artifact.rootPackage));
  return parseListOutput(source, artifactName);
}

function unquoteLockKey(rawKey) {
  if (rawKey.startsWith("'") && rawKey.endsWith("'")) {
    return rawKey.slice(1, -1).replaceAll("''", "'");
  }
  return rawKey;
}

export function parsePnpmLockIntegrities(source) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) > MAX_LOCKFILE_BYTES
  ) {
    fail(`pnpm lockfile exceeds the ${MAX_LOCKFILE_BYTES}-byte limit`);
  }
  const startMarker = "\npackages:\n";
  const endMarker = "\nsnapshots:\n";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0)
    fail("pnpm lockfile has no bounded packages section");
  const integrities = new Map();
  let currentKey;
  const lines = source.slice(start + startMarker.length, end).split("\n");
  if (lines.length > 500_000) fail("pnpm lockfile has too many package lines");
  for (const line of lines) {
    const keyMatch = /^ {2}('.+'|[^ ].*):$/.exec(line);
    if (keyMatch) {
      currentKey = unquoteLockKey(keyMatch[1]);
      continue;
    }
    const integrityMatch =
      /^ {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\}$/.exec(
        line,
      );
    if (!integrityMatch || !currentKey) continue;
    if (integrities.has(currentKey)) {
      fail(`pnpm lockfile repeats package integrity for ${currentKey}`);
    }
    integrities.set(currentKey, integrityMatch[1]);
  }
  if (integrities.size === 0)
    fail("pnpm lockfile contains no package integrities");
  return integrities;
}

function policyForComponent({ artifactName, name, version, declaredLicense }) {
  const key = componentKey(name, version);
  const review = new Set();
  const additionalEvidence = new Set();
  let concludedLicense = declaredLicense;
  let allowNoLicenseFile = false;

  if (ALLOWED_DECLARED_LICENSES.has(declaredLicense)) {
    // The declared SPDX expression is also the reviewed conclusion unless an
    // exact exception below selects a permitted alternative.
  } else if (
    key === "@anthropic-ai/claude-agent-sdk@0.1.77" &&
    artifactName === "mcp" &&
    declaredLicense === "SEE LICENSE IN README.md"
  ) {
    concludedLicense = "LicenseRef-Anthropic-Legal-Agreements";
    additionalEvidence.add("README.md");
    additionalEvidence.add("LICENSE.md");
    review.add("anthropic-non-spdx");
  } else if (
    key === "flatbuffers@1.12.0" &&
    artifactName === "extension" &&
    declaredLicense === "SEE LICENSE IN LICENSE.txt"
  ) {
    concludedLicense = "Apache-2.0";
    additionalEvidence.add("LICENSE.txt");
    review.add("see-license-resolution");
  } else if (
    key === "expand-template@2.0.3" &&
    declaredLicense === "(MIT OR WTFPL)"
  ) {
    concludedLicense = "MIT";
    additionalEvidence.add("LICENSE");
    review.add("or-license-selection");
  } else if (
    key === "rc@1.2.8" &&
    declaredLicense === "(BSD-2-Clause OR MIT OR Apache-2.0)"
  ) {
    concludedLicense = "MIT";
    additionalEvidence.add("LICENSE.MIT");
    review.add("or-license-selection");
  } else {
    fail(`${artifactName} ${key} has an unreviewed license ${declaredLicense}`);
  }

  const metadataReview = METADATA_ONLY_LICENSE_REVIEWS.get(key);
  if (metadataReview) {
    if (artifactName !== "extension" && key !== "drizzle-orm@0.45.2") {
      fail(
        `${artifactName} cannot use the ${metadataReview} exception for ${key}`,
      );
    }
    allowNoLicenseFile = true;
    review.add(metadataReview);
  }

  if (name === "elkjs") {
    if (key !== "elkjs@0.11.0" || declaredLicense !== "EPL-2.0") {
      fail(
        `${artifactName} contains an unreviewed ELK license boundary ${key}`,
      );
    }
    review.add("epl-source-availability");
  }

  if (name === "sharp" || name.startsWith("@img/sharp-")) {
    review.add("sharp-platform-package");
    additionalEvidence.add("README.md");
    if (name.startsWith("@img/sharp-libvips-")) {
      if (declaredLicense !== "LGPL-3.0-or-later") {
        fail(`${artifactName} ${key} has an unexpected libvips license`);
      }
      review.add("sharp-lgpl-platform");
    } else if (declaredLicense.includes("LGPL-3.0-or-later")) {
      review.add("sharp-lgpl-platform");
    }
  }

  if (name === "tslib") {
    if (key !== "tslib@2.8.1")
      fail(`${artifactName} has an unreviewed tslib ${key}`);
    additionalEvidence.add("CopyrightNotice.txt");
    review.add("tslib-copyright-notice");
  }

  if (artifactName === "extension") {
    if (
      (name.startsWith("onnxruntime-") && version === "1.14.0") ||
      key === "onnx-proto@4.0.4"
    ) {
      review.add("onnx-excluded-build-input");
    }
    if (name.startsWith("onnxruntime-") && version === "1.22.0") {
      review.add("onnx-vendored-runtime");
    }
  }

  let patch = null;
  if (key === "@xenova/transformers@2.17.2") {
    if (artifactName !== "extension") {
      fail(
        `${artifactName} contains the Transformers patch outside its reviewed scope`,
      );
    }
    patch = {
      path: "patches/@xenova__transformers@2.17.2.patch",
      sha256:
        "262aa63ab2e21aa2c33c033870e775e376dd0dbbc35a0d3d9e80be2c8b1293e2",
    };
    review.add("transformers-local-patch");
  }

  return {
    concludedLicense,
    allowNoLicenseFile,
    additionalEvidence,
    patch,
    review: [...review].sort(compareText),
  };
}

function parsePackageJson(bytes, description) {
  if (bytes.length === 0 || bytes.length > MAX_PACKAGE_JSON_BYTES) {
    fail(`${description} package.json exceeds its byte limit`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${description} package.json is invalid (details withheld)`);
  }
}

function declaredLicenseFromPackage(pkg, description) {
  if (
    typeof pkg.license !== "string" ||
    pkg.license.length === 0 ||
    pkg.license.length > 256
  ) {
    fail(`${description} has no bounded single package.json license`);
  }
  return pkg.license;
}

function sourceUrlFromPackage(pkg, resolved) {
  const repository =
    typeof pkg.repository === "string"
      ? pkg.repository
      : isRecord(pkg.repository) && typeof pkg.repository.url === "string"
        ? pkg.repository.url
        : undefined;
  for (const candidate of [repository, pkg.homepage, resolved]) {
    if (typeof candidate !== "string" || candidate.length > 4096) continue;
    let normalized = candidate.trim();
    normalized = normalized.replace(/^git\+https:\/\//, "https://");
    normalized = normalized.replace(
      /^git:\/\/github\.com\//,
      "https://github.com/",
    );
    normalized = normalized.replace(
      /^ssh:\/\/git@github\.com\//,
      "https://github.com/",
    );
    normalized = normalized.replace(/^git@github\.com:/, "https://github.com/");
    normalized = normalized.replace(/\.git(?:#.*)?$/, "");
    try {
      return validateHttpsUrl(normalized, "package source URL");
    } catch {
      // Continue to the next package-declared source candidate.
    }
  }
  fail(`package metadata has no reviewed HTTPS source URL`);
}

function selectedEvidencePaths(entries, policy, declaredLicense, description) {
  const selected = new Set();
  for (const path of entries.keys()) {
    if (!path.startsWith("package/") || path.slice(8).includes("/")) continue;
    const basename = path.slice(8);
    if (EVIDENCE_FILE_PATTERN.test(basename)) selected.add(basename);
  }
  const seeLicenseMatch = /^SEE LICENSE IN (.+)$/.exec(declaredLicense);
  if (seeLicenseMatch) policy.additionalEvidence.add(seeLicenseMatch[1]);
  for (const path of policy.additionalEvidence) selected.add(path);

  const evidence = [];
  let totalBytes = 0;
  for (const path of [...selected].sort(compareText)) {
    const normalized = normalizeEvidencePath(
      path,
      `${description} evidence path`,
    );
    const bytes = entries.get(`package/${normalized}`);
    if (!bytes)
      fail(`${description} is missing reviewed evidence ${normalized}`);
    if (bytes.length === 0 || bytes.length > MAX_EVIDENCE_FILE_BYTES) {
      fail(`${description} evidence ${normalized} exceeds its byte limit`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_EVIDENCE_BYTES_PER_PACKAGE) {
      fail(`${description} license evidence exceeds its aggregate byte limit`);
    }
    evidence.push({ path: normalized, sha256: sha256(bytes) });
  }
  if (evidence.length > MAX_EVIDENCE_FILES) {
    fail(`${description} has more than ${MAX_EVIDENCE_FILES} evidence files`);
  }
  if (evidence.length === 0 && !policy.allowNoLicenseFile) {
    fail(`${description} has no reviewed license evidence file`);
  }
  return evidence;
}

function parseTarOctal(field, description, { allowEmpty = false } = {}) {
  const value = field.toString("utf8").replace(/\0.*$/s, "").trim();
  if (allowEmpty && value === "") return 0;
  if (!/^[0-7]+$/.test(value)) fail(`invalid tar ${description}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) fail(`unsafe tar ${description}`);
  return parsed;
}

function normalizeTarPath(rawPath, description, { directory = false } = {}) {
  const path =
    directory && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`${description} contains an unsafe tar path`);
  }
  return path;
}

function npmTarballRoots(packageName, packageVersion, description) {
  if (
    !PACKAGE_NAME_PATTERN.test(packageName) ||
    !VERSION_PATTERN.test(packageVersion)
  ) {
    fail(`${description} has an unsafe package identity or version`);
  }
  if (!packageName.startsWith("@types/")) return ["package"];
  const leaf = packageName.slice("@types/".length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(leaf)) {
    fail(`${description} has an unsafe DefinitelyTyped tar root`);
  }
  const version = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(packageVersion);
  if (!version) {
    fail(`${description} has an unsupported DefinitelyTyped version`);
  }
  return ["package", leaf, `${leaf} v${version[1]}.${version[2]}`];
}

export function isRetainedPackageMetadataPath(path, packageRoot = "package") {
  if (!path.startsWith(`${packageRoot}/`)) return false;
  const basename = path.slice(packageRoot.length + 1);
  if (!basename || basename.includes("/")) return false;
  return (
    basename === "package.json" ||
    EVIDENCE_FILE_PATTERN.test(basename) ||
    /^readme(?:[._-].*)?$/i.test(basename)
  );
}

export function extractNpmTarballEntries(
  compressed,
  description,
  { packageName = "safe-package", packageVersion = "1.0.0" } = {},
) {
  const packageRoots = npmTarballRoots(
    packageName,
    packageVersion,
    description,
  );
  let tar;
  try {
    tar = gunzipSync(compressed, {
      maxOutputLength: MAX_TARBALL_UNCOMPRESSED_BYTES,
    });
  } catch {
    fail(`${description} cannot be decompressed (details withheld)`);
  }
  const retainedEntries = new Map();
  let entryCount = 0;
  let retainedBytes = 0;
  let terminated = false;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      terminated = true;
      break;
    }
    entryCount += 1;
    if (entryCount > MAX_TAR_ENTRIES)
      fail(`${description} has too many tar entries`);
    const readField = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = readField(0, 100);
    const prefix = readField(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const expectedChecksum = parseTarOctal(
      header.subarray(148, 156),
      `${description} checksum`,
    );
    let actualChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (expectedChecksum !== actualChecksum)
      fail(`${description} tar checksum mismatch`);
    const size = parseTarOctal(
      header.subarray(124, 136),
      `${description} entry size`,
      { allowEmpty: true },
    );
    const type = String.fromCharCode(header[156] || 0);
    const isDirectory = type === "5";
    if (!["\0", "0", "5", "x", "g"].includes(type)) {
      fail(`${description} contains a tar link or special entry`);
    }
    const path = normalizeTarPath(fullName, description, {
      directory: isDirectory,
    });
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > tar.length) {
      fail(`${description} contains a truncated tar entry`);
    }
    if (
      (type === "\0" || type === "0") &&
      packageRoots.some((packageRoot) =>
        isRetainedPackageMetadataPath(path, packageRoot),
      )
    ) {
      if (retainedEntries.has(path)) {
        fail(`${description} repeats tar entry ${path}`);
      }
      retainedBytes += size;
      if (retainedBytes > MAX_RETAINED_ARCHIVE_BYTES) {
        fail(`${description} retained legal metadata exceeds its byte limit`);
      }
      retainedEntries.set(path, Buffer.from(tar.subarray(dataStart, dataEnd)));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!terminated) fail(`${description} tarball has no terminator`);
  const rootsWithManifest = packageRoots.filter((packageRoot) =>
    retainedEntries.has(`${packageRoot}/package.json`),
  );
  if (rootsWithManifest.length !== 1) {
    fail(
      `${description} tarball must contain exactly one reviewed package root`,
    );
  }
  const selectedRoot = rootsWithManifest[0];
  const entries = new Map();
  for (const [path, bytes] of retainedEntries) {
    if (!path.startsWith(`${selectedRoot}/`)) continue;
    const normalized = `package/${path.slice(selectedRoot.length + 1)}`;
    if (entries.has(normalized)) {
      fail(`${description} repeats normalized tar entry ${normalized}`);
    }
    entries.set(normalized, bytes);
  }
  return {
    entries,
    retainedBytes: [...entries.values()].reduce(
      (total, bytes) => total + bytes.length,
      0,
    ),
  };
}

export function tarballTransportUrls(component) {
  validateRegistryUrl(
    component.resolved,
    component.name,
    component.version,
    `${componentKey(component.name, component.version)} resolved URL`,
  );
  const canonical = new URL(component.resolved);
  const mirror = new URL(canonical.pathname, NPM_TARBALL_MIRROR_ORIGIN);
  return [mirror.href, canonical.href];
}

async function readResponseBodyBounded(
  response,
  budget,
  description,
  { onProgress = () => {} } = {},
) {
  if (!response.body) return undefined;
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const declaredLength = Number(rawLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength <= 0 ||
      declaredLength > MAX_TARBALL_COMPRESSED_BYTES
    ) {
      fail(`${description} transport body exceeds its byte limit`);
    }
  }
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      onProgress();
      bytes += chunk.length;
      budget.bytes += chunk.length;
      budget.networkBytes = (budget.networkBytes ?? 0) + chunk.length;
      if (
        bytes > MAX_TARBALL_COMPRESSED_BYTES ||
        budget.bytes > MAX_REFRESH_DOWNLOAD_BYTES
      ) {
        fail(`license inventory refresh exceeded its source byte budget`);
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("[npm-license-inventory]")
    ) {
      throw error;
    }
    return undefined;
  }
  return bytes > 0 ? Buffer.concat(chunks, bytes) : undefined;
}

export async function downloadVerifiedTarball(
  component,
  integrity,
  budget,
  {
    fetchImpl = globalThis.fetch,
    idleTimeoutMs = TARBALL_TRANSPORT_IDLE_TIMEOUT_MS,
    totalTimeoutMs = TARBALL_TRANSPORT_TOTAL_TIMEOUT_MS,
    transportState = { mirrorEnabled: true },
  } = {},
) {
  const integrityMatch = SHA512_INTEGRITY_PATTERN.exec(integrity);
  if (!integrityMatch)
    fail(
      `${componentKey(component.name, component.version)} has invalid sha512 integrity`,
    );
  if (
    !Number.isSafeInteger(idleTimeoutMs) ||
    idleTimeoutMs <= 0 ||
    !Number.isSafeInteger(totalTimeoutMs) ||
    totalTimeoutMs < idleTimeoutMs ||
    totalTimeoutMs > TARBALL_TRANSPORT_TOTAL_TIMEOUT_MS
  ) {
    fail(`tarball transport timeouts are invalid`);
  }
  if (
    !isRecord(transportState) ||
    typeof transportState.mirrorEnabled !== "boolean"
  ) {
    fail(`tarball transport state is invalid`);
  }
  for (const [transportIndex, transportUrl] of tarballTransportUrls(
    component,
  ).entries()) {
    const isMirror = transportIndex === 0;
    if (isMirror && !transportState.mirrorEnabled) continue;
    const disableMirror = () => {
      if (isMirror) transportState.mirrorEnabled = false;
    };
    const controller = new globalThis.AbortController();
    const totalTimer = setTimeout(() => controller.abort(), totalTimeoutMs);
    let idleTimer;
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    };
    armIdleTimer();
    let response;
    try {
      response = await fetchImpl(transportUrl, {
        redirect: "error",
        signal: controller.signal,
      });
      armIdleTimer();
    } catch {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      disableMirror();
      continue;
    }
    if (!response.ok || !response.body) {
      disableMirror();
      controller.abort();
      await response.body?.cancel().catch(() => {});
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      continue;
    }
    let compressed;
    try {
      compressed = await readResponseBodyBounded(
        response,
        budget,
        componentKey(component.name, component.version),
        { onProgress: armIdleTimer },
      );
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
    }
    if (!compressed) {
      disableMirror();
      continue;
    }
    const actual = createHash("sha512").update(compressed).digest("base64");
    if (actual === integrityMatch[1]) return compressed;
    disableMirror();
  }
  fail(
    `${componentKey(component.name, component.version)} has no transport matching lock integrity (details withheld)`,
  );
}

async function loadVerifiedPackageArchive({
  graphComponent,
  integrity,
  budget,
  archiveCache,
  cacheDirectories,
  fetchImpl,
  transportState,
}) {
  const cacheKey = `${graphComponent.resolved}\0${integrity}`;
  const cached = archiveCache.get(cacheKey);
  if (cached) return cached;
  const loading = (async () => {
    const key = componentKey(graphComponent.name, graphComponent.version);
    const compressed =
      (await readVerifiedCachedTarball({
        integrity,
        budget,
        description: key,
        cacheDirectories,
      })) ??
      (await downloadVerifiedTarball(graphComponent, integrity, budget, {
        fetchImpl,
        transportState,
      }));
    const { entries, retainedBytes } = extractNpmTarballEntries(
      compressed,
      key,
      {
        packageName: graphComponent.name,
        packageVersion: graphComponent.version,
      },
    );
    budget.retainedBytes = (budget.retainedBytes ?? 0) + retainedBytes;
    if (budget.retainedBytes > MAX_ARCHIVE_CACHE_BYTES) {
      fail(`license evidence cache exceeds its aggregate byte limit`);
    }
    const packageJsonBytes = entries.get("package/package.json");
    if (!packageJsonBytes) fail(`${key} tarball has no package/package.json`);
    return {
      entries,
      packageJsonBytes,
      pkg: parsePackageJson(packageJsonBytes, key),
    };
  })();
  archiveCache.set(cacheKey, loading);
  try {
    return await loading;
  } catch (error) {
    archiveCache.delete(cacheKey);
    throw error;
  }
}

async function componentFromVerifiedTarball({
  rootDir,
  artifactName,
  graphComponent,
  integrity,
  budget,
  archiveCache,
  cacheDirectories,
  fetchImpl,
  transportState,
}) {
  const key = componentKey(graphComponent.name, graphComponent.version);
  const { entries, packageJsonBytes, pkg } = await loadVerifiedPackageArchive({
    graphComponent,
    integrity,
    budget,
    archiveCache,
    cacheDirectories,
    fetchImpl,
    transportState,
  });
  if (
    pkg.name !== graphComponent.name ||
    pkg.version !== graphComponent.version
  ) {
    fail(`${key} tarball package identity does not match the production graph`);
  }
  const declaredLicense = declaredLicenseFromPackage(pkg, key);
  const policy = policyForComponent({
    artifactName,
    name: graphComponent.name,
    version: graphComponent.version,
    declaredLicense,
  });
  const licenseEvidence = selectedEvidencePaths(
    entries,
    policy,
    declaredLicense,
    key,
  );
  if (policy.patch) {
    const patchBytes = await readBoundedFile(
      resolve(rootDir, policy.patch.path),
      1024 * 1024,
      `${key} reviewed patch`,
    );
    if (sha256(patchBytes) !== policy.patch.sha256) {
      fail(`${key} reviewed patch digest does not match policy`);
    }
  }
  return {
    name: graphComponent.name,
    version: graphComponent.version,
    resolved: graphComponent.resolved,
    integrity,
    declaredLicense,
    concludedLicense: policy.concludedLicense,
    packageJsonSha256: sha256(packageJsonBytes),
    licenseEvidence,
    sourceUrl: sourceUrlFromPackage(pkg, graphComponent.resolved),
    patch: policy.patch,
    review: policy.review,
  };
}

function validateInventoryShape(raw, artifactName) {
  const artifact = NPM_INVENTORY_ARTIFACTS[artifactName];
  assertExactKeys(raw, ROOT_KEYS, `${artifactName} inventory`);
  if (raw.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    fail(`${artifactName} inventory has an unsupported schema version`);
  }
  if (
    raw.artifact !== artifactName ||
    raw.importer !== artifact.importer ||
    raw.scope !== INVENTORY_SCOPE
  ) {
    fail(`${artifactName} inventory identity or scope is incorrect`);
  }
  if (
    !Array.isArray(raw.firstPartyWorkspacePackages) ||
    raw.firstPartyWorkspacePackages.length > FIRST_PARTY_WORKSPACE_PACKAGES.size
  ) {
    fail(`${artifactName} inventory first-party exclusions are invalid`);
  }
  const firstParty = new Set();
  for (const name of raw.firstPartyWorkspacePackages) {
    if (!FIRST_PARTY_WORKSPACE_PACKAGES.has(name) || firstParty.has(name)) {
      fail(`${artifactName} inventory has an unreviewed first-party exclusion`);
    }
    firstParty.add(name);
  }
  if (
    !Array.isArray(raw.components) ||
    raw.components.length === 0 ||
    raw.components.length > MAX_COMPONENTS
  ) {
    fail(`${artifactName} inventory component count is invalid`);
  }
  const components = new Map();
  let previousKey = "";
  for (const [index, component] of raw.components.entries()) {
    assertExactKeys(
      component,
      COMPONENT_KEYS,
      `${artifactName} component ${index}`,
    );
    const name = assertShortString(
      component.name,
      `${artifactName} component name`,
      256,
    );
    const version = assertShortString(
      component.version,
      `${artifactName} component version`,
      256,
    );
    if (!PACKAGE_NAME_PATTERN.test(name) || !VERSION_PATTERN.test(version)) {
      fail(`${artifactName} component ${index} has an invalid identity`);
    }
    const key = componentKey(name, version);
    if (key <= previousKey) {
      fail(`${artifactName} inventory components must be unique and sorted`);
    }
    previousKey = key;
    validateRegistryUrl(
      component.resolved,
      name,
      version,
      `${artifactName} ${key} resolved URL`,
    );
    if (!SHA512_INTEGRITY_PATTERN.test(component.integrity)) {
      fail(`${artifactName} ${key} has an invalid registry integrity`);
    }
    for (const [field, maximum] of [
      ["declaredLicense", 256],
      ["concludedLicense", 256],
      ["sourceUrl", 4096],
    ]) {
      assertShortString(
        component[field],
        `${artifactName} ${key} ${field}`,
        maximum,
      );
    }
    validateHttpsUrl(component.sourceUrl, `${artifactName} ${key} source URL`);
    if (!SHA256_PATTERN.test(component.packageJsonSha256)) {
      fail(`${artifactName} ${key} has an invalid package.json digest`);
    }
    if (
      !Array.isArray(component.licenseEvidence) ||
      component.licenseEvidence.length > MAX_EVIDENCE_FILES
    ) {
      fail(`${artifactName} ${key} license evidence is invalid`);
    }
    let previousEvidence = "";
    for (const evidence of component.licenseEvidence) {
      assertExactKeys(
        evidence,
        EVIDENCE_KEYS,
        `${artifactName} ${key} evidence`,
      );
      const path = normalizeEvidencePath(
        evidence.path,
        `${artifactName} ${key} evidence path`,
      );
      if (path <= previousEvidence || !SHA256_PATTERN.test(evidence.sha256)) {
        fail(
          `${artifactName} ${key} evidence must be unique, sorted, and hashed`,
        );
      }
      previousEvidence = path;
    }
    if (component.patch !== null) {
      assertExactKeys(
        component.patch,
        PATCH_KEYS,
        `${artifactName} ${key} patch`,
      );
      normalizePatchPath(
        component.patch.path,
        `${artifactName} ${key} patch path`,
      );
      if (!SHA256_PATTERN.test(component.patch.sha256)) {
        fail(`${artifactName} ${key} patch digest is invalid`);
      }
    }
    if (!Array.isArray(component.review)) {
      fail(`${artifactName} ${key} review tags must be an array`);
    }
    let previousReview = "";
    for (const tag of component.review) {
      if (!KNOWN_REVIEW_TAGS.has(tag) || tag <= previousReview) {
        fail(
          `${artifactName} ${key} has unknown, duplicate, or unsorted review tags`,
        );
      }
      previousReview = tag;
    }
    const policy = policyForComponent({
      artifactName,
      name,
      version,
      declaredLicense: component.declaredLicense,
    });
    if (
      component.concludedLicense !== policy.concludedLicense ||
      JSON.stringify(component.patch) !== JSON.stringify(policy.patch) ||
      JSON.stringify(component.review) !== JSON.stringify(policy.review) ||
      (component.licenseEvidence.length === 0 && !policy.allowNoLicenseFile)
    ) {
      fail(`${artifactName} ${key} does not match the reviewed license policy`);
    }
    components.set(key, component);
  }
  return { raw, components, firstPartyWorkspacePackages: firstParty };
}

export function parseReviewedInventory(bytes, artifactName) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_INVENTORY_BYTES
  ) {
    fail(`${artifactName} inventory must be 1-${MAX_INVENTORY_BYTES} bytes`);
  }
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    fail(`${artifactName} inventory must be valid UTF-8`);
  }
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    fail(`${artifactName} inventory is invalid JSON (details withheld)`);
  }
  const parsed = validateInventoryShape(raw, artifactName);
  if (`${JSON.stringify(raw, null, 2)}\n` !== source) {
    fail(`${artifactName} inventory is not in canonical JSON form`);
  }
  return parsed;
}

function sameStringSet(left, right) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

async function verifyLocalComponent(
  rootDir,
  artifactName,
  graphComponent,
  reviewed,
) {
  const candidatePaths = [...graphComponent.paths].sort(compareText);
  const canonicalRepository = await realpath(rootDir).catch(() => {
    fail(
      `${artifactName} repository root cannot be resolved (details withheld)`,
    );
  });
  const verifiedRoots = new Set();
  let locallyAvailable = false;
  for (const candidate of candidatePaths) {
    const rootStats = await lstat(candidate).catch((error) => {
      if (error?.code === "ENOENT") return null;
      fail(
        `${artifactName} ${componentKey(reviewed.name, reviewed.version)} installed package root cannot be inspected (details withheld)`,
      );
    });
    if (!rootStats) continue;
    locallyAvailable = true;
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      fail(
        `${artifactName} ${componentKey(reviewed.name, reviewed.version)} installed package root must be a real directory`,
      );
    }
    const manifestPath = join(candidate, "package.json");
    const stats = await lstat(manifestPath).catch(() => {
      fail(
        `${artifactName} ${componentKey(reviewed.name, reviewed.version)} installed package.json is missing or unreadable (details withheld)`,
      );
    });
    if (!stats.isFile() || stats.isSymbolicLink()) {
      fail(
        `${artifactName} ${componentKey(reviewed.name, reviewed.version)} installed package.json must be a regular file`,
      );
    }
    const canonicalRoot = await realpath(candidate).catch(() => {
      fail(
        `${artifactName} ${componentKey(reviewed.name, reviewed.version)} installed package root cannot be resolved (details withheld)`,
      );
    });
    const relativePath = relative(canonicalRepository, canonicalRoot);
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      fail(
        `${artifactName} ${componentKey(reviewed.name, reviewed.version)} resolves outside the repository`,
      );
    }
    if (verifiedRoots.has(canonicalRoot)) continue;
    verifiedRoots.add(canonicalRoot);
    const packageJsonBytes = await readBoundedFile(
      join(canonicalRoot, "package.json"),
      MAX_PACKAGE_JSON_BYTES,
      `${artifactName} ${componentKey(reviewed.name, reviewed.version)} package.json`,
    );
    const pkg = parsePackageJson(
      packageJsonBytes,
      `${artifactName} ${componentKey(reviewed.name, reviewed.version)}`,
    );
    if (
      pkg.name !== reviewed.name ||
      pkg.version !== reviewed.version ||
      declaredLicenseFromPackage(pkg, reviewed.name) !==
        reviewed.declaredLicense ||
      sha256(packageJsonBytes) !== reviewed.packageJsonSha256 ||
      sourceUrlFromPackage(pkg, reviewed.resolved) !== reviewed.sourceUrl
    ) {
      fail(
        `${artifactName} ${componentKey(reviewed.name, reviewed.version)} installed package metadata drifted from review`,
      );
    }
    for (const evidence of reviewed.licenseEvidence) {
      const bytes = await readBoundedFile(
        join(canonicalRoot, evidence.path),
        MAX_EVIDENCE_FILE_BYTES,
        `${artifactName} ${componentKey(reviewed.name, reviewed.version)} evidence ${evidence.path}`,
      );
      if (sha256(bytes) !== evidence.sha256) {
        fail(
          `${artifactName} ${componentKey(reviewed.name, reviewed.version)} installed evidence drifted: ${evidence.path}`,
        );
      }
    }
  }
  return locallyAvailable;
}

export async function verifyReviewedInventory({
  rootDir = process.cwd(),
  artifactName,
  inventoryBytes,
  listOutput,
  lockfileSource,
  verifyLocalInstall = true,
} = {}) {
  const artifact = NPM_INVENTORY_ARTIFACTS[artifactName];
  if (!artifact) fail(`unknown artifact: ${String(artifactName)}`);
  const bytes =
    inventoryBytes ??
    (await readBoundedFile(
      resolve(rootDir, artifact.inventorySource),
      MAX_INVENTORY_BYTES,
      `${artifactName} reviewed inventory`,
    ));
  const inventory = parseReviewedInventory(bytes, artifactName);
  const closure = await collectProductionClosure({
    rootDir,
    artifactName,
    listOutput,
  });
  const lockSource =
    lockfileSource ??
    (
      await readBoundedFile(
        resolve(rootDir, "pnpm-lock.yaml"),
        MAX_LOCKFILE_BYTES,
        "pnpm lockfile",
      )
    ).toString("utf8");
  const integrities = parsePnpmLockIntegrities(lockSource);

  const expectedKeys = new Set(closure.components.keys());
  const reviewedKeys = new Set(inventory.components.keys());
  if (!sameStringSet(expectedKeys, reviewedKeys)) {
    const missing = [...expectedKeys]
      .filter((key) => !reviewedKeys.has(key))
      .sort(compareText);
    const stale = [...reviewedKeys]
      .filter((key) => !expectedKeys.has(key))
      .sort(compareText);
    fail(
      `${artifactName} inventory closure mismatch; missing=[${missing.join(", ")}], stale=[${stale.join(", ")}]`,
    );
  }
  if (
    !sameStringSet(
      closure.firstPartyWorkspacePackages,
      inventory.firstPartyWorkspacePackages,
    )
  ) {
    fail(`${artifactName} inventory first-party workspace exclusions drifted`);
  }

  let locallyVerified = 0;
  let locallyUnavailable = 0;
  for (const [key, graphComponent] of closure.components) {
    const reviewed = inventory.components.get(key);
    const lockedIntegrity = integrities.get(key);
    if (!lockedIntegrity || reviewed.integrity !== lockedIntegrity) {
      fail(
        `${artifactName} ${key} registry integrity does not match pnpm-lock.yaml`,
      );
    }
    if (reviewed.resolved !== graphComponent.resolved) {
      fail(`${artifactName} ${key} resolved archive drifted from pnpm list`);
    }
    if (
      verifyLocalInstall &&
      (await verifyLocalComponent(
        rootDir,
        artifactName,
        graphComponent,
        reviewed,
      ))
    ) {
      locallyVerified += 1;
    } else if (verifyLocalInstall) {
      locallyUnavailable += 1;
    }
    if (reviewed.patch) {
      const patchBytes = await readBoundedFile(
        resolve(rootDir, reviewed.patch.path),
        1024 * 1024,
        `${artifactName} ${key} patch`,
      );
      if (sha256(patchBytes) !== reviewed.patch.sha256) {
        fail(`${artifactName} ${key} patch drifted from its reviewed digest`);
      }
    }
  }
  return {
    componentCount: reviewedKeys.size,
    locallyVerified,
    locallyUnavailable,
    firstPartyWorkspacePackages: [...inventory.firstPartyWorkspacePackages],
  };
}

export async function buildReviewedInventory({
  rootDir = process.cwd(),
  artifactName,
  listOutput,
  lockfileSource,
  budget = { bytes: 0, retainedBytes: 0 },
  archiveCache = new Map(),
  onProgress,
  cacheDirectories,
  fetchImpl,
  transportState = { mirrorEnabled: true },
} = {}) {
  const artifact = NPM_INVENTORY_ARTIFACTS[artifactName];
  if (!artifact) fail(`unknown artifact: ${String(artifactName)}`);
  const closure = await collectProductionClosure({
    rootDir,
    artifactName,
    listOutput,
  });
  const lockSource =
    lockfileSource ??
    (
      await readBoundedFile(
        resolve(rootDir, "pnpm-lock.yaml"),
        MAX_LOCKFILE_BYTES,
        "pnpm lockfile",
      )
    ).toString("utf8");
  const integrities = parsePnpmLockIntegrities(lockSource);
  const graphComponents = [...closure.components.values()].sort((left, right) =>
    compareText(
      componentKey(left.name, left.version),
      componentKey(right.name, right.version),
    ),
  );
  const components = new Array(graphComponents.length);
  let nextIndex = 0;
  let completed = 0;
  let failure;
  const worker = async () => {
    while (!failure) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= graphComponents.length) return;
      const graphComponent = graphComponents[index];
      const key = componentKey(graphComponent.name, graphComponent.version);
      const integrity = integrities.get(key);
      if (!integrity) {
        failure = new Error(
          `[npm-license-inventory] ${artifactName} ${key} has no locked registry integrity`,
        );
        return;
      }
      try {
        components[index] = await componentFromVerifiedTarball({
          rootDir,
          artifactName,
          graphComponent,
          integrity,
          budget,
          archiveCache,
          cacheDirectories,
          fetchImpl,
          transportState,
        });
        completed += 1;
        onProgress?.({
          artifactName,
          completed,
          total: graphComponents.length,
        });
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: REFRESH_CONCURRENCY }, () => worker()),
  );
  if (failure) throw failure;
  const raw = {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    artifact: artifactName,
    importer: artifact.importer,
    scope: INVENTORY_SCOPE,
    firstPartyWorkspacePackages: [...closure.firstPartyWorkspacePackages].sort(
      compareText,
    ),
    components,
  };
  const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, "utf8");
  parseReviewedInventory(bytes, artifactName);
  return bytes;
}

export async function refreshReviewedInventories({
  rootDir = process.cwd(),
  onProgress,
  cacheDirectories,
  fetchImpl,
} = {}) {
  const budget = {
    bytes: 0,
    cacheBytes: 0,
    networkBytes: 0,
    retainedBytes: 0,
  };
  const archiveCache = new Map();
  const transportState = { mirrorEnabled: true };
  const prepared = [];
  for (const artifactName of Object.keys(NPM_INVENTORY_ARTIFACTS)) {
    const artifact = NPM_INVENTORY_ARTIFACTS[artifactName];
    const bytes = await buildReviewedInventory({
      rootDir,
      artifactName,
      budget,
      archiveCache,
      onProgress,
      cacheDirectories,
      fetchImpl,
      transportState,
    });
    prepared.push({
      artifactName,
      target: resolve(rootDir, artifact.inventorySource),
      bytes: bytes.length,
      contents: bytes,
      componentCount: parseReviewedInventory(bytes, artifactName).components
        .size,
      sha256: sha256(bytes),
    });
  }

  const previous = new Map();
  for (const inventory of prepared) {
    previous.set(
      inventory.target,
      await readExistingInventoryForRefresh(inventory.target),
    );
  }

  let atomicCounter = 0;
  const writeAtomically = async (target, contents) => {
    atomicCounter += 1;
    const temporary = `${target}.refresh-${process.pid}-${atomicCounter}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  };

  const replaced = [];
  try {
    for (const inventory of prepared) {
      await writeAtomically(inventory.target, inventory.contents);
      replaced.push(inventory.target);
    }
  } catch {
    let rollbackFailed = false;
    for (const target of replaced.reverse()) {
      const contents = previous.get(target);
      try {
        if (contents === null) await rm(target, { force: true });
        else await writeAtomically(target, contents);
      } catch {
        rollbackFailed = true;
      }
    }
    fail(
      rollbackFailed
        ? "inventory refresh write failed and rollback was incomplete"
        : "inventory refresh write failed; previous inventories were restored",
    );
  }

  return {
    sourceBytes: budget.bytes,
    cacheBytes: budget.cacheBytes,
    networkBytes: budget.networkBytes,
    inventories: prepared.map(
      ({ artifactName, bytes, componentCount, sha256: digest }) => ({
        artifactName,
        bytes,
        componentCount,
        sha256: digest,
      }),
    ),
  };
}
