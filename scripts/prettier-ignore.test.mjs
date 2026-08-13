import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function isIgnored(relativePath, ignorePath = ".prettierignore") {
  const result = await prettier.getFileInfo(
    path.join(repositoryRoot, relativePath),
    { ignorePath: path.join(repositoryRoot, ignorePath) },
  );
  return result.ignored;
}

test("canonical generated files stay outside staged formatting", async () => {
  for (const relativePath of [
    "pnpm-lock.yaml",
    "packages/wasm-simd/artifacts.json",
    "app/mcp-server/npm-shrinkwrap.json",
    "scripts/claude-sdk-runtime-policy.json",
  ]) {
    assert.equal(await isIgnored(relativePath), true, relativePath);
  }
});

test("staged source fixes do not trigger whole-file formatting churn", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(packageJson["lint-staged"]["**/*.{js,jsx,ts,tsx}"], [
    "eslint --fix",
  ]);
});

test("the large injected helper is ignored from either package scope", async () => {
  const relativePath =
    "app/chrome-extension/inject-scripts/accessibility-tree-helper.js";

  assert.equal(await isIgnored(relativePath), true);
  assert.equal(
    await isIgnored(relativePath, "app/chrome-extension/.prettierignore"),
    true,
  );
});
