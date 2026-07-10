#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_FILES = 5_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 32 * 1024 * 1024;
const EXECUTABLE_EXTENSIONS = new Set([".js", ".mjs"]);
const REQUIRED_LOCAL_ORT_FILES = [
  "libs/ort.min.js",
  "workers/ort-wasm-simd-threaded.mjs",
  "workers/ort-wasm-simd-threaded.wasm",
];
const FORBIDDEN_SOURCE = [
  ["direct eval", /\beval\s*\(/u],
  ["Function constructor", /\b(?:new\s+)?Function\s*\(/u],
  [
    "async/generator Function constructor",
    /\b(?:new\s+)?(?:AsyncFunction|GeneratorFunction|AsyncGeneratorFunction)\s*\(/u,
  ],
  [
    "Xenova jsDelivr runtime URL",
    /cdn\.jsdelivr\.net\/npm\/@xenova\/transformers/iu,
  ],
  [
    "remote executable URL",
    /https?:\/\/[^\s"'`<>()\\]+?\.(?:js|mjs|wasm)(?:[?#][^\s"'`<>()\\]*)?(?=[\s"'`<>()\\]|$)/iu,
  ],
  [
    "ONNX Runtime Web 1.14",
    /(?:ONNX\s+Runtime\s+Web|onnxruntime-web)(?:[^\n]{0,80})1\.14\.0\b/iu,
  ],
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultBundleDir = resolve(scriptDir, "../.output/chrome-mv3");

function fail(message) {
  throw new Error(`[bundle-code-policy] ${message}`);
}

async function requireRegularFile(filePath, label) {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch {
    fail(`${label} is missing`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail(`${label} must be a regular file`);
  }
  return stats;
}

async function collectFiles(bundleDir) {
  const rootStats = await lstat(bundleDir).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    fail(`${bundleDir} must be a real directory`);
  }

  const files = [];
  let totalBytes = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(bundleDir, absolutePath).replaceAll(
        "\\",
        "/",
      );
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) fail(`${relativePath} must not be a symlink`);
      if (stats.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stats.isFile()) fail(`${relativePath} must be a regular file`);
      if (relativePath.toLowerCase().includes(".jsep.")) {
        fail(`${relativePath} is a forbidden JSEP artifact`);
      }
      files.push({ absolutePath, relativePath, size: stats.size });
      if (files.length > MAX_FILES) fail(`bundle exceeds ${MAX_FILES} files`);
      totalBytes += stats.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        fail(`bundle exceeds the ${MAX_TOTAL_BYTES}-byte size limit`);
      }
    }
  }
  await visit(bundleDir);
  return files;
}

export async function verifyBundleCodePolicy(options = {}) {
  const bundleDir = resolve(options.bundleDir ?? defaultBundleDir);
  const manifestPath = join(bundleDir, "manifest.json");
  const manifestStats = await requireRegularFile(manifestPath, "manifest.json");
  if (manifestStats.size > 1024 * 1024) fail("manifest.json is too large");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(
      `manifest.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.manifest_version !== 3)
    fail("bundle must be Chrome Manifest V3");

  const files = await collectFiles(bundleDir);
  const paths = new Set(files.map((file) => file.relativePath));
  for (const requiredPath of REQUIRED_LOCAL_ORT_FILES) {
    if (!paths.has(requiredPath)) fail(`${requiredPath} is missing`);
  }

  let executableFiles = 0;
  for (const file of files) {
    if (!EXECUTABLE_EXTENSIONS.has(extname(file.relativePath).toLowerCase())) {
      continue;
    }
    executableFiles += 1;
    if (file.size > MAX_EXECUTABLE_BYTES) {
      fail(`${file.relativePath} exceeds the executable size limit`);
    }
    const source = await readFile(file.absolutePath, "utf8");
    for (const [label, pattern] of FORBIDDEN_SOURCE) {
      const match = pattern.exec(source);
      if (match)
        fail(`${file.relativePath} contains ${label} at byte ${match.index}`);
    }
  }

  return { files: files.length, executableFiles };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  verifyBundleCodePolicy({ bundleDir: process.argv[2] })
    .then(({ files, executableFiles }) => {
      console.log(
        `[bundle-code-policy] verified ${executableFiles} executable files (${files} total)`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
