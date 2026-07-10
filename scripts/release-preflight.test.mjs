import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  verifyReleaseArtifacts,
  verifyReleaseMetadata,
} from "./release-preflight.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "1.2.3";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createReleaseRoot(t, versions = {}) {
  const rootDir = await mkdtemp(
    join(tmpdir(), "webpage-mcp-release-preflight-"),
  );
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await writeJson(join(rootDir, "app/mcp-server/package.json"), {
    name: "webpage-mcp",
    version: versions.mcp ?? VERSION,
  });
  await writeJson(join(rootDir, "app/chrome-extension/package.json"), {
    name: "webpage-mcp-connector",
    version: versions.extension ?? VERSION,
  });
  return rootDir;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createArtifacts(rootDir, overrides = {}) {
  const artifactsDir = join(rootDir, "artifacts");
  const stagingDir = join(rootDir, "staging");
  const mcpPath = `mcp/webpage-mcp-${VERSION}.tgz`;
  const extensionPath = `extension/webpage-mcp-connector-${VERSION}-chrome-extension.zip`;
  await mkdir(join(artifactsDir, "mcp"), { recursive: true });
  await mkdir(join(artifactsDir, "extension"), { recursive: true });
  await writeJson(join(stagingDir, "package/package.json"), {
    name: "webpage-mcp",
    version: overrides.mcpVersion ?? VERSION,
  });
  await writeJson(join(stagingDir, "manifest.json"), {
    version: overrides.extensionVersion ?? VERSION,
  });

  execFileSync("tar", [
    "-czf",
    join(artifactsDir, mcpPath),
    "-C",
    stagingDir,
    "package/package.json",
  ]);
  execFileSync("zip", [
    "-q",
    "-j",
    join(artifactsDir, extensionPath),
    join(stagingDir, "manifest.json"),
  ]);

  const mcpArchive = await readFile(join(artifactsDir, mcpPath));
  const extensionArchive = await readFile(join(artifactsDir, extensionPath));
  await writeFile(
    join(artifactsDir, "SHA256SUMS.txt"),
    `${sha256(extensionArchive)}  ./${extensionPath}\n${sha256(mcpArchive)}  ./${mcpPath}\n`,
    "utf8",
  );
  return { artifactsDir };
}

test("release metadata requires aligned package and tag versions", async (t) => {
  const rootDir = await createReleaseRoot(t);
  const result = await verifyReleaseMetadata({ rootDir, tag: `v${VERSION}` });
  assert.equal(result.version, VERSION);

  await assert.rejects(
    verifyReleaseMetadata({ rootDir, tag: "release-1.2.3" }),
    /v<version>/,
  );
  await assert.rejects(
    verifyReleaseMetadata({ rootDir, tag: "v1.2.4" }),
    /does not match package version/,
  );

  await writeJson(join(rootDir, "app/chrome-extension/package.json"), {
    name: "webpage-mcp-connector",
    version: "1.2.4",
  });
  await assert.rejects(
    verifyReleaseMetadata({ rootDir }),
    /Release package versions must match/,
  );
});

test("release artifacts must contain matching package metadata and checksums", async (t) => {
  const rootDir = await createReleaseRoot(t);
  const { artifactsDir } = await createArtifacts(rootDir);

  const result = await verifyReleaseArtifacts({
    rootDir,
    artifactsDir,
    tag: `v${VERSION}`,
  });
  assert.equal(result.version, VERSION);
  assert.deepEqual(result.files, [
    "SHA256SUMS.txt",
    `extension/webpage-mcp-connector-${VERSION}-chrome-extension.zip`,
    `mcp/webpage-mcp-${VERSION}.tgz`,
  ]);
});

test("release artifact verification fails closed", async (t) => {
  await t.test("on an unexpected file", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir } = await createArtifacts(rootDir);
    await writeFile(join(artifactsDir, "unexpected.txt"), "unexpected");
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /artifact set does not match expectations/,
    );
  });

  await t.test("on mismatched embedded metadata", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir } = await createArtifacts(rootDir, {
      extensionVersion: "1.2.4",
    });
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /Extension manifest version 1\.2\.4 does not match release version 1\.2\.3/,
    );
  });

  await t.test("on a corrupt checksum", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir } = await createArtifacts(rootDir);
    const checksumPath = join(artifactsDir, "SHA256SUMS.txt");
    const checksums = await readFile(checksumPath, "utf8");
    await writeFile(
      checksumPath,
      checksums.replace(/^[a-f0-9]/, (character) =>
        character === "0" ? "1" : "0",
      ),
      "utf8",
    );
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /SHA-256 mismatch/,
    );
  });
});

test("release workflow verifies before either publish mutation", async () => {
  const workflow = await readFile(
    join(REPOSITORY_ROOT, ".github/workflows/release.yml"),
    "utf8",
  );
  const buildJob = workflow.indexOf("  build-assets:");
  const artifactPreflight = workflow.indexOf(
    "      - name: Verify release artifacts",
    buildJob,
  );
  const githubJob = workflow.indexOf("  publish-github-release:");
  const buildJobBody = workflow.slice(buildJob, githubJob);
  const githubPublish = workflow.indexOf(
    "uses: softprops/action-gh-release@v2",
    githubJob,
  );
  const npmJob = workflow.indexOf("  publish-npm:");
  const npmPreflight = workflow.indexOf(
    "      - name: Reverify release metadata and artifacts",
    npmJob,
  );
  const npmPublish = workflow.indexOf('          npm publish "', npmJob);

  assert.ok(
    buildJob >= 0 && artifactPreflight > buildJob,
    "build job must run artifact preflight",
  );
  assert.match(
    buildJobBody,
    /ENFORCE_COVERAGE:\s*["']true["']/,
    "release tests must enforce production coverage thresholds",
  );
  assert.match(
    buildJobBody,
    /pnpm test:workspace/,
    "release tests must include cross-platform workspace scripts",
  );
  assert.match(
    buildJobBody,
    /cargo test --manifest-path packages\/wasm-simd\/Cargo\.toml --locked/,
    "release verification must run locked Rust tests",
  );
  assert.match(
    buildJobBody,
    /pnpm verify:wasm/,
    "release verification must rebuild and compare committed WASM artifacts",
  );
  assert.ok(
    buildJobBody.indexOf("pnpm verify:wasm") <
      buildJobBody.indexOf("Pack MCP npm package"),
    "WASM verification must finish before release artifacts are packed",
  );
  assert.ok(
    githubJob > artifactPreflight,
    "GitHub release job must follow artifact preflight",
  );
  assert.ok(
    githubPublish > githubJob,
    "GitHub release mutation must stay in the gated job",
  );
  assert.match(
    workflow.slice(githubJob, githubPublish),
    /needs: build-assets[\s\S]*Reverify release metadata and artifacts/,
  );
  assert.ok(
    npmPreflight > npmJob && npmPublish > npmPreflight,
    "npm publish must follow preflight",
  );
  assert.match(
    workflow.slice(npmJob, npmPublish + 300),
    /DIST_TAG=.*npm-dist-tag\.mjs[\s\S]*npm publish[\s\S]*--tag "\$DIST_TAG"/,
    "npm prereleases must use an explicit semver-derived dist-tag",
  );
  assert.doesNotMatch(
    buildJobBody,
    /action-gh-release|npm publish/,
    "build and verification must not mutate a release",
  );
});
