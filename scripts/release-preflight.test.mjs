import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";

import {
  verifyReleaseArtifacts,
  verifyReleaseMetadata,
} from "./release-preflight.mjs";
import {
  EXTENSION_EXPECTED_ID_ENV,
  EXTENSION_PUBLIC_KEY_ENV,
  LEGACY_EXTENSION_KEY_ENV,
  REQUIRE_EXTENSION_PUBLIC_KEY_ENV,
  deriveChromeExtensionId,
  resolveChromeExtensionPublicKey,
  validateChromeExtensionPublicKey,
} from "./extension-public-key.mjs";
import { loadReviewedLegalFiles } from "./legal-notices.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "1.2.3";
const { publicKey: testPublicKey, privateKey: testPrivateKey } =
  generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_EXTENSION_PUBLIC_KEY = testPublicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const TEST_PRIVATE_KEY_DER = testPrivateKey
  .export({ format: "der", type: "pkcs8" })
  .toString("base64");
const TEST_PKCS1_PUBLIC_KEY = testPublicKey
  .export({ format: "der", type: "pkcs1" })
  .toString("base64");
const { publicKey: testEcPublicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const TEST_EC_PUBLIC_KEY = testEcPublicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const TEST_EXTENSION_ID = deriveChromeExtensionId(TEST_EXTENSION_PUBLIC_KEY);
const TEST_RELEASE_ENVIRONMENT = {
  [EXTENSION_EXPECTED_ID_ENV]: TEST_EXTENSION_ID,
  [EXTENSION_PUBLIC_KEY_ENV]: TEST_EXTENSION_PUBLIC_KEY,
  [REQUIRE_EXTENSION_PUBLIC_KEY_ENV]: "true",
};
const MCP_PACKAGE_TEMPLATE = {
  name: "webpage-mcp",
  version: VERSION,
  description: "Webpage MCP server",
  main: "dist/index.js",
  bin: {
    "webpage-mcp": "./dist/cli.js",
    "webpage-mcp-stdio": "./dist/mcp/mcp-server-stdio.js",
  },
  files: ["dist", "LICENSE", "THIRD_PARTY_NOTICES.md", "!dist/node_path.txt"],
  engines: { node: ">=22.0.0" },
  license: "MIT",
  publishConfig: { access: "public", provenance: true },
  repository: {
    type: "git",
    url: "https://github.com/mcpland/webpage-mcp.git",
    directory: "app/mcp-server",
  },
  preferGlobal: true,
  dependencies: { chalk: "^5.4.1" },
  scripts: { postinstall: "node dist/scripts/postinstall.js" },
};
const EXTENSION_PERMISSIONS = [
  "nativeMessaging",
  "tabs",
  "activeTab",
  "scripting",
  "userScripts",
  "contextMenus",
  "downloads",
  "webRequest",
  "webNavigation",
  "debugger",
  "history",
  "bookmarks",
  "offscreen",
  "notifications",
  "storage",
  "alarms",
  "sidePanel",
];

function createExtensionManifest(overrides = {}) {
  return {
    manifest_version: 3,
    minimum_chrome_version: "135",
    name: "Webpage MCP Connector",
    description: "Connect webpages to Webpage MCP",
    version: VERSION,
    permissions: EXTENSION_PERMISSIONS,
    host_permissions: ["<all_urls>"],
    background: { service_worker: "background.js" },
    action: { default_popup: "popup.html" },
    options_ui: { page: "options.html" },
    side_panel: { default_path: "sidepanel.html" },
    icons: { 16: "icon/16.png" },
    default_locale: "en",
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["content-scripts/content.js"],
      },
    ],
    ...overrides,
  };
}

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
    ...MCP_PACKAGE_TEMPLATE,
    version: versions.mcp ?? VERSION,
  });
  await writeJson(join(rootDir, "app/chrome-extension/package.json"), {
    name: "webpage-mcp-connector",
    version: versions.extension ?? VERSION,
  });
  for (const relativePath of [
    "LICENSE",
    "app/mcp-server/LICENSE",
    "app/mcp-server/THIRD_PARTY_NOTICES.md",
    "app/chrome-extension/public/LICENSE",
    "app/chrome-extension/public/THIRD_PARTY_NOTICES.md",
  ]) {
    const targetPath = join(rootDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(
      targetPath,
      await readFile(join(REPOSITORY_ROOT, relativePath)),
    );
  }
  return rootDir;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeTarText(header, offset, length, value) {
  header.write(
    value,
    offset,
    Math.min(length, Buffer.byteLength(value)),
    "utf8",
  );
}

function writeTarOctal(header, offset, length, value) {
  writeTarText(
    header,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, "0")}\0`,
  );
}

function archiveEntryPairs(entries) {
  return Array.isArray(entries) ? entries : Object.entries(entries);
}

function createTarGzip(entries) {
  const records = [];
  for (const [name, rawEntry] of archiveEntryPairs(entries)) {
    const entry =
      rawEntry !== null &&
      typeof rawEntry === "object" &&
      !Buffer.isBuffer(rawEntry) &&
      Object.hasOwn(rawEntry, "contents")
        ? rawEntry
        : { contents: rawEntry };
    const body = Buffer.from(entry.contents ?? "");
    const header = Buffer.alloc(512);
    writeTarText(header, 0, 100, name);
    writeTarOctal(header, 100, 8, entry.mode ?? 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, body.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    if (entry.linkName) writeTarText(header, 157, 100, entry.linkName);
    writeTarText(header, 257, 6, "ustar\0");
    writeTarText(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
    records.push(header, body, padding);
  }
  records.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(records));
}

function createZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const [name, rawEntry] of archiveEntryPairs(entries)) {
    const entry =
      rawEntry !== null &&
      typeof rawEntry === "object" &&
      !Buffer.isBuffer(rawEntry) &&
      Object.hasOwn(rawEntry, "contents")
        ? rawEntry
        : { contents: rawEntry };
    const body = Buffer.from(entry.contents ?? "");
    const method = entry.store ? 0 : 8;
    const compressed = method === 0 ? body : deflateRawSync(body);
    const nameBytes = Buffer.from(name);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.unixMode === undefined ? 20 : 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    if (entry.unixMode !== undefined) {
      central.writeUInt32LE(((entry.unixMode & 0xffff) << 16) >>> 0, 38);
    }
    central.writeUInt32LE(localOffset, 42);

    const localRecord = Buffer.concat([local, nameBytes, compressed]);
    const centralRecord = Buffer.concat([central, nameBytes]);
    localRecords.push(localRecord);
    centralRecords.push(centralRecord);
    localOffset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centralRecords.length, 8);
  end.writeUInt16LE(centralRecords.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

function unpackFixtureContents(rawEntry) {
  return rawEntry !== null &&
    typeof rawEntry === "object" &&
    !Buffer.isBuffer(rawEntry) &&
    Object.hasOwn(rawEntry, "contents")
    ? (rawEntry.contents ?? "")
    : rawEntry;
}

async function writeBuildFixture(rootDir, entries) {
  for (const [name, rawEntry] of archiveEntryPairs(entries)) {
    const target = join(rootDir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, unpackFixtureContents(rawEntry));
  }
}

async function writeArtifactChecksums(artifactsDir, mcpPath, extensionPath) {
  const mcpArchive = await readFile(join(artifactsDir, mcpPath));
  const extensionArchive = await readFile(join(artifactsDir, extensionPath));
  await writeFile(
    join(artifactsDir, "SHA256SUMS.txt"),
    `${sha256(extensionArchive)}  ./${extensionPath}\n${sha256(mcpArchive)}  ./${mcpPath}\n`,
    "utf8",
  );
}

async function createArtifacts(rootDir, overrides = {}) {
  const artifactsDir = join(rootDir, "artifacts");
  const extensionBuildDir = join(
    rootDir,
    "app/chrome-extension/.output/chrome-mv3",
  );
  const mcpPath = `mcp/webpage-mcp-${VERSION}.tgz`;
  const extensionPath = `extension/webpage-mcp-connector-${VERSION}-chrome-extension.zip`;
  await mkdir(join(artifactsDir, "mcp"), { recursive: true });
  await mkdir(join(artifactsDir, "extension"), { recursive: true });

  const sourcePackage = JSON.parse(
    await readFile(join(rootDir, "app/mcp-server/package.json"), "utf8"),
  );
  const packedPackage = {
    ...sourcePackage,
    version: overrides.mcpVersion ?? sourcePackage.version,
    ...(overrides.packedMcpPackage ?? {}),
  };
  for (const field of overrides.omitPackedMcpFields ?? [])
    delete packedPackage[field];
  const extensionManifest = createExtensionManifest({
    version: overrides.extensionVersion ?? VERSION,
    ...(overrides.extensionKey === undefined
      ? {}
      : { key: overrides.extensionKey }),
    ...(overrides.extensionManifest ?? {}),
  });
  const [mcpLegal, extensionLegal] = await Promise.all([
    loadReviewedLegalFiles({ rootDir, artifactName: "mcp" }),
    loadReviewedLegalFiles({ rootDir, artifactName: "extension" }),
  ]);
  const mcpEntries = [
    ["package/package.json", `${JSON.stringify(packedPackage, null, 2)}\n`],
    ...(!overrides.omitMcpLicense
      ? [[mcpLegal.archiveLicense, overrides.mcpLicense ?? mcpLegal.license]]
      : []),
    ...(!overrides.omitMcpNotice
      ? [[mcpLegal.archiveNotice, overrides.mcpNotice ?? mcpLegal.notice]]
      : []),
    ...(!overrides.skeletonMcp
      ? [
          [
            "package/dist/index.js",
            "#!/usr/bin/env node\nmodule.exports = {};\n",
          ],
          [
            "package/dist/cli.js",
            {
              contents: "#!/usr/bin/env node\nconsole.log('cli');\n",
              mode: overrides.mcpCliMode ?? 0o755,
            },
          ],
          [
            "package/dist/mcp/mcp-server-stdio.js",
            {
              contents: "#!/usr/bin/env node\nconsole.log('stdio');\n",
              mode: overrides.mcpStdioMode ?? 0o755,
            },
          ],
          ["package/dist/native-messaging-host.js", "module.exports = {};\n"],
          [
            "package/dist/scripts/native-log-runner.js",
            "module.exports = {};\n",
          ],
          ["package/dist/scripts/postinstall.js", "module.exports = {};\n"],
          ["package/dist/run_host.sh", "#!/bin/sh\nexec node index.js\n"],
          ["package/dist/run_host.bat", "@node index.js\r\n"],
        ]
      : []),
    ...archiveEntryPairs(overrides.extraMcpEntries ?? {}),
  ].filter(([name]) => name !== overrides.omitMcpEntry);
  const extensionEntries = [
    ["manifest.json", `${JSON.stringify(extensionManifest, null, 2)}\n`],
    ...(!overrides.omitExtensionLicense
      ? [
          [
            extensionLegal.archiveLicense,
            overrides.extensionLicense ?? extensionLegal.license,
          ],
        ]
      : []),
    ...(!overrides.omitExtensionNotice
      ? [
          [
            extensionLegal.archiveNotice,
            overrides.extensionNotice ?? extensionLegal.notice,
          ],
        ]
      : []),
    ...(!overrides.skeletonExtension
      ? [
          [
            "background.js",
            "chrome.runtime.onInstalled.addListener(() => {});\n",
          ],
          ["popup.html", "<!doctype html><title>Popup</title>\n"],
          ["options.html", "<!doctype html><title>Options</title>\n"],
          ["sidepanel.html", "<!doctype html><title>Side panel</title>\n"],
          ["icon/16.png", Buffer.from("fixture-icon")],
          ["_locales/en/messages.json", '{"name":{"message":"Webpage MCP"}}\n'],
          ["content-scripts/content.js", "console.log('content');\n"],
        ]
      : []),
    ...archiveEntryPairs(overrides.extraExtensionEntries ?? {}),
  ].filter(([name]) => name !== overrides.omitExtensionEntry);

  if (!overrides.skipExtensionBuild) {
    await writeBuildFixture(
      extensionBuildDir,
      overrides.extensionBuildEntries ?? extensionEntries,
    );
  }

  await writeFile(join(artifactsDir, mcpPath), createTarGzip(mcpEntries));
  await writeFile(
    join(artifactsDir, extensionPath),
    createZip(extensionEntries),
  );
  await writeArtifactChecksums(artifactsDir, mcpPath, extensionPath);
  return { artifactsDir, extensionBuildDir, mcpPath, extensionPath };
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

test("release metadata accepts only stable Chrome-safe versions", async (t) => {
  const stableBoundaryRoot = await createReleaseRoot(t, {
    mcp: "65535.65535.65535",
    extension: "65535.65535.65535",
  });
  const stableBoundary = await verifyReleaseMetadata({
    rootDir: stableBoundaryRoot,
    tag: "v65535.65535.65535",
  });
  assert.equal(stableBoundary.version, "65535.65535.65535");

  for (const [version, expectedError] of [
    ["1.2.3-rc.1", /prerelease versions are not supported/],
    ["1.2.3+build.1", /build metadata is not supported/],
    ["65536.0.1", /between 0 and 65535/],
    ["0.0.0", /cannot be 0\.0\.0/],
  ]) {
    const rootDir = await createReleaseRoot(t, {
      mcp: version,
      extension: version,
    });
    await assert.rejects(verifyReleaseMetadata({ rootDir }), expectedError);
  }

  const stableRoot = await createReleaseRoot(t);
  await assert.rejects(
    verifyReleaseMetadata({ rootDir: stableRoot, tag: "v1.2.3-rc.1" }),
    /prerelease versions are not supported/,
  );
  await assert.rejects(
    verifyReleaseMetadata({ rootDir: stableRoot, tag: "v1.2.3+build.1" }),
    /build metadata is not supported/,
  );
});

test("extension identity accepts only a canonical public DER key", () => {
  assert.equal(
    validateChromeExtensionPublicKey(TEST_EXTENSION_PUBLIC_KEY),
    TEST_EXTENSION_PUBLIC_KEY,
  );
  assert.match(TEST_EXTENSION_ID, /^[a-p]{32}$/);
  assert.equal(resolveChromeExtensionPublicKey({}), undefined);
  assert.equal(
    resolveChromeExtensionPublicKey(TEST_RELEASE_ENVIRONMENT),
    TEST_EXTENSION_PUBLIC_KEY,
  );

  assert.throws(
    () =>
      resolveChromeExtensionPublicKey({
        [EXTENSION_EXPECTED_ID_ENV]: TEST_EXTENSION_ID,
        [REQUIRE_EXTENSION_PUBLIC_KEY_ENV]: "true",
      }),
    /is required for a formal release/,
  );
  assert.throws(
    () =>
      resolveChromeExtensionPublicKey({
        [EXTENSION_PUBLIC_KEY_ENV]: TEST_EXTENSION_PUBLIC_KEY,
        [REQUIRE_EXTENSION_PUBLIC_KEY_ENV]: "true",
      }),
    /CHROME_EXTENSION_EXPECTED_ID is required/,
  );
  assert.throws(
    () =>
      resolveChromeExtensionPublicKey({
        [EXTENSION_EXPECTED_ID_ENV]: "a".repeat(32),
        [EXTENSION_PUBLIC_KEY_ENV]: TEST_EXTENSION_PUBLIC_KEY,
      }),
    /does not derive the CHROME_EXTENSION_EXPECTED_ID identity/,
  );
  assert.throws(
    () =>
      resolveChromeExtensionPublicKey({
        [EXTENSION_EXPECTED_ID_ENV]: "invalid",
        [EXTENSION_PUBLIC_KEY_ENV]: TEST_EXTENSION_PUBLIC_KEY,
      }),
    /must be a 32-character Chrome extension ID/,
  );
  assert.throws(
    () =>
      resolveChromeExtensionPublicKey({
        [LEGACY_EXTENSION_KEY_ENV]: TEST_EXTENSION_PUBLIC_KEY,
      }),
    /old name encouraged private-key use/,
  );
  assert.throws(
    () =>
      resolveChromeExtensionPublicKey({
        [REQUIRE_EXTENSION_PUBLIC_KEY_ENV]: "sometimes",
      }),
    /must be true, false, 1, or 0/,
  );
  assert.throws(
    () => validateChromeExtensionPublicKey("YOUR_PUBLIC_KEY_HERE"),
    /private key, or a placeholder/,
  );
  assert.throws(
    () =>
      validateChromeExtensionPublicKey(
        testPrivateKey.export({ format: "pem", type: "pkcs8" }),
      ),
    /never PEM text/,
  );
  assert.throws(
    () =>
      validateChromeExtensionPublicKey(
        testPublicKey.export({ format: "pem", type: "spki" }),
      ),
    /never PEM text/,
  );
  assert.throws(
    () => validateChromeExtensionPublicKey(TEST_PRIVATE_KEY_DER),
    /SubjectPublicKeyInfo public key/,
  );
  assert.throws(
    () => validateChromeExtensionPublicKey(TEST_PKCS1_PUBLIC_KEY),
    /SubjectPublicKeyInfo public key/,
  );
  assert.throws(
    () => validateChromeExtensionPublicKey(TEST_EC_PUBLIC_KEY),
    /must contain an RSA public key/,
  );
  assert.throws(
    () => validateChromeExtensionPublicKey("not+canonical=base64"),
    /not canonical base64/,
  );
  assert.throws(
    () => validateChromeExtensionPublicKey(`${TEST_EXTENSION_PUBLIC_KEY}\n`),
    /without whitespace/,
  );
});

test("local environment files are ignored without hiding the safe example", () => {
  for (const path of [
    ".env",
    ".env.local",
    "app/chrome-extension/.env",
    "app/chrome-extension/.env.local",
  ]) {
    const result = spawnSync("git", ["check-ignore", "--quiet", path], {
      cwd: REPOSITORY_ROOT,
    });
    assert.equal(result.status, 0, `${path} must be ignored by git`);
  }

  const example = spawnSync(
    "git",
    ["check-ignore", "--quiet", "app/chrome-extension/.env.example"],
    { cwd: REPOSITORY_ROOT },
  );
  assert.notEqual(example.status, 0, ".env.example must remain trackable");
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
  assert.equal(result.extensionBuildCompared, true);
});

test("formal release artifacts bind the configured public key", async (t) => {
  const rootDir = await createReleaseRoot(t);
  const { artifactsDir } = await createArtifacts(rootDir, {
    extensionKey: TEST_EXTENSION_PUBLIC_KEY,
  });

  const result = await verifyReleaseArtifacts({
    rootDir,
    artifactsDir,
    environment: TEST_RELEASE_ENVIRONMENT,
  });
  assert.equal(result.extensionPublicKey, TEST_EXTENSION_PUBLIC_KEY);

  const missingKeyRoot = await createReleaseRoot(t);
  const missingKeyArtifacts = await createArtifacts(missingKeyRoot);
  await assert.rejects(
    verifyReleaseArtifacts({
      rootDir: missingKeyRoot,
      artifactsDir: missingKeyArtifacts.artifactsDir,
      environment: TEST_RELEASE_ENVIRONMENT,
    }),
    /manifest public key does not match/,
  );
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

  await t.test(
    "on prerelease metadata embedded in either archive",
    async (t) => {
      const npmRoot = await createReleaseRoot(t);
      const npmArtifacts = await createArtifacts(npmRoot, {
        mcpVersion: "1.2.3-rc.1",
      });
      await assert.rejects(
        verifyReleaseArtifacts({
          rootDir: npmRoot,
          artifactsDir: npmArtifacts.artifactsDir,
        }),
        /npm tarball package version: prerelease versions are not supported/,
      );

      const extensionRoot = await createReleaseRoot(t);
      const extensionArtifacts = await createArtifacts(extensionRoot, {
        extensionVersion: "1.2.3-beta.1",
      });
      await assert.rejects(
        verifyReleaseArtifacts({
          rootDir: extensionRoot,
          artifactsDir: extensionArtifacts.artifactsDir,
        }),
        /Extension manifest version: prerelease versions are not supported/,
      );
    },
  );

  await t.test("when either artifact omits a legal file", async (t) => {
    const npmRoot = await createReleaseRoot(t);
    const npmArtifacts = await createArtifacts(npmRoot, {
      omitMcpLicense: true,
    });
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: npmRoot,
        artifactsDir: npmArtifacts.artifactsDir,
      }),
      /Missing package\/LICENSE in npm tarball project LICENSE/,
    );

    const extensionRoot = await createReleaseRoot(t);
    const extensionArtifacts = await createArtifacts(extensionRoot, {
      omitExtensionNotice: true,
    });
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: extensionRoot,
        artifactsDir: extensionArtifacts.artifactsDir,
      }),
      /Missing THIRD_PARTY_NOTICES\.md in extension zip THIRD_PARTY_NOTICES\.md/,
    );
  });

  await t.test("when either artifact corrupts a legal file", async (t) => {
    const npmRoot = await createReleaseRoot(t);
    const npmArtifacts = await createArtifacts(npmRoot, {
      mcpNotice: "tampered notices\n",
    });
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: npmRoot,
        artifactsDir: npmArtifacts.artifactsDir,
      }),
      /npm tarball THIRD_PARTY_NOTICES\.md does not match the reviewed repository source/,
    );

    const extensionRoot = await createReleaseRoot(t);
    const extensionArtifacts = await createArtifacts(extensionRoot, {
      extensionLicense: "tampered license\n",
    });
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: extensionRoot,
        artifactsDir: extensionArtifacts.artifactsDir,
      }),
      /extension zip project LICENSE does not match the reviewed repository source/,
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

test("release artifacts must contain runnable npm and extension payloads", async (t) => {
  await t.test("when npm package metadata omits bin", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir } = await createArtifacts(rootDir, {
      omitPackedMcpFields: ["bin"],
    });
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /package field bin does not match app\/mcp-server\/package\.json/,
    );
  });

  await t.test("when an npm bin target is missing", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir } = await createArtifacts(rootDir, {
      omitMcpEntry: "package/dist/cli.js",
    });
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /Missing package\/dist\/cli\.js in npm tarball/,
    );
  });

  await t.test("when an npm bin loses its executable mode", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir } = await createArtifacts(rootDir, {
      mcpCliMode: 0o644,
    });
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /bin\.webpage-mcp target must be executable/,
    );
  });

  await t.test("when the native log runner is missing", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir } = await createArtifacts(rootDir, {
      omitMcpEntry: "package/dist/scripts/native-log-runner.js",
    });
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /Missing package\/dist\/scripts\/native-log-runner\.js in npm tarball/,
    );
  });

  await t.test("when either archive is only a metadata skeleton", async (t) => {
    const npmRoot = await createReleaseRoot(t);
    const npmArtifacts = await createArtifacts(npmRoot, { skeletonMcp: true });
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: npmRoot,
        artifactsDir: npmArtifacts.artifactsDir,
      }),
      /Missing package\/dist\/index\.js in npm tarball/,
    );

    const extensionRoot = await createReleaseRoot(t);
    const extensionArtifacts = await createArtifacts(extensionRoot, {
      skeletonExtension: true,
    });
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: extensionRoot,
        artifactsDir: extensionArtifacts.artifactsDir,
      }),
      /Missing background\.js in extension zip/,
    );
  });
});

test("release artifacts reject package, permission, and build-output drift", async (t) => {
  await t.test(
    "when packed npm fields differ from the reviewed package",
    async (t) => {
      const rootDir = await createReleaseRoot(t);
      const { artifactsDir } = await createArtifacts(rootDir, {
        packedMcpPackage: { main: "dist/alternate.js" },
      });
      await assert.rejects(
        verifyReleaseArtifacts({ rootDir, artifactsDir }),
        /package field main does not match app\/mcp-server\/package\.json/,
      );
    },
  );

  await t.test("when a required extension permission disappears", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir } = await createArtifacts(rootDir, {
      extensionManifest: {
        permissions: EXTENSION_PERMISSIONS.filter(
          (permission) => permission !== "nativeMessaging",
        ),
      },
    });
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /missing required permission: nativeMessaging/,
    );
  });

  await t.test("when the userScripts permission disappears", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir } = await createArtifacts(rootDir, {
      extensionManifest: {
        permissions: EXTENSION_PERMISSIONS.filter(
          (permission) => permission !== "userScripts",
        ),
      },
    });
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /missing required permission: userScripts/,
    );
  });

  await t.test("when the minimum Chrome version drifts", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir } = await createArtifacts(rootDir, {
      extensionManifest: { minimum_chrome_version: "134" },
    });
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /minimum_chrome_version must be exactly "135"/,
    );
  });

  await t.test("when an unexpected extension permission appears", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir } = await createArtifacts(rootDir, {
      extensionManifest: {
        permissions: [...EXTENSION_PERMISSIONS, "management"],
      },
    });
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /permissions contain an unexpected permission/,
    );
  });

  await t.test(
    "when the extension ZIP file list differs from the build",
    async (t) => {
      const rootDir = await createReleaseRoot(t);
      const { artifactsDir, extensionBuildDir } =
        await createArtifacts(rootDir);
      await writeFile(join(extensionBuildDir, "unexpected.js"), "unexpected\n");
      await assert.rejects(
        verifyReleaseArtifacts({ rootDir, artifactsDir }),
        /ZIP file list does not match build directory/,
      );
    },
  );

  await t.test("when extension ZIP bytes differ from the build", async (t) => {
    const rootDir = await createReleaseRoot(t);
    const { artifactsDir, extensionBuildDir } = await createArtifacts(rootDir);
    await writeFile(join(extensionBuildDir, "background.js"), "tampered\n");
    await assert.rejects(
      verifyReleaseArtifacts({ rootDir, artifactsDir }),
      /ZIP content does not match build directory: background\.js/,
    );
  });
});

test("release archive inventories reject traversal, links, and duplicates", async (t) => {
  for (const [label, overrides, expected] of [
    [
      "tar traversal",
      { extraMcpEntries: { "package/../escape.js": "escape" } },
      /unsafe path: package\/\.\.\/escape\.js/,
    ],
    [
      "tar link",
      {
        extraMcpEntries: {
          "package/dist/link.js": {
            contents: "target.js",
            type: "2",
            linkName: "target.js",
          },
        },
      },
      /tar may not contain links or special entries/,
    ],
    [
      "tar duplicate",
      { extraMcpEntries: [["package/dist/index.js", "duplicate\n"]] },
      /Duplicate tar entry/,
    ],
    [
      "ZIP traversal",
      {
        extraExtensionEntries: { "../escape.js": "escape" },
        skipExtensionBuild: true,
      },
      /unsafe path: \.\.\/escape\.js/,
    ],
    [
      "ZIP link",
      {
        extraExtensionEntries: {
          link: { contents: "background.js", unixMode: 0o120777 },
        },
      },
      /ZIP may not contain links or special entries/,
    ],
    [
      "ZIP duplicate",
      { extraExtensionEntries: [["manifest.json", "{}\n"]] },
      /Duplicate ZIP entry/,
    ],
  ]) {
    await t.test(label, async (t) => {
      const rootDir = await createReleaseRoot(t);
      const { artifactsDir } = await createArtifacts(rootDir, overrides);
      await assert.rejects(
        verifyReleaseArtifacts({ rootDir, artifactsDir }),
        expected,
      );
    });
  }
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
    "uses: softprops/action-gh-release@",
    githubJob,
  );
  const npmJob = workflow.indexOf("  publish-npm:");
  const npmPreflight = workflow.indexOf(
    "      - name: Reverify release metadata and artifacts",
    npmJob,
  );
  const npmPublish = workflow.indexOf('          npm publish "', npmJob);

  assert.match(
    workflow,
    /CHROME_EXTENSION_PUBLIC_KEY:\s*\$\{\{\s*vars\.CHROME_EXTENSION_PUBLIC_KEY\s*\}\}/,
    "formal releases must source the public key from a repository variable",
  );
  assert.match(
    workflow,
    /WEBPAGE_MCP_REQUIRE_EXTENSION_PUBLIC_KEY:\s*["']true["']/,
    "formal releases must fail closed when the public key is unavailable",
  );
  assert.match(
    workflow,
    /CHROME_EXTENSION_EXPECTED_ID:\s*iehgbogeakiedihodennfcnigojnncag/,
    "formal releases must bind the public key to the official extension ID",
  );

  const remoteActionRefs = Array.from(
    workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm),
    (match) => match[1],
  ).filter((reference) => !reference.startsWith("./"));
  assert.ok(remoteActionRefs.length > 0, "workflow must use remote actions");
  for (const reference of remoteActionRefs) {
    assert.match(
      reference,
      /^[^@]+@[a-f0-9]{40}$/,
      `remote action must be pinned to a full commit SHA: ${reference}`,
    );
  }

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
    /npm publish[\s\S]*--tag latest/,
    "the stable-only unified release must publish to latest explicitly",
  );
  assert.doesNotMatch(
    workflow,
    /npm-dist-tag\.mjs|DIST_TAG=/,
    "the unified release must not imply npm-only prerelease support",
  );
  assert.doesNotMatch(
    buildJobBody,
    /action-gh-release|npm publish/,
    "build and verification must not mutate a release",
  );
});

test("CI and release use maintained Node runtimes and Node 24 actions", async () => {
  const workflowPaths = [
    join(REPOSITORY_ROOT, ".github/workflows/ci.yml"),
    join(REPOSITORY_ROOT, ".github/workflows/release.yml"),
  ];
  const workflows = await Promise.all(
    workflowPaths.map((workflowPath) => readFile(workflowPath, "utf8")),
  );
  const combined = workflows.join("\n");

  assert.doesNotMatch(
    combined,
    /node-version:\s*["']?20(?:["']?|\s|$)/,
    "EOL Node.js 20 must not be used by CI or release jobs",
  );
  assert.match(
    workflows[0],
    /node-version:\s*\[22, 24\]/,
    "CI must verify both supported LTS release lines",
  );

  const node24ActionCommits = new Set([
    "df4cb1c069e1874edd31b4311f1884172cec0e10", // actions/checkout v6.0.3
    "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e", // actions/setup-node v6.4.0
    "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", // actions/upload-artifact v7.0.1
    "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", // actions/download-artifact v8.0.1
    "fc06bc1257f339d1d5d8b3a19a8cae5388b55320", // pnpm/action-setup v5.0.0
    "718ea10b132b3b2eba29c1007bb80653f286566b", // softprops/action-gh-release v3.0.1
  ]);
  const actionReferences = Array.from(
    combined.matchAll(/^\s*uses:\s*([^\s#]+)@([a-f0-9]{40})/gm),
  );
  assert.ok(actionReferences.length > 0, "workflows must use remote actions");
  for (const [, action, commit] of actionReferences) {
    assert.ok(
      node24ActionCommits.has(commit),
      `${action} must be pinned to the reviewed Node 24 action release`,
    );
  }
});
