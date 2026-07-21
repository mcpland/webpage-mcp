import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";

import {
  verifyReleaseArtifacts,
  verifyReleaseMetadata,
  verifyNpmPublishRef,
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
  files: [
    "dist",
    "LICENSE",
    "npm-shrinkwrap.json",
    "THIRD_PARTY_NOTICES.md",
    "THIRD_PARTY_COMPONENTS.json",
    "!dist/node_path.txt",
  ],
  engines: { node: ">=22.0.0" },
  license: "MIT",
  publishConfig: { access: "public", provenance: true },
  repository: {
    type: "git",
    url: "https://github.com/mcpland/webpage-mcp.git",
    directory: "app/mcp-server",
  },
  preferGlobal: true,
  dependencies: { chalk: "5.4.1" },
  overrides: { chalk: "5.4.1" },
  scripts: { postinstall: "node dist/scripts/postinstall.js" },
};

function createMcpShrinkwrap(pkg) {
  return Buffer.from(
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: pkg.name,
            version: pkg.version,
            license: pkg.license,
            hasInstallScript: true,
            engines: pkg.engines,
            dependencies: pkg.dependencies,
          },
          "node_modules/chalk": {
            version: "5.4.1",
            resolved: "https://registry.npmjs.org/chalk/-/chalk-5.4.1.tgz",
            integrity: `sha512-${Buffer.alloc(64, 5).toString("base64")}`,
            license: "MIT",
            engines: { node: "^12.17.0 || ^14.13 || >=16.0.0" },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}
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
  const mcpPackage = {
    ...MCP_PACKAGE_TEMPLATE,
    version: versions.mcp ?? VERSION,
  };
  await writeJson(join(rootDir, "app/mcp-server/package.json"), mcpPackage);
  await writeFile(
    join(rootDir, "app/mcp-server/npm-shrinkwrap.json"),
    createMcpShrinkwrap(mcpPackage),
  );
  await writeJson(join(rootDir, "app/chrome-extension/package.json"), {
    name: "webpage-mcp-connector",
    version: versions.extension ?? VERSION,
  });
  for (const relativePath of [
    "LICENSE",
    "app/mcp-server/LICENSE",
    "app/mcp-server/THIRD_PARTY_NOTICES.md",
    "app/mcp-server/THIRD_PARTY_COMPONENTS.json",
    "app/chrome-extension/public/LICENSE",
    "app/chrome-extension/public/THIRD_PARTY_NOTICES.md",
    "app/chrome-extension/public/THIRD_PARTY_LICENSES.txt",
    "app/chrome-extension/public/THIRD_PARTY_COMPONENTS.json",
    "scripts/mcp-bundle-components.json",
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
  const mcpShrinkwrap = await readFile(
    join(rootDir, "app/mcp-server/npm-shrinkwrap.json"),
  );
  const mcpEntries = [
    ["package/package.json", `${JSON.stringify(packedPackage, null, 2)}\n`],
    ...(!overrides.omitMcpShrinkwrap
      ? [
          [
            "package/npm-shrinkwrap.json",
            overrides.mcpShrinkwrap ?? mcpShrinkwrap,
          ],
        ]
      : []),
    ...(!overrides.omitMcpLicense
      ? [[mcpLegal.archiveLicense, overrides.mcpLicense ?? mcpLegal.license]]
      : []),
    ...(!overrides.omitMcpNotice
      ? [[mcpLegal.archiveNotice, overrides.mcpNotice ?? mcpLegal.notice]]
      : []),
    ...(!overrides.omitMcpInventory
      ? [
          [
            mcpLegal.archiveInventory,
            overrides.mcpInventory ?? mcpLegal.inventory,
          ],
        ]
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
            overrides.mcpRunnerSource ??
              "require('./native-log-policy');\nmodule.exports = {};\n",
          ],
          [
            "package/dist/scripts/native-log-policy.js",
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
    ...(!overrides.omitExtensionThirdPartyLicenses
      ? [
          [
            extensionLegal.archiveThirdPartyLicenses,
            overrides.extensionThirdPartyLicenses ??
              extensionLegal.thirdPartyLicenses,
          ],
        ]
      : []),
    ...(!overrides.omitExtensionInventory
      ? [
          [
            extensionLegal.archiveInventory,
            overrides.extensionInventory ?? extensionLegal.inventory,
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

test("npm publish refs must exactly match the package version tag", async (t) => {
  const rootDir = await createReleaseRoot(t);
  const result = await verifyNpmPublishRef({
    rootDir,
    ref: `refs/tags/v${VERSION}`,
  });
  assert.equal(result.version, VERSION);
  assert.equal(result.ref, `refs/tags/v${VERSION}`);

  await assert.rejects(
    verifyNpmPublishRef({ rootDir, ref: "refs/heads/main" }),
    /requires an exact refs\/tags\/v<version> ref/,
  );
  await assert.rejects(
    verifyNpmPublishRef({ rootDir, ref: `refs/tags/${VERSION}` }),
    /Release tag must use the v<version> form/,
  );
  await assert.rejects(
    verifyNpmPublishRef({ rootDir, ref: "refs/tags/v1.2.4" }),
    /does not match package version/,
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
  assert.equal(result.extensionVerificationMode, "build-match");
  assert.equal(result.extensionBuildCompared, true);
});

test("extension build verification is fail-closed unless archive-only is explicit", async (t) => {
  const rootDir = await createReleaseRoot(t);
  const { artifactsDir } = await createArtifacts(rootDir, {
    skipExtensionBuild: true,
  });

  await assert.rejects(
    verifyReleaseArtifacts({ rootDir, artifactsDir }),
    /Extension build directory is required for ZIP-to-build verification but was not found/,
  );

  const archiveOnlyResult = await verifyReleaseArtifacts({
    rootDir,
    artifactsDir,
    extensionVerificationMode: "archive-only",
  });
  assert.equal(archiveOnlyResult.extensionVerificationMode, "archive-only");
  assert.equal(archiveOnlyResult.extensionBuildCompared, false);
});

test("release artifact API rejects unknown extension verification modes", async () => {
  await assert.rejects(
    verifyReleaseArtifacts({
      artifactsDir: "unused",
      extensionVerificationMode: "automatic",
    }),
    /extensionVerificationMode must be build-match or archive-only/,
  );
});

test("release artifact CLI reports its extension verification mode", async (t) => {
  const rootDir = await createReleaseRoot(t);
  await createArtifacts(rootDir, { skipExtensionBuild: true });
  const environment = { ...process.env };
  for (const name of [
    EXTENSION_EXPECTED_ID_ENV,
    EXTENSION_PUBLIC_KEY_ENV,
    LEGACY_EXTENSION_KEY_ENV,
    REQUIRE_EXTENSION_PUBLIC_KEY_ENV,
  ]) {
    delete environment[name];
  }
  const scriptPath = join(REPOSITORY_ROOT, "scripts/release-preflight.mjs");

  const defaultMode = spawnSync(
    process.execPath,
    [scriptPath, "artifacts", "artifacts", "--tag", `v${VERSION}`],
    { cwd: rootDir, encoding: "utf8", env: environment },
  );
  assert.notEqual(defaultMode.status, 0);
  assert.match(
    defaultMode.stderr,
    /Extension build directory is required for ZIP-to-build verification but was not found/,
  );

  const buildMatch = spawnSync(
    process.execPath,
    [
      scriptPath,
      "artifacts",
      "artifacts",
      "--require-build-match",
      "--tag",
      `v${VERSION}`,
    ],
    { cwd: rootDir, encoding: "utf8", env: environment },
  );
  assert.notEqual(buildMatch.status, 0);
  assert.match(
    buildMatch.stderr,
    /Extension build directory is required for ZIP-to-build verification but was not found/,
  );

  const archiveOnly = spawnSync(
    process.execPath,
    [
      scriptPath,
      "artifacts",
      "artifacts",
      "--archive-only",
      "--tag",
      `v${VERSION}`,
    ],
    { cwd: rootDir, encoding: "utf8", env: environment },
  );
  assert.equal(archiveOnly.status, 0, archiveOnly.stderr);
  assert.match(
    archiveOnly.stdout,
    /Release metadata and archived payloads verified for version 1\.2\.3/,
  );
  assert.match(
    archiveOnly.stdout,
    /extension ZIP-to-build comparison was explicitly skipped/,
  );
  assert.doesNotMatch(archiveOnly.stdout, /including extension ZIP-to-build/);
});

test("release artifact CLI rejects conflicting and repeated verification modes", () => {
  const scriptPath = join(REPOSITORY_ROOT, "scripts/release-preflight.mjs");
  const invalidModeArguments = [
    ["--require-build-match", "--archive-only"],
    ["--archive-only", "--require-build-match"],
    ["--require-build-match", "--require-build-match"],
    ["--archive-only", "--archive-only"],
  ];

  for (const modeArguments of invalidModeArguments) {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "artifacts", "artifacts", ...modeArguments],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, modeArguments.join(" "));
    assert.match(
      result.stderr,
      /Extension verification mode may be specified only once/,
    );
  }
});

test("release artifact CLI rejects verification modes for other commands", () => {
  const scriptPath = join(REPOSITORY_ROOT, "scripts/release-preflight.mjs");
  const invalidCommands = [
    ["metadata", "--archive-only"],
    ["npm-publish", "--ref", `refs/tags/v${VERSION}`, "--require-build-match"],
  ];

  for (const arguments_ of invalidCommands) {
    const result = spawnSync(process.execPath, [scriptPath, ...arguments_], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, arguments_.join(" "));
    assert.match(result.stderr, /is supported only by the artifacts command/);
  }
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

    const licenseBundleRoot = await createReleaseRoot(t);
    const licenseBundleArtifacts = await createArtifacts(licenseBundleRoot, {
      omitExtensionThirdPartyLicenses: true,
    });
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: licenseBundleRoot,
        artifactsDir: licenseBundleArtifacts.artifactsDir,
      }),
      /Missing THIRD_PARTY_LICENSES\.txt in extension zip THIRD_PARTY_LICENSES\.txt/,
    );

    const npmInventoryRoot = await createReleaseRoot(t);
    const npmInventoryArtifacts = await createArtifacts(npmInventoryRoot, {
      omitMcpInventory: true,
    });
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: npmInventoryRoot,
        artifactsDir: npmInventoryArtifacts.artifactsDir,
      }),
      /Missing package\/THIRD_PARTY_COMPONENTS\.json in npm tarball THIRD_PARTY_COMPONENTS\.json/,
    );

    const extensionInventoryRoot = await createReleaseRoot(t);
    const extensionInventoryArtifacts = await createArtifacts(
      extensionInventoryRoot,
      { omitExtensionInventory: true },
    );
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: extensionInventoryRoot,
        artifactsDir: extensionInventoryArtifacts.artifactsDir,
      }),
      /Missing THIRD_PARTY_COMPONENTS\.json in extension zip THIRD_PARTY_COMPONENTS\.json/,
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

    const licenseBundleRoot = await createReleaseRoot(t);
    const licenseBundleArtifacts = await createArtifacts(licenseBundleRoot, {
      extensionThirdPartyLicenses: "tampered third-party licenses\n",
    });
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: licenseBundleRoot,
        artifactsDir: licenseBundleArtifacts.artifactsDir,
      }),
      /extension zip THIRD_PARTY_LICENSES\.txt does not match the reviewed repository source/,
    );

    const npmInventoryRoot = await createReleaseRoot(t);
    const npmInventoryArtifacts = await createArtifacts(npmInventoryRoot, {
      mcpInventory: "tampered inventory\n",
    });
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: npmInventoryRoot,
        artifactsDir: npmInventoryArtifacts.artifactsDir,
      }),
      /npm tarball THIRD_PARTY_COMPONENTS\.json does not match the reviewed repository source/,
    );

    const extensionInventoryRoot = await createReleaseRoot(t);
    const extensionInventoryArtifacts = await createArtifacts(
      extensionInventoryRoot,
      { extensionInventory: "tampered inventory\n" },
    );
    await assert.rejects(
      verifyReleaseArtifacts({
        rootDir: extensionInventoryRoot,
        artifactsDir: extensionInventoryArtifacts.artifactsDir,
      }),
      /extension zip THIRD_PARTY_COMPONENTS\.json does not match the reviewed repository source/,
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
  await t.test(
    "when the published dependency closure is absent or drifts",
    async (t) => {
      const missingRoot = await createReleaseRoot(t);
      const missingArtifacts = await createArtifacts(missingRoot, {
        omitMcpShrinkwrap: true,
      });
      await assert.rejects(
        verifyReleaseArtifacts({
          rootDir: missingRoot,
          artifactsDir: missingArtifacts.artifactsDir,
        }),
        /Missing package\/npm-shrinkwrap\.json in npm tarball/,
      );

      const driftRoot = await createReleaseRoot(t);
      const driftArtifacts = await createArtifacts(driftRoot, {
        mcpShrinkwrap: "{}\n",
      });
      await assert.rejects(
        verifyReleaseArtifacts({
          rootDir: driftRoot,
          artifactsDir: driftArtifacts.artifactsDir,
        }),
        /npm-shrinkwrap\.json does not match the reviewed repository source/,
      );
    },
  );

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

  await t.test(
    "when the native log runner policy dependency is missing",
    async (t) => {
      const rootDir = await createReleaseRoot(t);
      const { artifactsDir } = await createArtifacts(rootDir, {
        omitMcpEntry: "package/dist/scripts/native-log-policy.js",
      });
      await assert.rejects(
        verifyReleaseArtifacts({ rootDir, artifactsDir }),
        /Missing package\/dist\/scripts\/native-log-policy\.js in npm tarball/,
      );
    },
  );

  await t.test(
    "when the native log runner gains an uncovered local dependency",
    async (t) => {
      const rootDir = await createReleaseRoot(t);
      const { artifactsDir } = await createArtifacts(rootDir, {
        mcpRunnerSource:
          "require('./native-log-policy');\nrequire('./missing-helper');\n",
      });
      await assert.rejects(
        verifyReleaseArtifacts({ rootDir, artifactsDir }),
        /native-log-runner\.js is missing local dependency \.\/missing-helper/,
      );
    },
  );

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
  const releaseIdentityJob = workflow.indexOf("  release-identity:");
  const platformGateJob = workflow.indexOf("  release-platform-gate:");
  const buildJob = workflow.indexOf("  build-assets:");
  const releaseIdentityBody = workflow.slice(
    releaseIdentityJob,
    platformGateJob,
  );
  const platformGateBody = workflow.slice(platformGateJob, buildJob);
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
  const githubTagShaReverify = workflow.indexOf(
    "      - name: Reverify release tag commit",
    githubJob,
  );
  const githubPublishStep = workflow.indexOf(
    "      - name: Publish GitHub Release",
    githubJob,
  );
  const npmJob = workflow.indexOf("  publish-npm:");
  const githubJobBody = workflow.slice(githubJob, npmJob);
  const githubJobHeader = workflow.slice(
    githubJob,
    workflow.indexOf("    steps:", githubJob),
  );
  const npmJobBody = workflow.slice(npmJob);
  const npmPublishRefPreflight = workflow.indexOf(
    "      - name: Verify npm publish ref",
    buildJob,
  );
  const npmJobHeader = workflow.slice(
    npmJob,
    workflow.indexOf("    steps:", npmJob),
  );
  const npmPublishRefReverify = workflow.indexOf(
    "      - name: Reverify npm publish ref",
    npmJob,
  );
  const npmPreflight = workflow.indexOf(
    "      - name: Reverify release metadata and artifacts",
    npmJob,
  );
  const npmTagShaReverify = workflow.indexOf(
    "      - name: Reverify release tag commit",
    npmJob,
  );
  const npmPublishStep = workflow.indexOf(
    "      - name: Publish package",
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
  assert.deepEqual(
    Array.from(
      workflow.matchAll(
        /^\s+run: node scripts\/release-preflight\.mjs artifacts artifacts (.+)$/gm,
      ),
      (match) => match[1],
    ),
    [
      '--require-build-match --tag "$RELEASE_TAG"',
      '--archive-only --tag "$GITHUB_REF_NAME"',
      '--archive-only --tag "$RELEASE_TAG"',
    ],
    "the build job must require ZIP-to-build matching while clean publish checkouts explicitly verify archives only",
  );
  assert.ok(
    releaseIdentityJob >= 0 &&
      platformGateJob > releaseIdentityJob &&
      buildJob > platformGateJob,
    "release identity and platform gates must precede artifact construction",
  );
  assert.match(
    releaseIdentityBody,
    /outputs:\s*\n\s+release_sha:\s*\$\{\{ steps\.bind_release_sha\.outputs\.release_sha \}\}/,
    "the release identity job must expose its immutable commit SHA",
  );
  assert.match(
    releaseIdentityBody,
    /ref:\s*\$\{\{ github\.sha \}\}\s*\n\s+fetch-depth:\s*0[\s\S]*git rev-parse "\$\{EVENT_RELEASE_SHA\}\^\{commit\}"/,
    "the release identity job must peel the event object to its exact commit",
  );
  assert.match(
    releaseIdentityBody,
    /Verify release commit ancestry before platform gates\s*\n\s+if: startsWith\(github\.ref, 'refs\/tags\/v'\)[\s\S]*EXPECTED_RELEASE_SHA: \$\{\{ steps\.bind_release_sha\.outputs\.release_sha \}\}[\s\S]*verify-release-tag-sha\.mjs --tag "\$GITHUB_REF_NAME" --expected-sha "\$EXPECTED_RELEASE_SHA"/,
    "tag releases must prove remote main ancestry before starting platform runners",
  );
  assert.match(
    releaseIdentityBody,
    /Verify npm publish ref before platform gates[\s\S]*if: github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.publish_npm == true\)[\s\S]*npm-publish --ref "\$GITHUB_REF"/,
    "invalid manual publish refs must fail before starting platform runners",
  );
  assert.match(
    platformGateBody,
    /needs:\s*release-identity[\s\S]*runs-on:\s*\$\{\{ matrix\.os \}\}/,
    "every platform gate must consume the bound release identity",
  );
  for (const [platform, os] of [
    ["Linux", "ubuntu-latest"],
    ["Windows", "windows-latest"],
    ["macOS", "macos-latest"],
  ]) {
    assert.match(
      platformGateBody,
      new RegExp(`platform: ${platform}\\r?\\n\\s+os: ${os}`),
      `${platform} must be an explicit release platform gate`,
    );
  }
  assert.equal(
    platformGateBody.match(/enforce_coverage:\s*true/g)?.length,
    1,
    "release coverage must run on exactly one platform",
  );
  assert.equal(
    platformGateBody.match(/enforce_coverage:\s*false/g)?.length,
    2,
    "the other release platforms must avoid duplicate coverage collection",
  );
  assert.match(
    platformGateBody,
    /ref:\s*\$\{\{ needs\.release-identity\.outputs\.release_sha \}\}[\s\S]*EXPECTED_RELEASE_SHA:\s*\$\{\{ needs\.release-identity\.outputs\.release_sha \}\}/,
    "platform checkouts must bind to the identity job output",
  );
  for (const requiredCheck of [
    /pnpm install --frozen-lockfile/,
    /pnpm audit --prod/,
    /pnpm legal:check/,
    /node scripts\/install-cargo-deny\.mjs --install-dir "\$RUNNER_TEMP\/webpage-mcp-cargo-deny"/,
    /"\$RUNNER_TEMP\/webpage-mcp-cargo-deny\/cargo-deny" --manifest-path packages\/wasm-simd\/Cargo\.toml --all-features check advisories/,
    /pnpm typecheck/,
    /pnpm --filter webpage-mcp-connector compile/,
    /pnpm test:release/,
    /pnpm test:workspace/,
    /pnpm -r --if-present test/,
    /pnpm build/,
    /node scripts\/verify-native-host-wrapper\.mjs/,
  ]) {
    assert.match(
      platformGateBody,
      requiredCheck,
      `platform gate is missing ${requiredCheck}`,
    );
  }
  assert.ok(
    platformGateBody.includes(
      "ENFORCE_COVERAGE: ${{ matrix.enforce_coverage && 'true' || 'false' }}",
    ),
    "coverage selection must come from the explicit platform matrix",
  );
  assert.match(
    platformGateBody,
    /real installed browser remains manual/,
    "the process smoke must not claim to cover an installed-browser handshake",
  );
  assert.match(
    workflow,
    /workflow_dispatch:[\s\S]*publish_npm:[\s\S]*default:\s*false/,
    "manual release builds must default to a non-publishing dry run",
  );
  assert.doesNotMatch(
    workflow.slice(buildJob, workflow.indexOf("    steps:", buildJob)),
    /^\s+if:/m,
    "manual dry-run builds must not skip the build job",
  );
  assert.ok(
    npmPublishRefPreflight > buildJob &&
      npmPublishRefPreflight < artifactPreflight,
    "publish requests must validate the triggering ref in the build job",
  );
  assert.match(
    buildJobBody.slice(npmPublishRefPreflight - buildJob),
    /if: github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.publish_npm == true\)[\s\S]*npm-publish --ref "\$GITHUB_REF"/,
    "tag pushes and manual publish requests must run the ref preflight",
  );
  assert.match(
    platformGateBody,
    /ENFORCE_COVERAGE:/,
    "release tests must enforce production coverage thresholds",
  );
  assert.match(
    platformGateBody,
    /pnpm test:workspace/,
    "release tests must include cross-platform workspace scripts",
  );
  assert.doesNotMatch(
    buildJobBody,
    /ENFORCE_COVERAGE|pnpm -r --if-present test/,
    "artifact construction must consume the completed gate instead of rerunning coverage",
  );
  assert.match(
    workflow.slice(buildJob, workflow.indexOf("    steps:", buildJob)),
    /needs:\s*\n\s+- release-identity\s*\n\s+- release-platform-gate[\s\S]*outputs:\s*\n\s+release_sha:/,
    "artifact construction must need both the identity and platform gates",
  );
  assert.match(
    buildJobBody,
    /ref:\s*\$\{\{ needs\.release-identity\.outputs\.release_sha \}\}[\s\S]*name:\s*release-assets-\$\{\{ steps\.verify_release_sha\.outputs\.release_sha \}\}/,
    "release artifacts must stay bound to the gated checkout SHA",
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
    buildJobBody.indexOf("Pack MCP npm package") <
      buildJobBody.indexOf("Verify fresh npm consumer dependency graph") &&
      buildJobBody.indexOf("Verify fresh npm consumer dependency graph") <
        buildJobBody.indexOf("Verify release artifacts"),
    "the exact MCP tarball must pass a fresh npm install and audit before artifact approval",
  );
  assert.match(
    buildJobBody,
    /node scripts\/verify-packed-mcp-consumer\.mjs "artifacts\/mcp\/webpage-mcp-\$\{PACKAGE_VERSION\}\.tgz"/,
  );
  assert.ok(
    githubJob > artifactPreflight,
    "GitHub release job must follow artifact preflight",
  );
  assert.match(
    githubJobHeader,
    /environment:\s*\n\s+name: github-release/,
    "GitHub asset publishing must use the protected github-release environment",
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
    githubTagShaReverify > githubJob &&
      githubPublishStep > githubTagShaReverify &&
      githubPublish > githubPublishStep,
    "GitHub release publishing must re-fetch and bind the remote tag immediately before mutation",
  );
  assert.equal(
    githubJobBody.match(/- name: Reverify release tag commit/g)?.length,
    1,
    "the GitHub publish job must perform exactly one final remote tag check",
  );
  assert.match(
    githubJobBody,
    /- name: Reverify release tag commit\s*\n\s+env:\s*\n\s+EXPECTED_RELEASE_SHA: \$\{\{ needs\.build-assets\.outputs\.release_sha \}\}\s*\n\s+run: node scripts\/verify-release-tag-sha\.mjs --tag "\$GITHUB_REF_NAME" --expected-sha "\$EXPECTED_RELEASE_SHA"\s*\n\s*\n\s+- name: Publish GitHub Release\s*\n\s+uses: softprops\/action-gh-release@/,
    "the GitHub tag check must be the step immediately before the release mutation",
  );
  assert.match(
    githubJobBody,
    /uses: softprops\/action-gh-release@[a-f0-9]{40}[\s\S]*?with:\s*\n\s+tag_name: \$\{\{ github\.ref_name \}\}\s*\n\s+target_commitish: \$\{\{ needs\.build-assets\.outputs\.release_sha \}\}/,
    "the GitHub release action must explicitly bind both its tag and gated target commit",
  );
  assert.match(
    githubJobBody,
    /Setup Node\.js for publish verification[\s\S]*uses: actions\/setup-node@[a-f0-9]{40}[\s\S]*node-version: 24[\s\S]*Reverify release metadata and artifacts/,
    "the GitHub publish job must pin Node 24 before its final JavaScript verification",
  );
  for (const publishJobBody of [githubJobBody, npmJobBody]) {
    assert.match(
      publishJobBody,
      /ref:\s*\$\{\{ needs\.build-assets\.outputs\.release_sha \}\}\s*\n\s+fetch-depth:\s*0/,
      "publish jobs must checkout the SHA propagated through needs",
    );
    assert.match(
      publishJobBody,
      /name:\s*release-assets-\$\{\{ needs\.build-assets\.outputs\.release_sha \}\}/,
      "publish jobs must download only the gated SHA artifact",
    );
  }
  assert.doesNotMatch(
    workflow,
    /release-assets-\$\{\{ github\.sha \}\}/,
    "artifact identity must come through needs rather than an ambient context",
  );
  assert.ok(
    npmPreflight > npmJob && npmPublish > npmPreflight,
    "npm publish must follow preflight",
  );
  assert.ok(
    npmTagShaReverify > npmPreflight &&
      npmPublishStep > npmTagShaReverify &&
      npmPublish > npmPublishStep,
    "npm publishing must re-fetch and bind the remote tag immediately before mutation",
  );
  assert.equal(
    npmJobBody.match(/- name: Reverify release tag commit/g)?.length,
    1,
    "the npm publish job must perform exactly one final remote tag check",
  );
  assert.match(
    npmJobBody,
    /- name: Reverify release tag commit\s*\n\s+env:\s*\n\s+EXPECTED_RELEASE_SHA: \$\{\{ needs\.build-assets\.outputs\.release_sha \}\}\s*\n\s+run: node scripts\/verify-release-tag-sha\.mjs --tag "\$GITHUB_REF_NAME" --expected-sha "\$EXPECTED_RELEASE_SHA"\s*\n\s*\n\s+- name: Publish package\s*\n\s+run:/,
    "the npm tag check must be the step immediately before npm publish",
  );
  assert.match(
    npmJobHeader,
    /if: startsWith\(github\.ref, 'refs\/tags\/v'\) && \(github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.publish_npm == true\)\)/,
    "npm publishing must be limited to v-prefixed tag refs",
  );
  assert.match(
    npmJobHeader,
    /environment:\s*\n\s+name: npm-publish/,
    "npm publishing must use the protected npm-publish environment",
  );
  assert.ok(
    npmPublishRefReverify > npmJob && npmPreflight > npmPublishRefReverify,
    "the npm job must revalidate its exact publish ref before artifact verification",
  );
  assert.match(
    workflow.slice(npmPublishRefReverify, npmPreflight),
    /npm-publish --ref "\$GITHUB_REF"/,
    "the npm job must bind publishing to the full GitHub ref",
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
    /action-gh-release|^\s*npm publish(?:\s|$)/m,
    "build and verification must not mutate a release",
  );
});

test("release native wrapper smoke exercises the platform process boundary", async () => {
  const source = await readFile(
    join(REPOSITORY_ROOT, "scripts/verify-native-host-wrapper.mjs"),
    "utf8",
  );

  assert.match(
    source,
    /process\.platform === "win32"\s*\? "run_host\.bat"\s*: "run_host\.sh"/,
  );
  assert.match(source, /type: "ping_from_extension"/);
  assert.match(source, /response\.type === "pong_to_extension"/);
  assert.match(source, /WEBPAGE_MCP_NODE_PATH: process\.execPath/);
  assert.match(source, /WEBPAGE_MCP_NATIVE_SOCKET: socketPath\(smokeRoot\)/);
  assert.match(source, /contents withheld/);
  assert.doesNotMatch(source, /stderr\.(?:subarray|toString)/);
});

test("release native wrapper smoke withholds child stderr on failure", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "webpage-mcp-wrapper-failure-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await mkdir(join(distDir, "scripts"), { recursive: true });
  await writeFile(join(distDir, "index.js"), "module.exports = {};\n");
  await writeFile(
    join(distDir, "scripts/native-log-runner.js"),
    "module.exports = {};\n",
  );

  const secretMarker = "native-wrapper-secret-stderr-marker";
  const wrapperName =
    process.platform === "win32" ? "run_host.bat" : "run_host.sh";
  const wrapperPath = join(distDir, wrapperName);
  const wrapperSource =
    process.platform === "win32"
      ? `@echo off\r\necho ${secretMarker} 1>&2\r\nexit /b 7\r\n`
      : `#!/usr/bin/env bash\nprintf '%s\\n' '${secretMarker}' >&2\nexit 7\n`;
  await writeFile(wrapperPath, wrapperSource);
  if (process.platform !== "win32") await chmod(wrapperPath, 0o755);

  const result = spawnSync(
    process.execPath,
    [join(REPOSITORY_ROOT, "scripts/verify-native-host-wrapper.mjs")],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        WEBPAGE_MCP_NATIVE_WRAPPER_DIST_DIR: distDir,
      },
    },
  );
  const diagnostics = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(diagnostics, new RegExp(secretMarker));
  assert.match(
    diagnostics,
    /stderr captured \d+ bytes(?:; output limit reached)?; contents withheld/,
  );
});

test("dependency security gates cover npm and Cargo continuously", async () => {
  const [
    ciWorkflow,
    releaseWorkflow,
    securityWorkflow,
    dependabot,
    cargoDenyTool,
  ] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, ".github/workflows/ci.yml"), "utf8"),
    readFile(join(REPOSITORY_ROOT, ".github/workflows/release.yml"), "utf8"),
    readFile(
      join(REPOSITORY_ROOT, ".github/workflows/dependency-security.yml"),
      "utf8",
    ),
    readFile(join(REPOSITORY_ROOT, ".github/dependabot.yml"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "scripts/cargo-deny-tool.json"), "utf8"),
  ]);
  const cargoDeny = JSON.parse(cargoDenyTool);
  assert.equal(cargoDeny.version, "0.19.8");
  assert.equal(cargoDeny.rustToolchain, "1.94.0");
  assert.equal(cargoDeny.archive.size, 4_983_961);
  assert.equal(
    cargoDeny.archive.sha256,
    "70e769ae3872e34d45132b17040859175e11401dc12dddb0303e0b8c7d088f3f",
  );
  assert.equal(cargoDeny.binary.size, 8_951_120);
  assert.equal(
    cargoDeny.binary.sha256,
    "f84bbd8f18ca59d531b848bad2f39237b17b5980d7f9cdd373d81f6689eb685f",
  );

  assert.match(
    ciWorkflow,
    /Audit production npm dependencies\s*\n\s+if: matrix\.node-version == 24\s*\n\s+run: pnpm audit --prod/,
    "CI must audit the production npm graph once on its maintained Node line",
  );
  assert.match(
    ciWorkflow,
    /Verify reviewed legal notices\s*\n\s+if: matrix\.node-version == 24\s*\n\s+run: pnpm legal:check/,
    "CI must expose legal inventory verification as an explicit maintained-line gate",
  );

  const releasePlatformGate = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  release-platform-gate:"),
    releaseWorkflow.indexOf("  build-assets:"),
  );
  for (const [name, source] of [
    ["CI", ciWorkflow],
    ["release", releasePlatformGate],
    ["scheduled dependency security", securityWorkflow],
  ]) {
    assert.match(
      source,
      /pnpm audit --prod/,
      `${name} must fail on production npm advisories`,
    );
    assert.match(
      source,
      /pnpm shrinkwrap:mcp:check\s*\n\s+pnpm shrinkwrap:mcp:check-current\s*\n\s+npm audit --omit=dev --package-lock-only --prefix app\/mcp-server --audit-level=low\s*\n\s+pnpm audit:mcp-bundle/,
      `${name} must validate and audit the published MCP dependency closure`,
    );
    assert.doesNotMatch(
      source,
      /EmbarkStudios\/cargo-deny-action/,
      `${name} must not delegate binary acquisition to a mutable action implementation`,
    );
    assert.match(
      source,
      /rustup toolchain install 1\.94\.0 --profile minimal/,
      `${name} must install the pinned Rust toolchain`,
    );
    assert.match(
      source,
      /rustup default 1\.94\.0/,
      `${name} must select the pinned Rust toolchain`,
    );
    assert.match(
      source,
      /node scripts\/install-cargo-deny\.mjs --install-dir "\$RUNNER_TEMP\/webpage-mcp-cargo-deny"/,
      `${name} must install the byte-pinned cargo-deny binary`,
    );
    assert.match(
      source,
      /cargo metadata --manifest-path packages\/wasm-simd\/Cargo\.toml --all-features --locked --format-version 1 > \/dev\/null/,
      `${name} must validate the committed Cargo graph`,
    );
    const auditCommand = source
      .split(/\r?\n/)
      .find((line) =>
        line.includes(
          '"$RUNNER_TEMP/webpage-mcp-cargo-deny/cargo-deny" --manifest-path',
        ),
      );
    assert.ok(
      auditCommand,
      `${name} must execute cargo-deny through its absolute verified path`,
    );
    assert.match(
      auditCommand,
      /--manifest-path packages\/wasm-simd\/Cargo\.toml --all-features check advisories$/,
      `${name} must scan the complete production Rust graph`,
    );
    assert.doesNotMatch(
      auditCommand,
      /--locked|--offline|--frozen|--disable-fetch/,
      `${name} must leave live advisory-database refresh enabled`,
    );
    assert.match(
      source,
      /git diff --exit-code -- packages\/wasm-simd\/Cargo\.lock/,
      `${name} must fail if scanning changes the committed lockfile`,
    );
    assert.match(
      source,
      /cargo metadata --manifest-path packages\/wasm-simd\/Cargo\.toml --all-features --locked --format-version 1 > \/dev\/null\s*\n\s+"\$RUNNER_TEMP\/webpage-mcp-cargo-deny\/cargo-deny" --manifest-path packages\/wasm-simd\/Cargo\.toml --all-features check advisories\s*\n\s+git diff --exit-code -- packages\/wasm-simd\/Cargo\.lock/,
      `${name} must keep locked-graph validation, live advisory refresh, and mutation detection adjacent`,
    );
  }

  assert.match(
    releasePlatformGate,
    /Audit production npm dependencies once on Linux\s*\n\s+if: matrix\.enforce_coverage\s*\n\s+run: pnpm audit --prod/,
    "the release npm advisory gate must run once on Linux",
  );
  assert.match(
    releasePlatformGate,
    /Install verified cargo-deny once on Linux\s*\n\s+if: matrix\.enforce_coverage\s*\n\s+run: node scripts\/install-cargo-deny\.mjs[^\n]*\s*\n[\s\S]*?Audit Rust dependencies once on Linux\s*\n\s+if: matrix\.enforce_coverage\s*\n\s+run:/,
    "the verified release Rust advisory gate must run only on Linux",
  );

  assert.match(
    securityWorkflow,
    /on:\s*\n\s+schedule:\s*\n\s+- cron: ["']17 4 \* \* \*["']\s*\n\s+workflow_dispatch:/,
    "dependency security must run daily and support manual dispatch",
  );
  assert.match(
    securityWorkflow,
    /permissions:\s*\n\s+contents: read/,
    "the advisory workflow must be read-only",
  );
  assert.doesNotMatch(
    securityWorkflow,
    /pnpm install/,
    "the advisory-only workflow must not execute dependency lifecycle code",
  );

  const securityGates = [
    ciWorkflow,
    releasePlatformGate,
    securityWorkflow,
  ].join("\n");
  assert.doesNotMatch(
    securityGates,
    /continue-on-error|ignore-registry-errors|\|\|\s*true/,
    "dependency advisory gates must fail closed",
  );

  for (const [ecosystem, directory] of [
    ["github-actions", "/"],
    ["npm", "/"],
    ["cargo", "/packages/wasm-simd"],
  ]) {
    const escapedDirectory = directory.replaceAll("/", "\\/");
    const entryPattern = new RegExp(
      `package-ecosystem: ${ecosystem}\\r?\\n` +
        `\\s+directory: ["']${escapedDirectory}["']\\r?\\n` +
        `\\s+schedule:\\r?\\n\\s+interval: weekly\\r?\\n` +
        `\\s+open-pull-requests-limit: 5`,
      "g",
    );
    assert.equal(
      Array.from(dependabot.matchAll(entryPattern)).length,
      1,
      `Dependabot must cover ${ecosystem} at ${directory} exactly once`,
    );
  }
});

test("CI workflows use maintained runtimes and reviewed actions", async () => {
  const workflowPaths = [
    join(REPOSITORY_ROOT, ".github/workflows/ci.yml"),
    join(REPOSITORY_ROOT, ".github/workflows/release.yml"),
    join(REPOSITORY_ROOT, ".github/workflows/dependency-security.yml"),
  ];
  const workflows = await Promise.all(
    workflowPaths.map((workflowPath) => readFile(workflowPath, "utf8")),
  );
  const rootPackage = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  const combined = workflows.join("\n");

  assert.doesNotMatch(
    combined,
    /node-version:\s*["']?20(?:["']?|\s|$)/,
    "EOL Node.js 20 must not be used by CI jobs",
  );
  assert.match(
    workflows[0],
    /node-version:\s*\[22, 24\]/,
    "CI must verify both supported LTS release lines",
  );

  const reviewedActionCommits = new Set([
    "df4cb1c069e1874edd31b4311f1884172cec0e10", // actions/checkout v6.0.3
    "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e", // actions/setup-node v6.4.0
    "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", // actions/upload-artifact v7.0.1
    "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", // actions/download-artifact v8.0.1
    "fc06bc1257f339d1d5d8b3a19a8cae5388b55320", // pnpm/action-setup v5.0.0
    "718ea10b132b3b2eba29c1007bb80653f286566b", // softprops/action-gh-release v3.0.1
  ]);
  const actionReferences = Array.from(
    combined.matchAll(/^\s*uses:\s*([^\s#]+)/gm),
    (match) => match[1],
  );
  assert.ok(actionReferences.length > 0, "workflows must use remote actions");
  for (const reference of actionReferences) {
    assert.match(
      reference,
      /^[^@]+@[a-f0-9]{40}$/,
      `remote action must be pinned to a full commit SHA: ${reference}`,
    );
    const separator = reference.lastIndexOf("@");
    const action = reference.slice(0, separator);
    const commit = reference.slice(separator + 1);
    assert.ok(
      reviewedActionCommits.has(commit),
      `${action} must be pinned to a reviewed action release`,
    );
  }

  const pnpmSetupReferences = Array.from(
    combined.matchAll(
      /uses: pnpm\/action-setup@[a-f0-9]{40}[\s\S]{0,180}?version:\s*([^\s]+)/g,
    ),
    (match) => match[1],
  );
  const pnpmSetupCount = Array.from(
    combined.matchAll(/^\s*uses: pnpm\/action-setup@/gm),
  ).length;
  assert.ok(pnpmSetupCount > 0, "workflows must pin pnpm");
  assert.equal(
    pnpmSetupReferences.length,
    pnpmSetupCount,
    "every pnpm setup step must declare a reviewed version",
  );
  const reviewedPackageManager =
    "pnpm@10.34.5+sha512.a4ee05f2f73658255bd6a89859c065a45c28a57daefae2c893a168ee2b73168c37b91e83e57ea67654ad03f03031746430e8bce38e362e042605fb8abc80192e";
  assert.equal(
    rootPackage.packageManager,
    reviewedPackageManager,
    "the repository must pin the reviewed pnpm tarball for Corepack",
  );
  const packageManagerMatch =
    /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([a-f0-9]{128})$/.exec(
      rootPackage.packageManager,
    );
  assert.ok(
    packageManagerMatch,
    "the repository pnpm contract must include a full SHA-512 integrity digest",
  );
  const repositoryPnpmVersion = packageManagerMatch[1];
  assert.ok(
    pnpmSetupReferences.every((version) => version === repositoryPnpmVersion),
    `workflow pnpm versions must match packageManager ${repositoryPnpmVersion}: ${pnpmSetupReferences.join(", ")}`,
  );
});
