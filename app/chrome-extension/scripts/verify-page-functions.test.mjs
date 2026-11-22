import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractFunctionContaining,
  verifyPageFunctions,
} from "./verify-page-functions.mjs";

// Minimal stand-in for the bundled serializer: same holder contract and the
// same marker literal the verifier uses to locate it.
const SELF_CONTAINED_SERIALIZER = `function I_(t) {
  try {
    let s, v;
    try { s = this.__webpageMcpStatus; v = this.__webpageMcpValue; }
    catch (e) { return { version: 1, status: "error", errorKind: "serialization_error", message: "JavaScript result holder could not be read" }; }
    if (s === 0) return { version: 1, status: "error", errorKind: "runtime_error", message: String(v && v.message) };
    const text = typeof v === "bigint" ? String(v) : JSON.stringify(v);
    return { version: 1, status: "success", text, truncated: false, redacted: false };
  } catch (e) {
    return { version: 1, status: "error", errorKind: "serialization_error", message: "Bounded page serialization failed" };
  }
}`;

function fixture(source) {
  const bundleDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "webpage-mcp-page-functions-"),
  );
  fs.writeFileSync(path.join(bundleDir, "background.js"), source);
  return bundleDir;
}

test("accepts a self-contained page serializer", async (t) => {
  const bundleDir = fixture(
    `var bn = Math.pow;\n${SELF_CONTAINED_SERIALIZER}\nconst B_ = I_.toString();`,
  );
  t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
  await assert.doesNotReject(verifyPageFunctions({ bundleDir }));
});

test("rejects a serializer that depends on a bundle-scope helper", async (t) => {
  // This is what an es2015 target produced for `10n ** 4096n`.
  const lowered = SELF_CONTAINED_SERIALIZER.replace(
    "try {\n    let s, v;",
    "try {\n    const g = bn(BigInt(10), BigInt(4096));\n    let s, v;",
  );
  const bundleDir = fixture(`var bn = Math.pow;\n${lowered}\nconst B_ = I_.toString();`);
  t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
  await assert.rejects(
    verifyPageFunctions({ bundleDir }),
    /not self-contained after bundling/,
  );
});

test("catches bundle-scope helpers in unexercised serializer branches statically", async (t) => {
  const branchLeak = SELF_CONTAINED_SERIALIZER.replace(
    "if (s === 0)",
    "if (s === 999) return bundleHelper(v);\n    if (s === 0)",
  );
  const bundleDir = fixture(
    `function bundleHelper(x) { return x; }\n${branchLeak}\nconst B_ = I_.toString();`,
  );
  t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
  await assert.rejects(
    verifyPageFunctions({ bundleDir }),
    /static free-variable check.*bundleHelper/,
  );
});

test("rejects executeScript({ func }) callbacks that reference bundle-scope helpers", async (t) => {
  const bundleDir = fixture(
    [
      SELF_CONTAINED_SERIALIZER,
      "function helper(x) { return x + 1; }",
      "chrome.scripting.executeScript({ target: { tabId: 1 }, func: (v) => helper(v) + document.title.length, args: [1] });",
    ].join("\n"),
  );
  t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
  await assert.rejects(
    verifyPageFunctions({ bundleDir }),
    /executeScript func is not self-contained.*helper/s,
  );
});

test("accepts self-contained executeScript({ func }) callbacks using browser globals", async (t) => {
  const bundleDir = fixture(
    [
      SELF_CONTAINED_SERIALIZER,
      "function pageProbe(sel) { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().width : 0; }",
      "chrome.scripting.executeScript({ target: { tabId: 1 }, func: pageProbe, args: ['#app'] });",
      "chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => window.scrollY + document.body.children.length });",
    ].join("\n"),
  );
  t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
  const summary = await verifyPageFunctions({ bundleDir });
  assert.equal(summary.functions, 3);
});

test("fails when the serializer cannot be located", async (t) => {
  const bundleDir = fixture("export const unrelated = 1;");
  t.after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
  await assert.rejects(verifyPageFunctions({ bundleDir }), /was not found/);
});

test("extracts the innermost non-arrow function around the marker", () => {
  const source = `function outer(){ return function inner(){ const f = () => "M"; return f; }; }`;
  assert.equal(
    extractFunctionContaining(source, "M"),
    'function inner(){ const f = () => "M"; return f; }',
  );
});
