import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";
import { gzipSync } from "node:zlib";

import {
  collectProductionClosure,
  downloadVerifiedTarball,
  extractNpmTarballEntries,
  formatPnpmListFailure,
  parsePnpmLockIntegrities,
  parseReviewedInventory,
  readExistingInventoryForRefresh,
  readVerifiedCachedTarball,
  tarballTransportUrls,
  verifyReviewedInventory,
} from "./npm-license-inventory.mjs";

const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const RESOLVED =
  "https://registry.npmjs.org/safe-package/-/safe-package-1.0.0.tgz";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createTarGzip(entries) {
  const records = [];
  for (const [name, contents] of Object.entries(entries)) {
    const body = Buffer.from(contents);
    const header = Buffer.alloc(512);
    header.write(name, 0, Math.min(100, Buffer.byteLength(name)));
    const writeOctal = (offset, length, value) =>
      header.write(
        `${value.toString(8).padStart(length - 1, "0")}\0`,
        offset,
        length,
        "utf8",
      );
    writeOctal(100, 8, 0o644);
    writeOctal(108, 8, 0);
    writeOctal(116, 8, 0);
    writeOctal(124, 12, body.length);
    writeOctal(136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    records.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  records.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(records));
}

function listOutput({ path, optionalPath, includeStale = false } = {}) {
  return JSON.stringify([
    {
      name: "webpage-mcp",
      version: "0.9.0",
      dependencies: {
        "safe-package": {
          version: "1.0.0",
          resolved: RESOLVED,
          ...(path ? { path } : {}),
        },
        ...(includeStale
          ? {
              stale: {
                version: "2.0.0",
                resolved: "https://registry.npmjs.org/stale/-/stale-2.0.0.tgz",
              },
            }
          : {}),
      },
      ...(optionalPath
        ? {
            optionalDependencies: {
              "safe-package": {
                version: "1.0.0",
                resolved: RESOLVED,
                path: optionalPath,
              },
            },
          }
        : {}),
    },
  ]);
}

function lockfile(integrity = INTEGRITY) {
  return `lockfileVersion: '9.0'\n\npackages:\n\n  safe-package@1.0.0:\n    resolution: {integrity: ${integrity}}\n\nsnapshots:\n\n  safe-package@1.0.0: {}\n`;
}

function inventoryComponent({
  packageJsonSha256 = "1".repeat(64),
  evidenceSha256 = "2".repeat(64),
  resolved = RESOLVED,
  integrity = INTEGRITY,
} = {}) {
  return {
    name: "safe-package",
    version: "1.0.0",
    resolved,
    integrity,
    declaredLicense: "MIT",
    concludedLicense: "MIT",
    packageJsonSha256,
    licenseEvidence: [{ path: "LICENSE", sha256: evidenceSha256 }],
    sourceUrl: "https://github.com/example/safe-package",
    patch: null,
    review: [],
  };
}

function inventoryBytes(component = inventoryComponent()) {
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifact: "mcp",
        importer: "app/mcp-server",
        scope: "npm-runtime-and-bundled-closure",
        firstPartyWorkspacePackages: [],
        components: [component],
      },
      null,
      2,
    )}\n`,
  );
}

test("production closure includes transitive graph nodes and only reviewed workspace links", async () => {
  const source = JSON.stringify([
    {
      name: "webpage-mcp-connector",
      dependencies: {
        "webpage-mcp-shared": {
          version: "link:../../packages/shared",
          dependencies: {
            "safe-package": {
              version: "1.0.0",
              resolved: RESOLVED,
              dependencies: {
                nested: {
                  version: "2.3.4",
                  resolved:
                    "https://registry.npmjs.org/nested/-/nested-2.3.4.tgz",
                },
              },
            },
          },
        },
      },
    },
  ]);
  const closure = await collectProductionClosure({
    artifactName: "extension",
    listOutput: source,
  });
  assert.deepEqual([...closure.components.keys()].sort(), [
    "nested@2.3.4",
    "safe-package@1.0.0",
  ]);
  assert.deepEqual(
    [...closure.firstPartyWorkspacePackages],
    ["webpage-mcp-shared"],
  );

  const unreviewed = source.replace(
    "webpage-mcp-shared",
    "unreviewed-workspace",
  );
  await assert.rejects(
    collectProductionClosure({
      artifactName: "extension",
      listOutput: unreviewed,
    }),
    /unreviewed workspace dependency/,
  );
});

test("lock integrity parser is bounded and rejects duplicate identities", () => {
  const parsed = parsePnpmLockIntegrities(lockfile());
  assert.equal(parsed.get("safe-package@1.0.0"), INTEGRITY);
  assert.throws(
    () =>
      parsePnpmLockIntegrities(
        lockfile().replace(
          "\nsnapshots:",
          `\n  safe-package@1.0.0:\n    resolution: {integrity: ${INTEGRITY}}\n\nsnapshots:`,
        ),
      ),
    /repeats package integrity/,
  );
});

test("reviewed inventory rejects non-canonical, nested, credentialed, and unreviewed data", () => {
  const nestedEvidence = inventoryComponent();
  nestedEvidence.licenseEvidence[0].path = "licenses/LICENSE";
  assert.throws(
    () => parseReviewedInventory(inventoryBytes(nestedEvidence), "mcp"),
    /single package-root filename/,
  );

  const credentialed = inventoryComponent({
    resolved:
      "https://registry-user:synthetic-secret@registry.npmjs.org/safe-package/-/safe-package-1.0.0.tgz",
  });
  let credentialError;
  try {
    parseReviewedInventory(inventoryBytes(credentialed), "mcp");
  } catch (error) {
    credentialError = error;
  }
  assert.match(credentialError.message, /credential-free HTTPS URL/);
  assert.doesNotMatch(credentialError.message, /synthetic-secret/);

  const unknownLicense = inventoryComponent();
  unknownLicense.declaredLicense = "UNKNOWN";
  unknownLicense.concludedLicense = "UNKNOWN";
  assert.throws(
    () => parseReviewedInventory(inventoryBytes(unknownLicense), "mcp"),
    /unreviewed license/,
  );

  const nonCanonical = inventoryBytes()
    .toString("utf8")
    .replace(/\n {2}/, "\n    ");
  assert.throws(
    () => parseReviewedInventory(Buffer.from(nonCanonical), "mcp"),
    /canonical JSON form|invalid JSON/,
  );
});

test("pnpm failures report only fixed diagnostics and byte counts", () => {
  const secret = "synthetic-registry-token";
  const message = formatPnpmListFailure(
    "webpage-mcp",
    {
      code: "ERR_TEST",
      signal: "SIGTERM",
      message: `command leaked ${secret}`,
      stack: `stack leaked ${secret}`,
    },
    `registry stderr leaked ${secret}`,
  );
  assert.match(
    message,
    /code=ERR_TEST, signal=SIGTERM, stderrBytes=\d+; contents withheld/,
  );
  assert.doesNotMatch(message, new RegExp(secret));
});

test("refresh snapshots reject symlinks and oversized existing inventories", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "npm-license-refresh-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const outside = join(rootDir, "outside-secret");
  const linked = join(rootDir, "linked-inventory.json");
  await writeFile(outside, "synthetic-secret");
  await symlink(outside, linked);
  await assert.rejects(
    readExistingInventoryForRefresh(linked),
    /regular non-symlink file/,
  );

  const oversized = join(rootDir, "oversized-inventory.json");
  await writeFile(oversized, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(
    readExistingInventoryForRefresh(oversized),
    /bounded refresh size/,
  );
});

test("tar evidence cache retains only bounded legal metadata", () => {
  const archive = createTarGzip({
    "package/package.json": '{"name":"safe-package"}\n',
    "package/LICENSE": "license\n",
    "package/README.md": "readme\n",
    "package/root-binary.bin": Buffer.alloc(1024 * 1024, 7),
    "package/dist/nested-license.txt": "not package-root evidence\n",
  });
  const { entries, retainedBytes } = extractNpmTarballEntries(
    archive,
    "synthetic package",
  );
  assert.deepEqual([...entries.keys()].sort(), [
    "package/LICENSE",
    "package/README.md",
    "package/package.json",
  ]);
  assert.ok(retainedBytes < 1024);

  const oversized = createTarGzip({
    "package/package.json": "{}",
    "package/LICENSE": Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  assert.throws(
    () => extractNpmTarballEntries(oversized, "oversized package"),
    /retained legal metadata exceeds its byte limit/,
  );

  const definitelyTypedArchive = createTarGzip({
    "better-sqlite3/package.json":
      '{"name":"@types/better-sqlite3","version":"7.6.13"}\n',
    "better-sqlite3/LICENSE": "license\n",
  });
  const definitelyTyped = extractNpmTarballEntries(
    definitelyTypedArchive,
    "DefinitelyTyped package",
    { packageName: "@types/better-sqlite3" },
  );
  assert.deepEqual([...definitelyTyped.entries.keys()].sort(), [
    "package/LICENSE",
    "package/package.json",
  ]);

  const dualRoot = createTarGzip({
    "package/package.json":
      '{"name":"@types/better-sqlite3","version":"7.6.13"}\n',
    "better-sqlite3/package.json":
      '{"name":"@types/better-sqlite3","version":"7.6.13"}\n',
  });
  assert.throws(
    () =>
      extractNpmTarballEntries(dualRoot, "dual-root package", {
        packageName: "@types/better-sqlite3",
      }),
    /exactly one reviewed package root/,
  );

  const alternateRoot = createTarGzip({
    "unexpected/package.json": '{"name":"safe-package","version":"1.0.0"}\n',
  });
  assert.throws(
    () => extractNpmTarballEntries(alternateRoot, "alternate-root package"),
    /exactly one reviewed package root/,
  );

  const versionedNodeTypes = createTarGzip({
    "node v22.19/package.json": '{"name":"@types/node","version":"22.19.11"}\n',
    "node v22.19/LICENSE": "license\n",
  });
  const nodeTypes = extractNpmTarballEntries(
    versionedNodeTypes,
    "versioned @types/node package",
    { packageName: "@types/node", packageVersion: "22.19.11" },
  );
  assert.deepEqual([...nodeTypes.entries.keys()].sort(), [
    "package/LICENSE",
    "package/package.json",
  ]);

  assert.throws(
    () =>
      extractNpmTarballEntries(
        versionedNodeTypes,
        "wrong-version @types/node package",
        { packageName: "@types/node", packageVersion: "22.18.0" },
      ),
    /exactly one reviewed package root/,
  );

  assert.throws(
    () =>
      extractNpmTarballEntries(
        versionedNodeTypes,
        "prerelease @types/node package",
        { packageName: "@types/node", packageVersion: "22.19.11-rc.1" },
      ),
    /unsupported DefinitelyTyped version/,
  );

  const dualRootNodeTypes = createTarGzip({
    "package/package.json": '{"name":"@types/node","version":"22.19.11"}\n',
    "node v22.19/package.json": '{"name":"@types/node","version":"22.19.11"}\n',
  });
  assert.throws(
    () =>
      extractNpmTarballEntries(
        dualRootNodeTypes,
        "dual-root @types/node package",
        { packageName: "@types/node", packageVersion: "22.19.11" },
      ),
    /exactly one reviewed package root/,
  );

  const versionedReactTypes = createTarGzip({
    "react v18.3/package.json": '{"name":"@types/react","version":"18.3.28"}\n',
  });
  assert.doesNotThrow(() =>
    extractNpmTarballEntries(
      versionedReactTypes,
      "versioned @types/react package",
      { packageName: "@types/react", packageVersion: "18.3.28" },
    ),
  );
});

test("npm cacache content is rehashed against the lock integrity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "npm-license-cacache-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = createTarGzip({
    "package/package.json": '{"name":"safe-package"}\n',
    "package/LICENSE": "license\n",
  });
  const digest = createHash("sha512").update(contents).digest();
  const integrity = `sha512-${digest.toString("base64")}`;
  const hex = digest.toString("hex");
  const cachePath = join(
    root,
    "_cacache/content-v2/sha512",
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4),
  );
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, contents);
  const budget = { bytes: 0 };
  const loaded = await readVerifiedCachedTarball({
    integrity,
    budget,
    description: "safe-package@1.0.0",
    cacheDirectories: [root],
  });
  assert.deepEqual(loaded, contents);
  assert.equal(budget.bytes, contents.length);
  assert.equal(budget.cacheBytes, contents.length);

  await writeFile(cachePath, Buffer.from(contents).fill(0, 0, 1));
  await assert.rejects(
    readVerifiedCachedTarball({
      integrity,
      budget: { bytes: 0 },
      description: "safe-package@1.0.0",
      cacheDirectories: [root],
    }),
    /does not match lock integrity/,
  );

  await rm(cachePath);
  const symlinkTarget = join(root, "cache-symlink-target");
  await writeFile(symlinkTarget, contents);
  await symlink(symlinkTarget, cachePath);
  await assert.rejects(
    readVerifiedCachedTarball({
      integrity,
      budget: { bytes: 0 },
      description: "safe-package@1.0.0",
      cacheDirectories: [root],
    }),
    /cannot be opened safely|regular non-symlink file/,
  );
});

test("transport mirror bytes are budgeted, never persisted, and require lock integrity", async () => {
  const component = {
    name: "safe-package",
    version: "1.0.0",
    resolved: RESOLVED,
  };
  const original = globalThis.structuredClone(component);
  assert.deepEqual(tarballTransportUrls(component), [
    "https://registry.npmmirror.com/safe-package/-/safe-package-1.0.0.tgz",
    RESOLVED,
  ]);
  assert.throws(
    () =>
      tarballTransportUrls({
        ...component,
        resolved:
          "https://registry.npmjs.org/safe-package/-/safe-package-2.0.0.tgz",
      }),
    /canonical npm registry tarball URL/,
  );
  const wrong = Buffer.from("mirror mismatch");
  const correct = Buffer.from("canonical verified tarball");
  const integrity = `sha512-${createHash("sha512").update(correct).digest("base64")}`;
  const requested = [];
  const budget = { bytes: 0 };
  const transportState = { mirrorEnabled: true };
  const result = await downloadVerifiedTarball(component, integrity, budget, {
    transportState,
    fetchImpl: async (url, options) => {
      requested.push({ url, redirect: options.redirect });
      return new globalThis.Response(requested.length === 1 ? wrong : correct, {
        status: 200,
      });
    },
  });
  assert.deepEqual(result, correct);
  assert.deepEqual(component, original);
  assert.equal(new URL(requested[0].url).hostname, "registry.npmmirror.com");
  assert.equal(requested[1].url, RESOLVED);
  assert.ok(requested.every(({ redirect }) => redirect === "error"));
  assert.equal(budget.bytes, wrong.length + correct.length);
  assert.equal(budget.networkBytes, wrong.length + correct.length);
  assert.equal(transportState.mirrorEnabled, false);

  const postCircuitRequests = [];
  await downloadVerifiedTarball(
    component,
    integrity,
    { bytes: 0 },
    {
      transportState,
      fetchImpl: async (url) => {
        postCircuitRequests.push(url);
        return new globalThis.Response(correct, { status: 200 });
      },
    },
  );
  assert.deepEqual(postCircuitRequests, [RESOLVED]);

  let errorBodyCancelled = false;
  const nonSuccessRequests = [];
  await downloadVerifiedTarball(
    component,
    integrity,
    { bytes: 0 },
    {
      transportState: { mirrorEnabled: true },
      fetchImpl: async (url) => {
        nonSuccessRequests.push(url);
        if (nonSuccessRequests.length === 1) {
          return {
            ok: false,
            body: {
              cancel: async () => {
                errorBodyCancelled = true;
              },
            },
          };
        }
        return new globalThis.Response(correct, { status: 200 });
      },
    },
  );
  assert.equal(errorBodyCancelled, true);
  assert.equal(nonSuccessRequests.length, 2);

  await assert.rejects(
    downloadVerifiedTarball(
      component,
      integrity,
      { bytes: 0 },
      {
        fetchImpl: async () => new globalThis.Response(wrong, { status: 200 }),
      },
    ),
    /no transport matching lock integrity/,
  );

  let abortedTransports = 0;
  await assert.rejects(
    downloadVerifiedTarball(
      component,
      integrity,
      { bytes: 0 },
      {
        idleTimeoutMs: 5,
        totalTimeoutMs: 50,
        fetchImpl: async (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                abortedTransports += 1;
                reject(new Error("synthetic stalled transport"));
              },
              { once: true },
            );
          }),
      },
    ),
    /no transport matching lock integrity/,
  );
  assert.equal(abortedTransports, 2);
});

test("closure verification rejects missing, stale, and wrong lock identities", async () => {
  await assert.doesNotReject(
    verifyReviewedInventory({
      artifactName: "mcp",
      inventoryBytes: inventoryBytes(),
      listOutput: listOutput(),
      lockfileSource: lockfile(),
      verifyLocalInstall: false,
    }),
  );

  await assert.rejects(
    verifyReviewedInventory({
      artifactName: "mcp",
      inventoryBytes: inventoryBytes(),
      listOutput: listOutput({ includeStale: true }),
      lockfileSource: lockfile(),
      verifyLocalInstall: false,
    }),
    /closure mismatch.*missing=\[stale@2\.0\.0\]/,
  );

  await assert.rejects(
    verifyReviewedInventory({
      artifactName: "mcp",
      inventoryBytes: inventoryBytes(
        inventoryComponent({
          integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}`,
        }),
      ),
      listOutput: listOutput(),
      lockfileSource: lockfile(),
      verifyLocalInstall: false,
    }),
    /registry integrity does not match/,
  );
});

test("local package metadata and evidence drift fail closed", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "npm-license-inventory-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const packageRoot = join(
    rootDir,
    "node_modules/.pnpm/safe-package@1.0.0/node_modules/safe-package",
  );
  await mkdir(packageRoot, { recursive: true });
  const packageJson = Buffer.from(
    `${JSON.stringify({
      name: "safe-package",
      version: "1.0.0",
      license: "MIT",
      repository: "https://github.com/example/safe-package.git",
    })}\n`,
  );
  const license = Buffer.from("reviewed MIT license evidence\n");
  await writeFile(join(packageRoot, "package.json"), packageJson);
  await writeFile(join(packageRoot, "LICENSE"), license);
  const reviewed = inventoryBytes(
    inventoryComponent({
      packageJsonSha256: sha256(packageJson),
      evidenceSha256: sha256(license),
    }),
  );

  const verified = await verifyReviewedInventory({
    rootDir,
    artifactName: "mcp",
    inventoryBytes: reviewed,
    listOutput: listOutput({ path: packageRoot }),
    lockfileSource: lockfile(),
  });
  assert.equal(verified.locallyVerified, 1);
  assert.equal(verified.locallyUnavailable, 0);

  const secondPackageRoot = join(
    rootDir,
    "node_modules/.pnpm/safe-package@1.0.0_peer/node_modules/safe-package",
  );
  await mkdir(secondPackageRoot, { recursive: true });
  await writeFile(join(secondPackageRoot, "package.json"), packageJson);
  await writeFile(join(secondPackageRoot, "LICENSE"), license);
  await assert.doesNotReject(
    verifyReviewedInventory({
      rootDir,
      artifactName: "mcp",
      inventoryBytes: reviewed,
      listOutput: listOutput({
        path: packageRoot,
        optionalPath: secondPackageRoot,
      }),
      lockfileSource: lockfile(),
    }),
  );
  await writeFile(
    join(secondPackageRoot, "LICENSE"),
    "tampered peer evidence\n",
  );
  await assert.rejects(
    verifyReviewedInventory({
      rootDir,
      artifactName: "mcp",
      inventoryBytes: reviewed,
      listOutput: listOutput({
        path: packageRoot,
        optionalPath: secondPackageRoot,
      }),
      lockfileSource: lockfile(),
    }),
    /installed evidence drifted/,
  );
  await writeFile(join(secondPackageRoot, "LICENSE"), license);

  await rm(join(packageRoot, "package.json"));
  await assert.rejects(
    verifyReviewedInventory({
      rootDir,
      artifactName: "mcp",
      inventoryBytes: reviewed,
      listOutput: listOutput({ path: packageRoot }),
      lockfileSource: lockfile(),
    }),
    /installed package\.json is missing or unreadable/,
  );
  await writeFile(join(packageRoot, "package.json"), packageJson);

  await writeFile(join(packageRoot, "LICENSE"), "tampered evidence\n");
  await assert.rejects(
    verifyReviewedInventory({
      rootDir,
      artifactName: "mcp",
      inventoryBytes: reviewed,
      listOutput: listOutput({ path: packageRoot }),
      lockfileSource: lockfile(),
    }),
    /installed evidence drifted/,
  );

  await writeFile(join(packageRoot, "LICENSE"), license);
  const packageObject = JSON.parse(
    await readFile(join(packageRoot, "package.json")),
  );
  packageObject.license = "ISC";
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify(packageObject),
  );
  await assert.rejects(
    verifyReviewedInventory({
      rootDir,
      artifactName: "mcp",
      inventoryBytes: reviewed,
      listOutput: listOutput({ path: packageRoot }),
      lockfileSource: lockfile(),
    }),
    /installed package metadata drifted/,
  );
});
