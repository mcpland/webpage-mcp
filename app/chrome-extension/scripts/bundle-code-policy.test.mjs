import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyBundleCodePolicy } from "./bundle-code-policy.mjs";

function fixture(source = "const destructorFunction = () => true;") {
  const bundleDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "webpage-mcp-bundle-policy-"),
  );
  fs.mkdirSync(path.join(bundleDir, "libs"));
  fs.mkdirSync(path.join(bundleDir, "workers"));
  fs.writeFileSync(
    path.join(bundleDir, "manifest.json"),
    JSON.stringify({ manifest_version: 3 }),
  );
  fs.writeFileSync(path.join(bundleDir, "background.js"), source);
  fs.writeFileSync(path.join(bundleDir, "libs/ort.min.js"), "export {};");
  fs.writeFileSync(
    path.join(bundleDir, "workers/ort-wasm-simd-threaded.mjs"),
    "export {};",
  );
  fs.writeFileSync(
    path.join(bundleDir, "workers/ort-wasm-simd-threaded.wasm"),
    "wasm",
  );
  return bundleDir;
}

test("accepts a local, static Manifest V3 bundle", async (t) => {
  const bundleDir = fixture();
  t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
  await assert.doesNotReject(verifyBundleCodePolicy({ bundleDir }));
});

for (const [name, source, expected] of [
  ["direct eval", "eval('x')", /direct eval/],
  ["indirect eval", "(0, eval)('x')", /direct eval/],
  ["Function constructor", "new Function('x')", /Function constructor/],
  ["bare Function constructor", "Function('x')", /Function constructor/],
  [
    "aliased Function constructor",
    "const F = Function; F('x')",
    /Function constructor/,
  ],
  [
    "computed global Function constructor",
    "globalThis['Fun' + 'ction']('x')",
    /Function constructor/,
  ],
  [
    "AsyncFunction constructor",
    "new AsyncFunction('x')",
    /Function constructor/,
  ],
  [
    "Xenova remote WASM default",
    "'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/'",
    /Xenova jsDelivr/,
  ],
  [
    "remote executable URL",
    "'https://example.test/runtime.wasm'",
    /remote executable URL/,
  ],
  ["legacy ORT", "/* ONNX Runtime Web v1.14.0 */", /ONNX Runtime Web 1.14/],
]) {
  test(`rejects ${name}`, async (t) => {
    const bundleDir = fixture(source);
    t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
    await assert.rejects(verifyBundleCodePolicy({ bundleDir }), expected);
  });
}

test("allows non-executing Function identity and property names", async (t) => {
  const bundleDir = fixture(
    "const isFunction = value instanceof Function; registry.Function;",
  );
  t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
  await assert.doesNotReject(verifyBundleCodePolicy({ bundleDir }));
});

test("rejects unparseable executable JavaScript", async (t) => {
  const bundleDir = fixture("const broken = ;");
  t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
  await assert.rejects(
    verifyBundleCodePolicy({ bundleDir }),
    /cannot be parsed/,
  );
});

test("rejects JSEP artifacts", async (t) => {
  const bundleDir = fixture();
  t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(bundleDir, "workers/ort-wasm-simd-threaded.jsep.mjs"),
    "export {};",
  );
  await assert.rejects(verifyBundleCodePolicy({ bundleDir }), /JSEP artifact/);
});

test("rejects symlinks", async (t) => {
  const bundleDir = fixture();
  t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
  fs.symlinkSync("background.js", path.join(bundleDir, "linked.js"));
  await assert.rejects(verifyBundleCodePolicy({ bundleDir }), /symlink/);
});
