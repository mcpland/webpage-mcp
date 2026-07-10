#!/usr/bin/env node

import { createHash } from "node:crypto";
import console from "node:console";
import { createReadStream } from "node:fs";
import { copyFile, lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACTS = 16;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 128 * 1024 * 1024;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultExtensionDir = resolve(scriptDir, "..");
const defaultRepoRoot = resolve(defaultExtensionDir, "../..");

function fail(message) {
  throw new Error(`[ort-artifacts] ${message}`);
}

async function readBoundedText(filePath, maximumBytes) {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail(`${filePath} must be a regular file`);
  }
  if (stats.size > maximumBytes) {
    fail(`${filePath} exceeds the ${maximumBytes}-byte metadata limit`);
  }
  return readFile(filePath, "utf8");
}

async function readBoundedJson(filePath, maximumBytes) {
  const text = await readBoundedText(filePath, maximumBytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(
      `${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateRelativePath(value, label, requiredPrefix) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.startsWith("../") ||
    !value.startsWith(requiredPrefix)
  ) {
    fail(`${label} must be a normalized ${requiredPrefix} relative path`);
  }
  return value;
}

function validateManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("artifact manifest must be an object");
  }
  if (raw.schemaVersion !== 1) fail("unsupported artifact manifest schema");
  if (raw.package !== "onnxruntime-web") fail("unexpected runtime package");
  if (typeof raw.version !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.version)) {
    fail("runtime version must be an exact stable semver");
  }
  const expectedSource = `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-${raw.version}.tgz`;
  if (raw.source !== expectedSource)
    fail("runtime source URL does not match the version");
  if (
    typeof raw.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(raw.integrity)
  ) {
    fail("runtime registry integrity is invalid");
  }
  if (raw.license !== "MIT") fail("runtime license must be recorded as MIT");
  if (
    !Array.isArray(raw.artifacts) ||
    raw.artifacts.length === 0 ||
    raw.artifacts.length > MAX_ARTIFACTS
  ) {
    fail(`artifact list must contain 1-${MAX_ARTIFACTS} entries`);
  }

  const sources = new Set();
  const targets = new Set();
  let totalBytes = 0;
  const artifacts = raw.artifacts.map((rawArtifact, index) => {
    if (
      !rawArtifact ||
      typeof rawArtifact !== "object" ||
      Array.isArray(rawArtifact)
    ) {
      fail(`artifact ${index} must be an object`);
    }
    const source = validateRelativePath(
      rawArtifact.source,
      `artifact ${index} source`,
      "dist/",
    );
    const targetPrefix = rawArtifact.target?.startsWith("public/")
      ? "public/"
      : "workers/";
    const target = validateRelativePath(
      rawArtifact.target,
      `artifact ${index} target`,
      targetPrefix,
    );
    if (sources.has(source) || targets.has(target)) {
      fail(`artifact ${index} duplicates a source or target`);
    }
    sources.add(source);
    targets.add(target);
    if (
      !Number.isSafeInteger(rawArtifact.bytes) ||
      rawArtifact.bytes <= 0 ||
      rawArtifact.bytes > MAX_ARTIFACT_BYTES
    ) {
      fail(`artifact ${index} has an invalid byte size`);
    }
    totalBytes += rawArtifact.bytes;
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      fail("artifact manifest exceeds the aggregate byte budget");
    }
    if (
      typeof rawArtifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(rawArtifact.sha256)
    ) {
      fail(`artifact ${index} has an invalid SHA-256 digest`);
    }
    return {
      source,
      target,
      bytes: rawArtifact.bytes,
      sha256: rawArtifact.sha256,
    };
  });

  return {
    package: raw.package,
    version: raw.version,
    integrity: raw.integrity,
    artifacts,
  };
}

async function inspectArtifact(filePath, expected, label) {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail(`${label} must be a regular file`);
  }
  if (stats.size !== expected.bytes) {
    fail(
      `${label} size mismatch: expected ${expected.bytes}, found ${stats.size}`,
    );
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  const digest = hash.digest("hex");
  if (digest !== expected.sha256) {
    fail(
      `${label} digest mismatch: expected ${expected.sha256}, found ${digest}`,
    );
  }
}

async function loadContext(options = {}) {
  const extensionDir = resolve(options.extensionDir ?? defaultExtensionDir);
  const manifestPath = resolve(
    options.manifestPath ?? join(extensionDir, "ort-artifacts.json"),
  );
  const packageDir = resolve(
    options.packageDir ?? join(extensionDir, "node_modules/onnxruntime-web"),
  );
  const lockfilePath = resolve(
    options.lockfilePath ?? join(defaultRepoRoot, "pnpm-lock.yaml"),
  );
  const manifest = validateManifest(
    await readBoundedJson(manifestPath, MAX_MANIFEST_BYTES),
  );
  const runtimePackage = await readBoundedJson(
    join(packageDir, "package.json"),
    MAX_PACKAGE_JSON_BYTES,
  );
  const extensionPackage = await readBoundedJson(
    join(extensionDir, "package.json"),
    MAX_PACKAGE_JSON_BYTES,
  );
  if (
    runtimePackage.name !== manifest.package ||
    runtimePackage.version !== manifest.version
  ) {
    fail("installed runtime package does not match the artifact manifest");
  }
  if (extensionPackage.dependencies?.[manifest.package] !== manifest.version) {
    fail(
      "extension must declare the runtime as an exact production dependency",
    );
  }
  const lockfile = await readBoundedText(lockfilePath, MAX_LOCKFILE_BYTES);
  const lockEntryMarker = `onnxruntime-web@${manifest.version}:`;
  let lockEntryOffset = lockfile.indexOf(lockEntryMarker);
  let lockedIntegrityMatches = false;
  while (lockEntryOffset >= 0) {
    const boundedEntry = lockfile.slice(lockEntryOffset, lockEntryOffset + 512);
    if (boundedEntry.includes(`integrity: ${manifest.integrity}`)) {
      lockedIntegrityMatches = true;
      break;
    }
    lockEntryOffset = lockfile.indexOf(
      lockEntryMarker,
      lockEntryOffset + lockEntryMarker.length,
    );
  }
  if (!lockedIntegrityMatches) {
    fail(
      "pnpm lockfile does not contain the recorded runtime version and integrity",
    );
  }
  return { extensionDir, packageDir, manifest };
}

export async function verifyOrtArtifacts(options = {}) {
  const { extensionDir, packageDir, manifest } = await loadContext(options);
  for (const artifact of manifest.artifacts) {
    await inspectArtifact(
      join(packageDir, artifact.source),
      artifact,
      `package ${artifact.source}`,
    );
    await inspectArtifact(
      join(extensionDir, artifact.target),
      artifact,
      `tracked ${artifact.target}`,
    );
  }
  return manifest.artifacts.length;
}

export async function copyOrtArtifacts(options = {}) {
  const { extensionDir, packageDir, manifest } = await loadContext(options);
  for (const artifact of manifest.artifacts) {
    const sourcePath = join(packageDir, artifact.source);
    await inspectArtifact(sourcePath, artifact, `package ${artifact.source}`);
    await copyFile(sourcePath, join(extensionDir, artifact.target));
  }
  await verifyOrtArtifacts(options);
  return manifest.artifacts.length;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const command = process.argv[2];
  const count =
    command === "verify"
      ? await verifyOrtArtifacts()
      : command === "copy"
        ? await copyOrtArtifacts()
        : fail("usage: ort-artifacts.mjs <verify|copy>");
  console.log(`[ort-artifacts] ${command} verified ${count} pinned files`);
}
