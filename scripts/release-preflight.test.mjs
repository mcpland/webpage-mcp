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
import { parseDocument } from "yaml";

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

function parseYaml(source, label) {
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  assert.equal(
    document.errors.length,
    0,
    `${label} must be valid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
  );
  const value = document.toJS({ maxAliasCount: 0 });
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value;
}

async function readYaml(relativePath) {
  const source = await readFile(join(REPOSITORY_ROOT, relativePath), "utf8");
  return parseYaml(source, relativePath);
}

function workflowJob(workflow, jobId) {
  const job = workflow.jobs?.[jobId];
  assert.ok(job && typeof job === "object", `workflow job ${jobId} must exist`);
  return job;
}

function workflowSteps(job) {
  assert.ok(Array.isArray(job.steps), "workflow job must define steps");
  return job.steps;
}

function namedStep(job, name) {
  const matches = workflowSteps(job).filter((step) => step.name === name);
  assert.equal(
    matches.length,
    1,
    `workflow step ${name} must exist exactly once`,
  );
  return matches[0];
}

function assertStepOrder(job, names) {
  const actual = workflowSteps(job).map((step) => step.name);
  let previous = -1;
  let previousName = "job start";
  for (const name of names) {
    const index = actual.indexOf(name);
    assert.ok(
      index > previous,
      `workflow step ${name} must follow ${previousName}`,
    );
    previous = index;
    previousName = name;
  }
}

function joinedRunScripts(job) {
  return workflowSteps(job)
    .map((step) => (typeof step.run === "string" ? step.run : ""))
    .join("\n");
}

function allWorkflowSteps(workflow) {
  return Object.values(workflow.jobs ?? {}).flatMap((job) =>
    workflowSteps(job),
  );
}

function joinedWorkflowRunScripts(workflow) {
  return Object.values(workflow.jobs ?? {})
    .map((job) => joinedRunScripts(job))
    .join("\n");
}

function actionReferences(workflow) {
  return allWorkflowSteps(workflow)
    .map((step) => step.uses)
    .filter((reference) => typeof reference === "string");
}
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

test("release workflow enforces structural publish contracts", async () => {
  const workflow = await readYaml(".github/workflows/release.yml");
  assert.deepEqual(Object.keys(workflow.jobs), [
    "release-identity",
    "release-platform-gate",
    "build-assets",
    "publish-github-release",
    "publish-npm",
  ]);
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.publish_npm, {
    description: "Publish webpage-mcp to npm",
    required: false,
    default: false,
    type: "boolean",
  });
  assert.deepEqual(workflow.env, {
    CHROME_EXTENSION_PUBLIC_KEY: "${{ vars.CHROME_EXTENSION_PUBLIC_KEY }}",
    CHROME_EXTENSION_EXPECTED_ID: "iehgbogeakiedihodennfcnigojnncag",
    WEBPAGE_MCP_REQUIRE_EXTENSION_PUBLIC_KEY: "true",
  });

  const identity = workflowJob(workflow, "release-identity");
  const platformGate = workflowJob(workflow, "release-platform-gate");
  const build = workflowJob(workflow, "build-assets");
  const githubPublish = workflowJob(workflow, "publish-github-release");
  const npmPublish = workflowJob(workflow, "publish-npm");

  assert.deepEqual(identity.outputs, {
    release_sha: "${{ steps.bind_release_sha.outputs.release_sha }}",
  });
  const identityCheckout = namedStep(identity, "Checkout event object");
  assert.deepEqual(identityCheckout.with, {
    ref: "${{ github.sha }}",
    "fetch-depth": 0,
  });
  const bindIdentity = namedStep(identity, "Bind exact release commit");
  assert.equal(bindIdentity.id, "bind_release_sha");
  assert.equal(bindIdentity.env.EVENT_RELEASE_SHA, "${{ github.sha }}");
  assert.ok(
    bindIdentity.run.includes('git rev-parse "${EVENT_RELEASE_SHA}^{commit}"'),
  );
  assert.ok(
    bindIdentity.run.includes(
      'echo "release_sha=$ACTUAL_RELEASE_SHA" >> "$GITHUB_OUTPUT"',
    ),
  );

  const metadataBeforeGates = namedStep(
    identity,
    "Verify release metadata before platform gates",
  );
  assert.equal(
    metadataBeforeGates.run,
    'node scripts/release-preflight.mjs metadata --tag "$RELEASE_TAG"',
  );
  const ancestryBeforeGates = namedStep(
    identity,
    "Verify release commit ancestry before platform gates",
  );
  assert.equal(ancestryBeforeGates.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.equal(
    ancestryBeforeGates.env.EXPECTED_RELEASE_SHA,
    "${{ steps.bind_release_sha.outputs.release_sha }}",
  );
  assert.equal(
    ancestryBeforeGates.run,
    'node scripts/verify-release-tag-sha.mjs --tag "$GITHUB_REF_NAME" --expected-sha "$EXPECTED_RELEASE_SHA"',
  );
  const publishRefBeforeGates = namedStep(
    identity,
    "Verify npm publish ref before platform gates",
  );
  assert.equal(
    publishRefBeforeGates.if,
    "github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.publish_npm == true)",
  );
  assert.equal(
    publishRefBeforeGates.run,
    'node scripts/release-preflight.mjs npm-publish --ref "$GITHUB_REF"',
  );

  assert.equal(platformGate.needs, "release-identity");
  assert.equal(platformGate["runs-on"], "${{ matrix.os }}");
  assert.deepEqual(platformGate.strategy.matrix.include, [
    { platform: "Linux", os: "ubuntu-latest", enforce_coverage: true },
    { platform: "Windows", os: "windows-latest", enforce_coverage: false },
    { platform: "macOS", os: "macos-latest", enforce_coverage: false },
  ]);
  const platformCheckout = namedStep(
    platformGate,
    "Checkout exact release commit",
  );
  assert.equal(
    platformCheckout.with.ref,
    "${{ needs.release-identity.outputs.release_sha }}",
  );
  const exactPlatformCheckout = namedStep(
    platformGate,
    "Verify exact release checkout",
  );
  assert.equal(
    exactPlatformCheckout.env.EXPECTED_RELEASE_SHA,
    "${{ needs.release-identity.outputs.release_sha }}",
  );
  const platformScripts = joinedRunScripts(platformGate);
  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm audit --prod",
    "pnpm legal:check",
    'node scripts/install-cargo-deny.mjs --install-dir "$RUNNER_TEMP/webpage-mcp-cargo-deny"',
    '"$RUNNER_TEMP/webpage-mcp-cargo-deny/cargo-deny" --config deny.toml',
    "pnpm typecheck",
    "pnpm --filter webpage-mcp-connector compile",
    "pnpm test:release",
    "pnpm test:workspace",
    "pnpm -r --if-present test",
    "pnpm build",
    "node scripts/verify-native-host-wrapper.mjs",
  ]) {
    assert.ok(
      platformScripts.includes(command),
      "platform gate is missing " + command,
    );
  }
  for (const name of [
    "Audit production npm dependencies once on Linux",
    "Audit published MCP dependency closure once on Linux",
    "Verify reviewed legal notices once on Linux",
    "Install pinned Rust for advisory scan once on Linux",
    "Install verified cargo-deny once on Linux",
    "Audit Rust dependencies once on Linux",
    "Lint once on Linux",
  ]) {
    assert.equal(namedStep(platformGate, name).if, "matrix.enforce_coverage");
  }
  assert.equal(
    namedStep(platformGate, "Test workspace").env.ENFORCE_COVERAGE,
    "${{ matrix.enforce_coverage && 'true' || 'false' }}",
  );

  assert.deepEqual(build.needs, ["release-identity", "release-platform-gate"]);
  assert.equal(build.if, undefined);
  assert.deepEqual(build.outputs, {
    release_sha: "${{ steps.verify_release_sha.outputs.release_sha }}",
  });
  assert.equal(
    namedStep(build, "Checkout exact gated commit").with.ref,
    "${{ needs.release-identity.outputs.release_sha }}",
  );
  assertStepOrder(build, [
    "Verify npm publish ref",
    "Install verified wasm-pack",
    "Verify reproducible WASM runtime",
    "Pack MCP npm package",
    "Verify fresh npm consumer dependency graph",
    "Verify release artifacts against extension build",
    "Upload release artifacts",
  ]);
  const buildPublishRef = namedStep(build, "Verify npm publish ref");
  assert.equal(
    buildPublishRef.if,
    "github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.publish_npm == true)",
  );
  assert.equal(
    buildPublishRef.run,
    'node scripts/release-preflight.mjs npm-publish --ref "$GITHUB_REF"',
  );
  assert.equal(
    namedStep(build, "Install verified wasm-pack").run,
    'node scripts/install-wasm-pack.mjs --install-dir "$RUNNER_TEMP/webpage-mcp-wasm-pack"',
  );
  const wasmVerification = namedStep(build, "Verify reproducible WASM runtime");
  assert.equal(
    wasmVerification.env.WASM_PACK_BINARY,
    "${{ runner.temp }}/webpage-mcp-wasm-pack/wasm-pack",
  );
  assert.ok(wasmVerification.run.includes("cargo test --manifest-path"));
  assert.ok(wasmVerification.run.includes("pnpm verify:wasm"));
  assert.ok(!joinedRunScripts(build).includes("pnpm -r --if-present test"));
  assert.ok(!joinedRunScripts(build).includes("cargo install wasm-pack"));
  assert.deepEqual(namedStep(build, "Upload release artifacts").with, {
    name: "release-assets-${{ steps.verify_release_sha.outputs.release_sha }}",
    path: "artifacts/",
    "if-no-files-found": "error",
    "retention-days": 30,
  });

  const artifactVerificationRuns = [
    namedStep(build, "Verify release artifacts against extension build").run,
    namedStep(
      githubPublish,
      "Reverify release metadata and artifacts (archive-only; no build directory)",
    ).run,
    namedStep(
      npmPublish,
      "Reverify release metadata and artifacts (archive-only; no build directory)",
    ).run,
  ];
  assert.deepEqual(artifactVerificationRuns, [
    'node scripts/release-preflight.mjs artifacts artifacts --require-build-match --tag "$RELEASE_TAG"',
    'node scripts/release-preflight.mjs artifacts artifacts --archive-only --tag "$GITHUB_REF_NAME"',
    'node scripts/release-preflight.mjs artifacts artifacts --archive-only --tag "$RELEASE_TAG"',
  ]);

  for (const publishJob of [githubPublish, npmPublish]) {
    assert.equal(publishJob.needs, "build-assets");
    assert.deepEqual(
      namedStep(publishJob, "Checkout exact gated commit").with,
      {
        ref: "${{ needs.build-assets.outputs.release_sha }}",
        "fetch-depth": 0,
      },
    );
    assert.deepEqual(
      namedStep(publishJob, "Download verified release artifacts").with,
      {
        name: "release-assets-${{ needs.build-assets.outputs.release_sha }}",
        path: "artifacts",
      },
    );
  }

  assert.equal(githubPublish.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.deepEqual(githubPublish.environment, { name: "github-release" });
  assert.deepEqual(githubPublish.permissions, { contents: "write" });
  assertStepOrder(githubPublish, [
    "Setup Node.js for publish verification",
    "Reverify release metadata and artifacts (archive-only; no build directory)",
    "Reverify release tag commit",
    "Publish GitHub Release",
  ]);
  const githubSteps = workflowSteps(githubPublish);
  const githubTagCheckIndex = githubSteps.findIndex(
    (step) => step.name === "Reverify release tag commit",
  );
  assert.equal(
    githubSteps[githubTagCheckIndex + 1].name,
    "Publish GitHub Release",
  );
  const githubTagCheck = namedStep(
    githubPublish,
    "Reverify release tag commit",
  );
  assert.equal(
    githubTagCheck.env.EXPECTED_RELEASE_SHA,
    "${{ needs.build-assets.outputs.release_sha }}",
  );
  assert.equal(
    githubTagCheck.run,
    'node scripts/verify-release-tag-sha.mjs --tag "$GITHUB_REF_NAME" --expected-sha "$EXPECTED_RELEASE_SHA"',
  );
  const githubMutation = namedStep(githubPublish, "Publish GitHub Release");
  assert.match(
    githubMutation.uses,
    /^softprops\/action-gh-release@[a-f0-9]{40}$/,
  );
  assert.equal(githubMutation.with.tag_name, "${{ github.ref_name }}");
  assert.equal(
    githubMutation.with.target_commitish,
    "${{ needs.build-assets.outputs.release_sha }}",
  );
  assert.equal(
    namedStep(githubPublish, "Setup Node.js for publish verification").with[
      "node-version"
    ],
    24,
  );

  assert.equal(
    npmPublish.if,
    "startsWith(github.ref, 'refs/tags/v') && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.publish_npm == true))",
  );
  assert.deepEqual(npmPublish.environment, { name: "npm-publish" });
  assert.deepEqual(npmPublish.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assertStepOrder(npmPublish, [
    "Reverify npm publish ref",
    "Reverify release metadata and artifacts (archive-only; no build directory)",
    "Setup Node.js for npm publish",
    "Ensure NPM token is configured",
    "Reverify release tag commit",
    "Publish package",
  ]);
  const npmSteps = workflowSteps(npmPublish);
  const npmTagCheckIndex = npmSteps.findIndex(
    (step) => step.name === "Reverify release tag commit",
  );
  assert.equal(npmSteps[npmTagCheckIndex + 1].name, "Publish package");
  assert.equal(
    namedStep(npmPublish, "Reverify npm publish ref").run,
    'node scripts/release-preflight.mjs npm-publish --ref "$GITHUB_REF"',
  );
  const npmTagCheck = namedStep(npmPublish, "Reverify release tag commit");
  assert.equal(
    npmTagCheck.env.EXPECTED_RELEASE_SHA,
    "${{ needs.build-assets.outputs.release_sha }}",
  );
  assert.equal(
    npmTagCheck.run,
    'node scripts/verify-release-tag-sha.mjs --tag "$GITHUB_REF_NAME" --expected-sha "$EXPECTED_RELEASE_SHA"',
  );
  const npmMutation = namedStep(npmPublish, "Publish package");
  assert.ok(
    npmMutation.run.includes("--provenance --access public --tag latest"),
  );
  assert.equal(
    npmMutation.env.NODE_AUTH_TOKEN,
    "${{ secrets.NPM_AUTH_TOKEN }}",
  );

  assert.ok(
    !actionReferences({ jobs: { build } }).some((reference) =>
      reference.startsWith("softprops/action-gh-release@"),
    ),
  );
  assert.ok(!joinedRunScripts(build).includes("npm publish"));
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

test("dependency security gates encode reviewed commands structurally", async () => {
  const [
    ci,
    release,
    security,
    dependabot,
    cargoDenyTool,
    wasmPackTool,
    cargoDenyPolicy,
  ] = await Promise.all([
    readYaml(".github/workflows/ci.yml"),
    readYaml(".github/workflows/release.yml"),
    readYaml(".github/workflows/dependency-security.yml"),
    readYaml(".github/dependabot.yml"),
    readFile(join(REPOSITORY_ROOT, "scripts/cargo-deny-tool.json"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "scripts/wasm-pack-tool.json"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "deny.toml"), "utf8"),
  ]);

  const cargoDeny = JSON.parse(cargoDenyTool);
  const wasmPack = JSON.parse(wasmPackTool);
  assert.deepEqual(
    {
      version: cargoDeny.version,
      rustToolchain: cargoDeny.rustToolchain,
      archiveSize: cargoDeny.archive.size,
      archiveSha256: cargoDeny.archive.sha256,
      binarySize: cargoDeny.binary.size,
      binarySha256: cargoDeny.binary.sha256,
    },
    {
      version: "0.19.8",
      rustToolchain: "1.94.0",
      archiveSize: 4_983_961,
      archiveSha256:
        "70e769ae3872e34d45132b17040859175e11401dc12dddb0303e0b8c7d088f3f",
      binarySize: 8_951_120,
      binarySha256:
        "f84bbd8f18ca59d531b848bad2f39237b17b5980d7f9cdd373d81f6689eb685f",
    },
  );
  assert.deepEqual(
    {
      version: wasmPack.version,
      archiveSha256: wasmPack.archive.sha256,
      binarySha256: wasmPack.binary.sha256,
    },
    {
      version: "0.15.0",
      archiveSha256:
        "c09f971ecaed9a2efc80fdcea7a00ef6b53c7fadc8c57d1f61b53a6aa66b668a",
      binarySha256:
        "c6c3d54702f4bae4a1d51e37e19c2c61b130865dc3fabc745eebe8194b87b253",
    },
  );
  assert.equal(
    cargoDenyPolicy,
    '[advisories]\nyanked = "deny"\nunmaintained = "all"\nunsound = "all"\nunused-ignored-advisory = "deny"\nignore = []\n',
  );

  const publishedClosureCommands = [
    "pnpm shrinkwrap:mcp:check",
    "pnpm shrinkwrap:mcp:check-current",
    "npm audit --omit=dev --package-lock-only --prefix app/mcp-server --audit-level=low",
    "pnpm audit:mcp-bundle",
  ];
  const rustAuditCommands = [
    "cargo metadata --manifest-path packages/wasm-simd/Cargo.toml --all-features --locked --format-version 1 > /dev/null",
    '"$RUNNER_TEMP/webpage-mcp-cargo-deny/cargo-deny" --config deny.toml --manifest-path packages/wasm-simd/Cargo.toml --all-features check advisories',
    "git diff --exit-code -- packages/wasm-simd/Cargo.lock",
  ];
  const gates = [
    {
      name: "CI",
      workflow: ci,
      npmJob: "verify",
      npmAudit: "Audit production npm dependencies",
      closureAudit: "Audit published MCP dependency closure",
      rustJob: "wasm-artifacts",
      rustInstall: "Install pinned Rust toolchain",
      denyInstall: "Install verified cargo-deny",
      rustAudit: "Audit Rust dependencies",
    },
    {
      name: "release",
      workflow: release,
      npmJob: "release-platform-gate",
      npmAudit: "Audit production npm dependencies once on Linux",
      closureAudit: "Audit published MCP dependency closure once on Linux",
      rustJob: "release-platform-gate",
      rustInstall: "Install pinned Rust for advisory scan once on Linux",
      denyInstall: "Install verified cargo-deny once on Linux",
      rustAudit: "Audit Rust dependencies once on Linux",
    },
    {
      name: "scheduled dependency security",
      workflow: security,
      npmJob: "audit",
      npmAudit: "Audit production npm dependencies",
      closureAudit: "Audit published MCP dependency closure",
      rustJob: "audit",
      rustInstall: "Install pinned Rust toolchain",
      denyInstall: "Install verified cargo-deny",
      rustAudit: "Audit Rust dependencies",
    },
  ];

  for (const gate of gates) {
    const npmJob = workflowJob(gate.workflow, gate.npmJob);
    const rustJob = workflowJob(gate.workflow, gate.rustJob);
    assert.equal(namedStep(npmJob, gate.npmAudit).run, "pnpm audit --prod");
    assert.deepEqual(
      namedStep(npmJob, gate.closureAudit).run.trim().split("\n"),
      publishedClosureCommands,
    );
    const rustInstall = namedStep(rustJob, gate.rustInstall).run;
    assert.ok(
      rustInstall.includes("rustup toolchain install 1.94.0 --profile minimal"),
    );
    assert.ok(rustInstall.includes("rustup default 1.94.0"));
    assert.equal(
      namedStep(rustJob, gate.denyInstall).run,
      'node scripts/install-cargo-deny.mjs --install-dir "$RUNNER_TEMP/webpage-mcp-cargo-deny"',
    );
    const rustAudit = namedStep(rustJob, gate.rustAudit).run.trim().split("\n");
    assert.deepEqual(rustAudit, rustAuditCommands);
    assert.ok(
      !rustAudit[1].includes("--locked") &&
        !rustAudit[1].includes("--offline") &&
        !rustAudit[1].includes("--frozen") &&
        !rustAudit[1].includes("--disable-fetch"),
      gate.name + " must keep the live advisory refresh enabled",
    );
    assert.ok(
      !actionReferences(gate.workflow).some((reference) =>
        reference.startsWith("EmbarkStudios/cargo-deny-action@"),
      ),
    );
    for (const guardedJob of new Set([npmJob, rustJob])) {
      for (const step of workflowSteps(guardedJob)) {
        assert.notEqual(step["continue-on-error"], true);
        if (typeof step.run === "string") {
          assert.ok(!step.run.includes("ignore-registry-errors"));
          assert.ok(!step.run.includes("|| true"));
        }
      }
    }
  }

  const ciVerify = workflowJob(ci, "verify");
  assert.equal(
    namedStep(ciVerify, "Audit production npm dependencies").if,
    "matrix.node-version == 24",
  );
  assert.equal(
    namedStep(ciVerify, "Verify reviewed legal notices").if,
    "matrix.node-version == 24",
  );
  const releaseGate = workflowJob(release, "release-platform-gate");
  for (const name of [
    "Audit production npm dependencies once on Linux",
    "Install verified cargo-deny once on Linux",
    "Audit Rust dependencies once on Linux",
  ]) {
    assert.equal(namedStep(releaseGate, name).if, "matrix.enforce_coverage");
  }

  for (const [name, job] of [
    ["CI WASM rebuild", workflowJob(ci, "wasm-artifacts")],
    ["release artifact build", workflowJob(release, "build-assets")],
  ]) {
    assert.equal(
      namedStep(job, "Install verified wasm-pack").run,
      'node scripts/install-wasm-pack.mjs --install-dir "$RUNNER_TEMP/webpage-mcp-wasm-pack"',
      name,
    );
    const verificationName =
      name === "CI WASM rebuild"
        ? "Verify generated runtime artifacts"
        : "Verify reproducible WASM runtime";
    assert.equal(
      namedStep(job, verificationName).env.WASM_PACK_BINARY,
      "${{ runner.temp }}/webpage-mcp-wasm-pack/wasm-pack",
    );
    assert.ok(!joinedRunScripts(job).includes("cargo install wasm-pack"));
  }

  assert.deepEqual(security.on, {
    schedule: [{ cron: "17 4 * * *" }],
    workflow_dispatch: null,
  });
  assert.deepEqual(security.permissions, { contents: "read" });
  assert.ok(!joinedWorkflowRunScripts(security).includes("pnpm install"));

  assert.deepEqual(dependabot, {
    version: 2,
    updates: [
      {
        "package-ecosystem": "github-actions",
        directory: "/",
        schedule: { interval: "weekly" },
        "open-pull-requests-limit": 5,
      },
      {
        "package-ecosystem": "npm",
        directory: "/",
        schedule: { interval: "weekly" },
        "open-pull-requests-limit": 5,
      },
      {
        "package-ecosystem": "cargo",
        directory: "/packages/wasm-simd",
        schedule: { interval: "weekly" },
        "open-pull-requests-limit": 5,
      },
    ],
  });
});
test("CI workflows use maintained runtimes and reviewed actions", async () => {
  const [ci, release, security] = await Promise.all([
    readYaml(".github/workflows/ci.yml"),
    readYaml(".github/workflows/release.yml"),
    readYaml(".github/workflows/dependency-security.yml"),
  ]);
  const workflows = [ci, release, security];
  const rootPackage = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );

  assert.deepEqual(
    workflowJob(ci, "verify").strategy.matrix["node-version"],
    [22, 24],
  );
  const setupNodeSteps = workflows.flatMap((workflow) =>
    allWorkflowSteps(workflow).filter((step) =>
      String(step.uses ?? "").startsWith("actions/setup-node@"),
    ),
  );
  assert.ok(setupNodeSteps.length > 0);
  for (const step of setupNodeSteps) {
    const version = step.with?.["node-version"];
    assert.ok(
      version === 24 || version === "${{ matrix.node-version }}",
      "setup-node must use Node 24 or the reviewed CI matrix",
    );
  }

  const reviewedActionCommits = new Set([
    "df4cb1c069e1874edd31b4311f1884172cec0e10", // actions/checkout v6.0.3
    "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e", // actions/setup-node v6.4.0
    "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", // actions/upload-artifact v7.0.1
    "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", // actions/download-artifact v8.0.1
    "fc06bc1257f339d1d5d8b3a19a8cae5388b55320", // pnpm/action-setup v5.0.0
    "718ea10b132b3b2eba29c1007bb80653f286566b", // softprops/action-gh-release v3.0.1
  ]);
  const references = workflows
    .flatMap((workflow) => actionReferences(workflow))
    .filter((reference) => !reference.startsWith("./"));
  assert.ok(references.length > 0, "workflows must use remote actions");
  for (const reference of references) {
    const separator = reference.lastIndexOf("@");
    assert.ok(separator > 0, "remote action must include a commit reference");
    const action = reference.slice(0, separator);
    const commit = reference.slice(separator + 1);
    assert.match(
      commit,
      /^[a-f0-9]{40}$/,
      action + " must pin a full commit SHA",
    );
    assert.ok(
      reviewedActionCommits.has(commit),
      action + " must be pinned to a reviewed action release",
    );
  }

  const reviewedPackageManager =
    "pnpm@10.34.5+sha512.a4ee05f2f73658255bd6a89859c065a45c28a57daefae2c893a168ee2b73168c37b91e83e57ea67654ad03f03031746430e8bce38e362e042605fb8abc80192e";
  assert.equal(rootPackage.packageManager, reviewedPackageManager);
  const packageManagerMatch =
    /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([a-f0-9]{128})$/.exec(
      rootPackage.packageManager,
    );
  assert.ok(packageManagerMatch);
  const repositoryPnpmVersion = packageManagerMatch[1];
  const pnpmSetupSteps = workflows.flatMap((workflow) =>
    allWorkflowSteps(workflow).filter((step) =>
      String(step.uses ?? "").startsWith("pnpm/action-setup@"),
    ),
  );
  assert.ok(pnpmSetupSteps.length > 0, "workflows must pin pnpm");
  for (const step of pnpmSetupSteps) {
    assert.equal(
      String(step.with?.version),
      repositoryPnpmVersion,
      "every pnpm setup must match the packageManager version",
    );
  }
});
