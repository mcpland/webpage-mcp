import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SET_VERSION_SCRIPT = join(REPOSITORY_ROOT, "scripts/set-app-version.mjs");
const PACKAGE_PATHS = [
  "app/chrome-extension/package.json",
  "app/mcp-server/package.json",
];

async function createVersionRoot(t) {
  const rootDir = await mkdtemp(join(tmpdir(), "webpage-mcp-set-version-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  for (const packagePath of PACKAGE_PATHS) {
    const absolutePath = join(rootDir, packagePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(
      absolutePath,
      `${JSON.stringify({ name: packagePath, version: "1.2.3" }, null, 2)}\n`,
      "utf8",
    );
  }
  return rootDir;
}

function runSetVersion(rootDir, version) {
  return spawnSync(process.execPath, [SET_VERSION_SCRIPT, version], {
    cwd: rootDir,
    encoding: "utf8",
  });
}

async function readVersions(rootDir) {
  return Promise.all(
    PACKAGE_PATHS.map(async (packagePath) =>
      JSON.parse(await readFile(join(rootDir, packagePath), "utf8")),
    ),
  );
}

test("set-app-version accepts a stable Chrome-safe boundary", async (t) => {
  const rootDir = await createVersionRoot(t);
  const result = runSetVersion(rootDir, "65535.65535.65535");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    (await readVersions(rootDir)).map((pkg) => pkg.version),
    ["65535.65535.65535", "65535.65535.65535"],
  );
});

test("set-app-version rejects unsafe unified versions before writing", async (t) => {
  const rootDir = await createVersionRoot(t);
  const rejectedVersions = [
    ["1.2.3-rc.1", /prerelease versions are not supported/],
    ["1.2.3+build.1", /build metadata is not supported/],
    ["65536.0.1", /between 0 and 65535/],
    ["0.0.0", /cannot be 0\.0\.0/],
  ];

  for (const [version, expectedError] of rejectedVersions) {
    const result = runSetVersion(rootDir, version);
    assert.equal(result.status, 1, `${version} unexpectedly succeeded`);
    assert.match(result.stderr, expectedError);
    assert.deepEqual(
      (await readVersions(rootDir)).map((pkg) => pkg.version),
      ["1.2.3", "1.2.3"],
      `${version} must not partially update either package`,
    );
  }
});
