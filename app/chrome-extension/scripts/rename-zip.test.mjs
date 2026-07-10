import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renameZipArtifact } from "./rename-zip.mjs";

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "webpage-mcp-zip-"));
}

test("renameZipArtifact renames only the exact current WXT artifact", async (t) => {
  const outputDir = fixture();
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(outputDir, "webpage-mcp-connector-0.9.0-chrome.zip"),
    "current",
  );
  fs.writeFileSync(
    path.join(outputDir, "webpage-mcp-connector-9.9.9-chrome.zip"),
    "stale",
  );
  fs.writeFileSync(
    path.join(outputDir, "webpage-mcp-connector-0.9.0-chrome-extension.zip"),
    "old target",
  );

  const targetPath = await renameZipArtifact({
    outputDir,
    browser: "chrome",
    version: "0.9.0",
    packageName: "webpage-mcp-connector",
  });

  assert.equal(fs.readFileSync(targetPath, "utf8"), "current");
  assert.equal(
    fs.readFileSync(
      path.join(outputDir, "webpage-mcp-connector-9.9.9-chrome.zip"),
      "utf8",
    ),
    "stale",
  );
});

test("renameZipArtifact fails instead of falling back to a stale zip", async (t) => {
  const outputDir = fixture();
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(outputDir, "webpage-mcp-connector-9.9.9-chrome.zip"),
    "stale",
  );

  await assert.rejects(
    renameZipArtifact({
      outputDir,
      browser: "chrome",
      version: "0.9.0",
      packageName: "webpage-mcp-connector",
    }),
    /Expected current WXT artifact/,
  );
});

test("renameZipArtifact rejects path-like artifact fields", async (t) => {
  const outputDir = fixture();
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  await assert.rejects(
    renameZipArtifact({
      outputDir,
      browser: "../chrome",
      version: "0.9.0",
      packageName: "webpage-mcp-connector",
    }),
    /Invalid browser artifact name/,
  );
});
