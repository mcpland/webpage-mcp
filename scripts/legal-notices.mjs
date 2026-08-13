import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NPM_INVENTORY_ARTIFACTS,
  parseReviewedInventory,
  refreshReviewedInventories,
  verifyReviewedInventory,
} from "./npm-license-inventory.mjs";

export const LEGAL_ARTIFACTS = Object.freeze({
  mcp: Object.freeze({
    licenseSource: "app/mcp-server/LICENSE",
    noticeSource: "app/mcp-server/THIRD_PARTY_NOTICES.md",
    archiveLicense: "package/LICENSE",
    archiveNotice: "package/THIRD_PARTY_NOTICES.md",
    inventorySource: NPM_INVENTORY_ARTIFACTS.mcp.inventorySource,
    archiveInventory: NPM_INVENTORY_ARTIFACTS.mcp.archiveInventory,
    inventorySha256:
      "b499f8f53c2059a965848a7e17cc03543b62dcb4e840e7b47360295b7dbd3bbe",
    requiredMarkers: Object.freeze([
      "THIRD_PARTY_COMPONENTS.json",
      "@anthropic-ai/claude-agent-sdk",
      "@anthropic-ai/sdk",
      "@hono/node-server",
      "SEE LICENSE IN README.md",
      "chrome-devtools-frontend",
      "BSD-3-Clause",
      "drizzle-orm",
      "Apache-2.0",
      "hono",
      "zod",
      "MIT",
    ]),
  }),
  extension: Object.freeze({
    licenseSource: "app/chrome-extension/public/LICENSE",
    noticeSource: "app/chrome-extension/public/THIRD_PARTY_NOTICES.md",
    archiveLicense: "LICENSE",
    archiveNotice: "THIRD_PARTY_NOTICES.md",
    thirdPartyLicensesSource:
      "app/chrome-extension/public/THIRD_PARTY_LICENSES.txt",
    archiveThirdPartyLicenses: "THIRD_PARTY_LICENSES.txt",
    thirdPartyLicensesSha256:
      "d3a67637321e53e845d8b50f3930081432c0cbce7b2822f5a731127278c96b9c",
    inventorySource: NPM_INVENTORY_ARTIFACTS.extension.inventorySource,
    archiveInventory: NPM_INVENTORY_ARTIFACTS.extension.archiveInventory,
    inventorySha256:
      "3c78258623e9ffbec8dea5f8dee59612195d4cf1e766b7dd34627fcf9b7b2f5c",
    requiredMarkers: Object.freeze([
      "THIRD_PARTY_COMPONENTS.json",
      "@xenova/transformers",
      "hnswlib-wasm-static",
      "onnxruntime-web",
      "1.22.0",
      "Vendored runtime files",
      "Arc90 Readability",
      "THIRD_PARTY_LICENSES.txt",
      "elkjs",
      "EPL-2.0",
      "Apache-2.0",
      "MIT",
    ]),
  }),
});

const MAX_LEGAL_FILE_BYTES = 512 * 1024;
const MAX_INVENTORY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CARGO_LOCK_BYTES = 8 * 1024 * 1024;

function fail(message) {
  throw new Error(`[legal-notices] ${message}`);
}

function publicFailureMessage(error) {
  if (
    error instanceof Error &&
    (error.message.startsWith("[legal-notices]") ||
      error.message.startsWith("[npm-license-inventory]"))
  ) {
    return error.message;
  }
  return "[legal-notices] operation failed (details withheld)";
}

export async function readBoundedLegalSource(
  path,
  description,
  maximumBytes = MAX_LEGAL_FILE_BYTES,
) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAX_CARGO_LOCK_BYTES
  ) {
    fail(`${description} has an invalid byte limit`);
  }
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    fail(`${description} metadata cannot be read (details withheld)`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail(`${description} must be a regular non-symlink file`);
  }
  if (stats.size <= 0 || stats.size > maximumBytes) {
    fail(`${description} must be between 1 byte and ${maximumBytes} bytes`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  ).catch(() => {
    fail(`${description} cannot be opened safely (details withheld)`);
  });
  try {
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      openedStats.dev !== stats.dev ||
      openedStats.ino !== stats.ino ||
      openedStats.size !== stats.size
    ) {
      fail(`${description} changed before it could be read safely`);
    }
    const bytes = Buffer.allocUnsafe(openedStats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) {
        fail(
          `${description} changed outside its bounded size while being read`,
        );
      }
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await handle.read(
      probe,
      0,
      1,
      bytes.length,
    );
    const finalStats = await handle.stat();
    if (
      trailingBytes !== 0 ||
      finalStats.size !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino
    ) {
      fail(`${description} changed outside its bounded size while being read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[legal-notices]")) {
      throw error;
    }
    fail(`${description} cannot be read safely (details withheld)`);
  } finally {
    await handle.close().catch(() => {});
  }
}

export function validateThirdPartyInventory(bytes, artifactName) {
  const artifact = LEGAL_ARTIFACTS[artifactName];
  if (!artifact) fail(`unknown artifact: ${String(artifactName)}`);
  parseReviewedInventory(bytes, artifactName);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.inventorySha256) {
    fail(
      `${artifactName} THIRD_PARTY_COMPONENTS SHA-256 ${digest} does not match the reviewed digest`,
    );
  }
  return bytes;
}

export function validateThirdPartyNotice(source, artifactName) {
  const artifact = LEGAL_ARTIFACTS[artifactName];
  if (!artifact) fail(`unknown artifact: ${String(artifactName)}`);
  if (typeof source !== "string") {
    fail(`${artifactName} THIRD_PARTY_NOTICES must be UTF-8 text`);
  }
  if (!source.startsWith("# Third-Party Notices")) {
    fail(`${artifactName} THIRD_PARTY_NOTICES is missing its reviewed heading`);
  }
  for (const marker of artifact.requiredMarkers) {
    if (!source.includes(marker)) {
      fail(
        `${artifactName} THIRD_PARTY_NOTICES is missing required marker: ${marker}`,
      );
    }
  }
  return source;
}

export function validateThirdPartyLicenseBundle(bytes, artifactName) {
  const artifact = LEGAL_ARTIFACTS[artifactName];
  if (!artifact?.thirdPartyLicensesSource) {
    fail(`${String(artifactName)} has no reviewed third-party license bundle`);
  }
  if (!Buffer.isBuffer(bytes)) {
    fail(`${artifactName} THIRD_PARTY_LICENSES must be bytes`);
  }
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    fail(`${artifactName} THIRD_PARTY_LICENSES must be valid UTF-8`);
  }
  for (const marker of [
    "THIRD-PARTY LICENSES AND ATTRIBUTIONS",
    "ONNX Runtime@1.22.0 complete upstream ThirdPartyNotices.txt",
    "Eclipse Public License - v 2.0",
    "UNICODE LICENSE V3",
    "Copyright (c) 2010 Arc90 Inc",
  ]) {
    if (!source.includes(marker)) {
      fail(`${artifactName} THIRD_PARTY_LICENSES is missing marker: ${marker}`);
    }
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.thirdPartyLicensesSha256) {
    fail(
      `${artifactName} THIRD_PARTY_LICENSES SHA-256 ${digest} does not match the reviewed digest`,
    );
  }
  return bytes;
}

export function parseThirdPartyNoticeRows(source, artifactName) {
  validateThirdPartyNotice(source, artifactName);
  const rows = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (
      cells.length !== 6 ||
      !["npm", "cargo", "vendored"].includes(cells[0])
    ) {
      continue;
    }
    const [
      ecosystem,
      rawName,
      rawVersion,
      rawLicense,
      distribution,
      sourceUrl,
    ] = cells;
    const unwrapCode = (value) =>
      value.startsWith("`") && value.endsWith("`")
        ? value.slice(1, -1)
        : undefined;
    const name = unwrapCode(rawName);
    const version = unwrapCode(rawVersion);
    const license = unwrapCode(rawLicense);
    if (!name || !version || !license || !sourceUrl.startsWith("https://")) {
      fail(`${artifactName} notice has a malformed component row: ${line}`);
    }
    const key = `${ecosystem}:${name}@${version}`;
    if (rows.has(key)) fail(`${artifactName} notice has duplicate row ${key}`);
    rows.set(key, {
      ecosystem,
      name,
      version,
      license,
      distribution,
      sourceUrl,
    });
  }
  if (rows.size === 0) fail(`${artifactName} notice has no component rows`);
  return rows;
}

export async function loadReviewedLegalFiles({
  rootDir = process.cwd(),
  artifactName,
} = {}) {
  const artifact = LEGAL_ARTIFACTS[artifactName];
  if (!artifact) fail(`unknown artifact: ${String(artifactName)}`);
  const projectLicense = await readBoundedLegalSource(
    resolve(rootDir, "LICENSE"),
    "project LICENSE",
  );
  const distributedLicense = await readBoundedLegalSource(
    resolve(rootDir, artifact.licenseSource),
    `${artifactName} LICENSE source`,
  );
  if (!distributedLicense.equals(projectLicense)) {
    fail(`${artifactName} LICENSE source does not match the project LICENSE`);
  }
  const notice = await readBoundedLegalSource(
    resolve(rootDir, artifact.noticeSource),
    `${artifactName} THIRD_PARTY_NOTICES source`,
  );
  validateThirdPartyNotice(notice.toString("utf8"), artifactName);
  const inventory = await readBoundedLegalSource(
    resolve(rootDir, artifact.inventorySource),
    `${artifactName} THIRD_PARTY_COMPONENTS source`,
    MAX_INVENTORY_FILE_BYTES,
  );
  validateThirdPartyInventory(inventory, artifactName);
  let thirdPartyLicenses;
  if (artifact.thirdPartyLicensesSource) {
    thirdPartyLicenses = await readBoundedLegalSource(
      resolve(rootDir, artifact.thirdPartyLicensesSource),
      `${artifactName} THIRD_PARTY_LICENSES source`,
    );
    validateThirdPartyLicenseBundle(thirdPartyLicenses, artifactName);
  }
  return {
    license: Buffer.from(projectLicense),
    notice: Buffer.from(notice),
    archiveLicense: artifact.archiveLicense,
    archiveNotice: artifact.archiveNotice,
    inventory: Buffer.from(inventory),
    archiveInventory: artifact.archiveInventory,
    thirdPartyLicenses: thirdPartyLicenses
      ? Buffer.from(thirdPartyLicenses)
      : undefined,
    archiveThirdPartyLicenses: artifact.archiveThirdPartyLicenses,
  };
}

function parseCargoLockPackages(source) {
  const packages = [];
  for (const block of source.split("[[package]]").slice(1)) {
    const name = /^\s*name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^\s*version = "([^"]+)"/m.exec(block)?.[1];
    if (name && version) packages.push({ name, version });
  }
  return packages;
}

export function verifyCargoNoticeClosure({
  cargoLockSource,
  noticeRows,
  artifactName = "extension",
}) {
  if (typeof cargoLockSource !== "string" || !(noticeRows instanceof Map)) {
    fail(`${artifactName} Cargo notice closure input is invalid`);
  }
  const lockedCargo = new Set(
    parseCargoLockPackages(cargoLockSource)
      .filter(({ name }) => name !== "simd-math")
      .map(({ name, version }) => `cargo:${name}@${version}`),
  );
  const reviewedCargo = new Set(
    [...noticeRows]
      .filter(([, row]) => row?.ecosystem === "cargo")
      .map(([key]) => key),
  );
  const missing = [...lockedCargo]
    .filter((key) => !reviewedCargo.has(key))
    .sort();
  const stale = [...reviewedCargo]
    .filter((key) => !lockedCargo.has(key))
    .sort();
  if (missing.length > 0 || stale.length > 0) {
    fail(
      `${artifactName} Cargo notice closure mismatch; missing=[${missing.join(", ")}], stale=[${stale.join(", ")}]`,
    );
  }
  return { componentCount: lockedCargo.size };
}

export async function verifyRepositoryLegalNotices({
  rootDir = process.cwd(),
  verifyLocalInstall = true,
} = {}) {
  const summaries = {};
  for (const artifactName of Object.keys(LEGAL_ARTIFACTS)) {
    const legalFiles = await loadReviewedLegalFiles({ rootDir, artifactName });
    const rows = parseThirdPartyNoticeRows(
      legalFiles.notice.toString("utf8"),
      artifactName,
    );
    summaries[artifactName] = await verifyReviewedInventory({
      rootDir,
      artifactName,
      inventoryBytes: legalFiles.inventory,
      verifyLocalInstall,
    });
    const reviewedNpm = parseReviewedInventory(
      legalFiles.inventory,
      artifactName,
    ).components;
    for (const [key, row] of rows) {
      if (row.ecosystem !== "npm") continue;
      const reviewed = reviewedNpm.get(`${row.name}@${row.version}`);
      if (!reviewed) {
        fail(
          `${artifactName} notice references npm component absent from the reviewed closure: ${key}`,
        );
      }
      if (row.license !== reviewed.declaredLicense) {
        fail(
          `${artifactName} notice license for ${key} is ${row.license}, expected ${reviewed.declaredLicense}`,
        );
      }
    }
    if (artifactName === "extension") {
      const cargoLock = (
        await readBoundedLegalSource(
          resolve(rootDir, "packages/wasm-simd/Cargo.lock"),
          "Cargo.lock",
          MAX_CARGO_LOCK_BYTES,
        )
      ).toString("utf8");
      verifyCargoNoticeClosure({
        cargoLockSource: cargoLock,
        noticeRows: rows,
      });
    }
  }
  return summaries;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const command = process.argv[2];
  if (!new Set(["check", "refresh"]).has(command)) {
    console.error("Usage: node scripts/legal-notices.mjs <check|refresh>");
    process.exitCode = 1;
  } else if (command === "refresh") {
    refreshReviewedInventories({
      rootDir: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      onProgress: ({ artifactName, completed, total }) => {
        if (completed === total || completed % 25 === 0) {
          console.log(
            `${artifactName}: verified ${completed}/${total} registry archives`,
          );
        }
      },
    })
      .then(({ sourceBytes, cacheBytes, networkBytes, inventories }) => {
        for (const inventory of inventories) {
          console.log(
            `${inventory.artifactName}: ${inventory.componentCount} components, ${inventory.bytes} bytes, SHA-256 ${inventory.sha256}`,
          );
        }
        console.log(
          `Read ${sourceBytes} integrity-verified source bytes (${cacheBytes} cache, ${networkBytes} network); no lifecycle scripts were executed.`,
        );
      })
      .catch((error) => {
        console.error(publicFailureMessage(error));
        process.exitCode = 1;
      });
  } else {
    verifyRepositoryLegalNotices({
      rootDir: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    })
      .then(() => console.log("Reviewed legal notices are current."))
      .catch((error) => {
        console.error(publicFailureMessage(error));
        process.exitCode = 1;
      });
  }
}
