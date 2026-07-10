import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyOrtArtifacts, verifyOrtArtifacts } from "./ort-artifacts.mjs";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function fixture({ trackedContents = "runtime" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webpage-mcp-ort-"));
  const extensionDir = path.join(root, "extension");
  const packageDir = path.join(root, "runtime-package");
  const manifestPath = path.join(extensionDir, "ort-artifacts.json");
  const lockfilePath = path.join(root, "pnpm-lock.yaml");
  const sourceContents = "runtime";
  fs.mkdirSync(path.join(extensionDir, "public/libs"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "dist/ort.min.js"), sourceContents);
  fs.writeFileSync(
    path.join(extensionDir, "public/libs/ort.min.js"),
    trackedContents,
  );
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "onnxruntime-web", version: "1.22.0" }),
  );
  fs.writeFileSync(
    path.join(extensionDir, "package.json"),
    JSON.stringify({ dependencies: { "onnxruntime-web": "1.22.0" } }),
  );
  const integrity = `sha512-${Buffer.from("registry integrity").toString("base64")}`;
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      package: "onnxruntime-web",
      version: "1.22.0",
      source:
        "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.22.0.tgz",
      integrity,
      license: "MIT",
      artifacts: [
        {
          source: "dist/ort.min.js",
          target: "public/libs/ort.min.js",
          bytes: Buffer.byteLength(sourceContents),
          sha256: sha256(sourceContents),
        },
      ],
    }),
  );
  fs.writeFileSync(
    lockfilePath,
    `onnxruntime-web@1.22.0:\n    resolution: {integrity: ${integrity}}\n`,
  );
  return { root, extensionDir, packageDir, manifestPath, lockfilePath };
}

test("verifyOrtArtifacts binds tracked files to the exact locked package", async (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));

  await assert.doesNotReject(verifyOrtArtifacts(paths));
});

test("verifyOrtArtifacts rejects a modified vendored runtime", async (t) => {
  const paths = fixture({ trackedContents: "tampered" });
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));

  await assert.rejects(
    verifyOrtArtifacts(paths),
    /size mismatch|digest mismatch/,
  );
});

test("copyOrtArtifacts restores only manifest-pinned package bytes", async (t) => {
  const paths = fixture({ trackedContents: "tampered" });
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));

  assert.equal(await copyOrtArtifacts(paths), 1);
  assert.equal(
    fs.readFileSync(
      path.join(paths.extensionDir, "public/libs/ort.min.js"),
      "utf8",
    ),
    "runtime",
  );
});

test("verifyOrtArtifacts rejects traversal", async (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8"));
  manifest.artifacts[0].target = "../outside.js";
  fs.writeFileSync(paths.manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    verifyOrtArtifacts(paths),
    /normalized .* relative path/,
  );
});

test("verifyOrtArtifacts rejects installed package version drift", async (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(paths.packageDir, "package.json"),
    JSON.stringify({ name: "onnxruntime-web", version: "1.22.1" }),
  );

  await assert.rejects(
    verifyOrtArtifacts(paths),
    /installed runtime package does not match/,
  );
});
