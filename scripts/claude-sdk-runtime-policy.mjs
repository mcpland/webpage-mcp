import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const POLICY_PATH = "scripts/claude-sdk-runtime-policy.json";
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const EXACT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const PACKAGE_NAME_PATTERN =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVIEWED_ADVISORY_ID = "GHSA-f88m-g3jw-g9cj";
const REVIEWED_BLOCKED_FORMATS = ["GIF", "TIFF", "VIPS"];

function fail(message) {
  throw new Error(`[claude-sdk-runtime-policy] ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, description) {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)
  ) {
    fail(`${description} keys must be exactly ${keys.join(", ")}`);
  }
}

export function parseClaudeSdkRuntimePolicy(source) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) === 0 ||
    Buffer.byteLength(source) > MAX_POLICY_BYTES
  ) {
    fail("policy must be bounded UTF-8 JSON");
  }
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    fail("policy is invalid JSON");
  }
  if (`${JSON.stringify(raw, null, 2)}\n` !== source) {
    fail("policy is not canonical JSON");
  }
  exactKeys(
    raw,
    [
      "schemaVersion",
      "sdk",
      "platformPackages",
      "embeddedComponents",
      "advisoryMitigations",
    ],
    "policy",
  );
  if (raw.schemaVersion !== 1) fail("unsupported schema version");
  exactKeys(raw.sdk, ["name", "version"], "sdk");
  if (
    raw.sdk.name !== "@anthropic-ai/claude-agent-sdk" ||
    !EXACT_VERSION_PATTERN.test(raw.sdk.version)
  ) {
    fail("SDK identity must be exact");
  }
  if (
    !Array.isArray(raw.platformPackages) ||
    raw.platformPackages.length !== 8 ||
    raw.platformPackages.some(
      (name, index) =>
        typeof name !== "string" ||
        !PACKAGE_NAME_PATTERN.test(name) ||
        (index > 0 && name <= raw.platformPackages[index - 1]),
    )
  ) {
    fail("platform packages must be eight sorted package names");
  }
  if (
    !raw.platformPackages.every((name) =>
      name.startsWith("@anthropic-ai/claude-agent-sdk-"),
    )
  ) {
    fail("platform packages must belong to the Claude Agent SDK");
  }
  if (
    !isRecord(raw.embeddedComponents) ||
    Object.keys(raw.embeddedComponents).length === 0
  ) {
    fail("embedded components must be a non-empty object");
  }
  const embeddedComponents = new Map();
  let previousName = "";
  for (const [name, version] of Object.entries(raw.embeddedComponents)) {
    if (
      name <= previousName ||
      !PACKAGE_NAME_PATTERN.test(name) ||
      !EXACT_VERSION_PATTERN.test(version)
    ) {
      fail("embedded components must be sorted exact packages");
    }
    embeddedComponents.set(name, version);
    previousName = name;
  }
  exactKeys(
    raw.advisoryMitigations,
    [REVIEWED_ADVISORY_ID],
    "advisory mitigations",
  );
  const mitigation = raw.advisoryMitigations[REVIEWED_ADVISORY_ID];
  exactKeys(
    mitigation,
    ["component", "version", "blockedFormats"],
    "Sharp advisory mitigation",
  );
  if (
    mitigation.component !== "sharp" ||
    mitigation.version !== embeddedComponents.get("sharp") ||
    JSON.stringify(mitigation.blockedFormats) !==
      JSON.stringify(REVIEWED_BLOCKED_FORMATS)
  ) {
    fail("Sharp advisory mitigation does not match the reviewed boundary");
  }
  return {
    raw,
    embeddedComponents,
    mitigations: new Map([
      [
        REVIEWED_ADVISORY_ID,
        {
          component: mitigation.component,
          version: mitigation.version,
          blockedFormats: [...mitigation.blockedFormats],
        },
      ],
    ]),
  };
}

export function loadClaudeSdkRuntimePolicy(rootDir) {
  return parseClaudeSdkRuntimePolicy(
    fs.readFileSync(path.resolve(rootDir, POLICY_PATH), "utf8"),
  );
}

function currentPlatformPackageName(platformPackages) {
  if (!new Set(["arm64", "x64"]).has(process.arch)) {
    fail(`unsupported architecture ${process.arch}`);
  }
  let suffix;
  if (process.platform === "darwin" || process.platform === "win32") {
    suffix = `${process.platform}-${process.arch}`;
  } else if (process.platform === "linux") {
    const report = process.report?.getReport?.();
    const glibc = report?.header?.glibcVersionRuntime;
    suffix = glibc ? `linux-${process.arch}` : `linux-${process.arch}-musl`;
  } else {
    fail(`unsupported platform ${process.platform}`);
  }
  const name = `@anthropic-ai/claude-agent-sdk-${suffix}`;
  if (!platformPackages.includes(name)) {
    fail(`policy does not include current platform package ${name}`);
  }
  return name;
}

function binaryContains(filePath, needle) {
  const stats = fs.lstatSync(filePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size <= 0 ||
    stats.size > MAX_BINARY_BYTES
  ) {
    fail("installed Claude binary must be a bounded regular file");
  }
  const pattern = Buffer.from(needle);
  const overlapBytes = Math.max(0, pattern.length - 1);
  const chunk = Buffer.alloc(SCAN_CHUNK_BYTES + overlapBytes);
  const descriptor = fs.openSync(filePath, "r");
  let retained = 0;
  let position = 0;
  try {
    while (position < stats.size) {
      const bytesRead = fs.readSync(
        descriptor,
        chunk,
        retained,
        SCAN_CHUNK_BYTES,
        position,
      );
      if (bytesRead === 0) break;
      const available = retained + bytesRead;
      if (chunk.subarray(0, available).includes(pattern)) return true;
      retained = Math.min(overlapBytes, available);
      chunk.copy(chunk, 0, available - retained, available);
      position += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return false;
}

export function verifyInstalledClaudeSdkRuntime(rootDir) {
  const policy = loadClaudeSdkRuntimePolicy(rootDir);
  const mcpPackagePath = path.resolve(rootDir, "app/mcp-server/package.json");
  const mcpPackage = JSON.parse(fs.readFileSync(mcpPackagePath, "utf8"));
  if (
    mcpPackage.dependencies?.[policy.raw.sdk.name] !== policy.raw.sdk.version
  ) {
    fail("MCP package does not pin the reviewed Claude SDK version");
  }
  const requireFromMcp = createRequire(mcpPackagePath);
  const sdkEntry = requireFromMcp.resolve(policy.raw.sdk.name);
  const requireFromSdk = createRequire(sdkEntry);
  const sdkPackage = JSON.parse(
    fs.readFileSync(path.join(path.dirname(sdkEntry), "package.json"), "utf8"),
  );
  if (
    sdkPackage.name !== policy.raw.sdk.name ||
    sdkPackage.version !== policy.raw.sdk.version
  ) {
    fail("installed Claude SDK identity drifted from policy");
  }
  const expectedOptionalDependencies = Object.fromEntries(
    policy.raw.platformPackages.map((name) => [name, policy.raw.sdk.version]),
  );
  if (
    JSON.stringify(Object.entries(sdkPackage.optionalDependencies).sort()) !==
    JSON.stringify(Object.entries(expectedOptionalDependencies).sort())
  ) {
    fail("Claude SDK platform package topology drifted from policy");
  }

  const platformPackageName = currentPlatformPackageName(
    policy.raw.platformPackages,
  );
  const platformPackagePath = requireFromSdk.resolve(
    `${platformPackageName}/package.json`,
  );
  const platformPackage = JSON.parse(
    fs.readFileSync(platformPackagePath, "utf8"),
  );
  if (
    platformPackage.name !== platformPackageName ||
    platformPackage.version !== policy.raw.sdk.version
  ) {
    fail("installed Claude SDK platform package drifted from policy");
  }
  const binaryPath = path.join(
    path.dirname(platformPackagePath),
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  const sharpVersion = policy.embeddedComponents.get("sharp");
  const sharpFingerprint =
    'exports={name:"sharp",description:"High performance Node.js image processing, the fastest module to resize JPEG, PNG, WebP, GIF, AVIF and TIFF images",version:' +
    `"${sharpVersion}"`;
  if (!binaryContains(binaryPath, sharpFingerprint)) {
    fail("installed Claude binary Sharp fingerprint drifted from policy");
  }
  return {
    sdkVersion: policy.raw.sdk.version,
    platformPackageName,
    embeddedComponents: policy.embeddedComponents,
    mitigations: policy.mitigations,
  };
}

export function partitionMitigatedAdvisories(advisories, mitigations) {
  const active = [];
  const mitigated = [];
  for (const advisory of advisories) {
    const mitigation = mitigations.get(advisory.githubAdvisoryId);
    if (
      mitigation?.component === advisory.name &&
      mitigation.version === advisory.version
    ) {
      mitigated.push(advisory);
    } else {
      active.push(advisory);
    }
  }
  return { active, mitigated };
}
