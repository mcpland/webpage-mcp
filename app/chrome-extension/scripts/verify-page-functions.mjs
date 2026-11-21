#!/usr/bin/env node

// Functions that the extension serializes with Function.prototype.toString()
// and evaluates inside a page (for example the chrome_javascript result
// serializer sent through Runtime.callFunctionOn) must not depend on any
// binding of the extension bundle. Unit tests run those functions from source,
// so only the built artifact can prove that bundling/minification kept them
// self-contained. This script extracts each such function from the built
// background bundle and executes it in an empty VM context.

import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parse } from "acorn";

const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultBundleDir = resolve(scriptDir, "../.output/chrome-mv3");

const SERIALIZER_MARKER = "JavaScript result holder could not be read";

// Each case runs the bundled serializer against a holder shaped like the one
// produced by the chrome_javascript wrapper.
const SERIALIZER_CASES = [
  {
    name: "number result",
    holder: () => ({ __webpageMcpStatus: 1, __webpageMcpValue: 2 }),
    expect: (envelope) => envelope.status === "success" && envelope.text === "2",
  },
  {
    name: "object result",
    holder: () => ({
      __webpageMcpStatus: 1,
      __webpageMcpValue: { title: "Form", ids: ["a", "b"] },
    }),
    expect: (envelope) =>
      envelope.status === "success" &&
      envelope.text.includes('"title"') &&
      envelope.text.includes('"Form"'),
  },
  {
    name: "bigint result",
    holder: () => ({ __webpageMcpStatus: 1, __webpageMcpValue: 12n }),
    expect: (envelope) => envelope.status === "success",
  },
  {
    name: "thrown error",
    holder: (context) => ({
      __webpageMcpStatus: 0,
      __webpageMcpValue: vm.runInContext('new Error("boom")', context),
    }),
    expect: (envelope) =>
      envelope.status === "error" &&
      envelope.errorKind === "runtime_error" &&
      envelope.message.includes("boom"),
  },
];

function fail(message) {
  throw new Error(`[page-functions] ${message}`);
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== "string") return;
  visit(node, ancestors);
  ancestors.push(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    if (Array.isArray(child)) {
      for (const entry of child) walk(entry, visit, ancestors);
    } else if (child && typeof child.type === "string") {
      walk(child, visit, ancestors);
    }
  }
  ancestors.pop();
}

/**
 * Returns the source of the innermost non-arrow function that contains the
 * string literal `marker`.
 */
export function extractFunctionContaining(source, marker) {
  const ast = parse(source, {
    allowHashBang: true,
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const matches = [];
  walk(ast, (node, ancestors) => {
    if (node.type !== "Literal" || node.value !== marker) return;
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      const candidate = ancestors[index];
      if (
        candidate.type === "FunctionDeclaration" ||
        candidate.type === "FunctionExpression"
      ) {
        matches.push(candidate);
        return;
      }
    }
  });
  const unique = [...new Set(matches)];
  if (unique.length === 0) return null;
  if (unique.length > 1) {
    fail(`marker "${marker}" appears in ${unique.length} different functions`);
  }
  return source.slice(unique[0].start, unique[0].end);
}

export function verifySerializerSource(functionSource) {
  const failures = [];
  for (const testCase of SERIALIZER_CASES) {
    // A fresh context has only ECMAScript built-ins: any reference to a
    // bundle-scope helper surfaces as a ReferenceError inside the serializer.
    const context = vm.createContext(Object.create(null));
    let envelope;
    try {
      const serializer = vm.runInContext(`(${functionSource})`, context);
      envelope = serializer.call(testCase.holder(context), 4096);
    } catch (error) {
      failures.push(
        `${testCase.name}: threw ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!envelope || envelope.version !== 1 || !testCase.expect(envelope)) {
      failures.push(`${testCase.name}: unexpected envelope ${JSON.stringify(envelope)}`);
    }
  }
  return failures;
}

export async function verifyPageFunctions(options = {}) {
  const bundleDir = resolve(options.bundleDir ?? defaultBundleDir);
  const backgroundPath = join(bundleDir, "background.js");
  const stats = await lstat(backgroundPath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    fail("background.js must be a regular file");
  }
  if (stats.size > MAX_BUNDLE_BYTES) fail("background.js is too large");
  const source = await readFile(backgroundPath, "utf8");
  const serializer = extractFunctionContaining(source, SERIALIZER_MARKER);
  if (!serializer) {
    fail("chrome_javascript page serializer was not found in background.js");
  }
  const failures = verifySerializerSource(serializer);
  if (failures.length > 0) {
    fail(
      `chrome_javascript page serializer is not self-contained after bundling:\n  ${failures.join("\n  ")}`,
    );
  }
  return { functions: 1, cases: SERIALIZER_CASES.length };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  verifyPageFunctions({ bundleDir: process.argv[2] })
    .then(({ functions, cases }) => {
      console.log(
        `[page-functions] verified ${functions} page-serialized function (${cases} cases)`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
