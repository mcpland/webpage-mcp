#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

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
const DYNAMIC_CODE_IDENTIFIERS = new Map([
  ["eval", "direct eval capability"],
  ["Function", "Function constructor capability"],
  ["AsyncFunction", "async Function constructor capability"],
  ["GeneratorFunction", "generator Function constructor capability"],
  ["AsyncGeneratorFunction", "async generator Function constructor capability"],
]);
const GLOBAL_OBJECT_NAMES = new Set(["globalThis", "self", "window"]);

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

function staticPropertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? null;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticPropertyName(node.left);
    const right = staticPropertyName(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function dynamicCodeViolation(source) {
  let ast;
  try {
    ast = parse(source, {
      allowHashBang: true,
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch (error) {
    fail(
      `executable JavaScript cannot be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const globalAliases = new Set(GLOBAL_OBJECT_NAMES);
  const capabilityAliases = new Map();
  const nodes = [];

  function isGlobalObject(node) {
    return node?.type === "Identifier" && globalAliases.has(node.name);
  }

  function capability(node) {
    if (!node) return null;
    if (node.type === "Identifier") {
      const label = DYNAMIC_CODE_IDENTIFIERS.get(node.name);
      return label
        ? { index: node.start, label }
        : (capabilityAliases.get(node.name) ?? null);
    }
    if (node.type === "MemberExpression") {
      const propertyName = node.computed
        ? staticPropertyName(node.property)
        : node.property?.name;
      if (isGlobalObject(node.object)) {
        const label = DYNAMIC_CODE_IDENTIFIERS.get(propertyName);
        if (label) return { index: node.start, label };
      }
      if (
        propertyName === "call" ||
        propertyName === "apply" ||
        propertyName === "bind"
      ) {
        return capability(node.object);
      }
      return null;
    }
    if (node.type === "ChainExpression") return capability(node.expression);
    if (node.type === "SequenceExpression") {
      return capability(node.expressions.at(-1));
    }
    if (node.type === "AssignmentExpression") return capability(node.right);
    if (node.type === "LogicalExpression") {
      return capability(node.left) ?? capability(node.right);
    }
    if (node.type === "ConditionalExpression") {
      return capability(node.consequent) ?? capability(node.alternate);
    }
    return null;
  }

  function collect(node) {
    if (!node || typeof node !== "object") return;
    nodes.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(child)) {
        for (const entry of child) collect(entry);
      } else {
        collect(child);
      }
    }
  }
  collect(ast);

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      const alias =
        node.type === "VariableDeclarator" && node.id?.type === "Identifier"
          ? { name: node.id.name, value: node.init }
          : node.type === "AssignmentExpression" &&
              node.operator === "=" &&
              node.left?.type === "Identifier"
            ? { name: node.left.name, value: node.right }
            : null;
      if (
        alias &&
        isGlobalObject(alias.value) &&
        !globalAliases.has(alias.name)
      ) {
        globalAliases.add(alias.name);
        changed = true;
      }
    }
  }

  changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      const alias =
        node.type === "VariableDeclarator" && node.id?.type === "Identifier"
          ? { name: node.id.name, value: node.init }
          : node.type === "AssignmentExpression" &&
              node.operator === "=" &&
              node.left?.type === "Identifier"
            ? { name: node.left.name, value: node.right }
            : null;
      if (!alias || capabilityAliases.has(alias.name)) continue;
      const resolved = capability(alias.value);
      if (resolved) {
        capabilityAliases.set(alias.name, resolved);
        changed = true;
      }
    }
  }

  let violation = null;
  for (const node of nodes) {
    if (
      node.type === "CallExpression" ||
      node.type === "NewExpression" ||
      node.type === "TaggedTemplateExpression"
    ) {
      violation = capability(node.callee ?? node.tag);
    }
    if (
      !violation &&
      node.type === "CallExpression" &&
      node.callee?.type === "MemberExpression" &&
      node.callee.object?.type === "Identifier" &&
      node.callee.object.name === "Reflect" &&
      staticPropertyName(node.callee.property) === "construct"
    ) {
      violation = capability(node.arguments[0]);
    }
    if (violation) break;
  }

  if (!violation) return null;
  return {
    ...violation,
    byte: Buffer.byteLength(source.slice(0, violation.index)),
  };
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
    const dynamicCode = dynamicCodeViolation(source);
    if (dynamicCode) {
      fail(
        `${file.relativePath} contains ${dynamicCode.label} at byte ${dynamicCode.byte}`,
      );
    }
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
