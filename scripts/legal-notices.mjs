import { Buffer } from "node:buffer";
import console from "node:console";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LEGAL_ARTIFACTS = Object.freeze({
  mcp: Object.freeze({
    licenseSource: "app/mcp-server/LICENSE",
    noticeSource: "app/mcp-server/THIRD_PARTY_NOTICES.md",
    archiveLicense: "package/LICENSE",
    archiveNotice: "package/THIRD_PARTY_NOTICES.md",
    packageRoot: "app/mcp-server",
    requiredMarkers: Object.freeze([
      "@anthropic-ai/claude-agent-sdk",
      "SEE LICENSE IN README.md",
      "chrome-devtools-frontend",
      "BSD-3-Clause",
      "drizzle-orm",
      "Apache-2.0",
      "MIT",
    ]),
  }),
  extension: Object.freeze({
    licenseSource: "app/chrome-extension/public/LICENSE",
    noticeSource: "app/chrome-extension/public/THIRD_PARTY_NOTICES.md",
    archiveLicense: "LICENSE",
    archiveNotice: "THIRD_PARTY_NOTICES.md",
    packageRoot: "app/chrome-extension",
    requiredMarkers: Object.freeze([
      "@xenova/transformers",
      "hnswlib-wasm-static",
      "onnxruntime-web",
      "1.14.0",
      "1.22.0",
      "Vendored runtime files",
      "elkjs",
      "EPL-2.0",
      "Apache-2.0",
      "MIT",
    ]),
  }),
});

const FIRST_PARTY_PACKAGES = new Set(["webpage-mcp-shared"]);
const MAX_LEGAL_FILE_BYTES = 512 * 1024;

function fail(message) {
  throw new Error(`[legal-notices] ${message}`);
}

async function readBoundedSource(path, description) {
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > MAX_LEGAL_FILE_BYTES) {
    fail(
      `${description} must be between 1 byte and ${MAX_LEGAL_FILE_BYTES} bytes`,
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

export function parseThirdPartyNoticeRows(source, artifactName) {
  validateThirdPartyNotice(source, artifactName);
  const rows = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 6 || !["npm", "cargo"].includes(cells[0])) {
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
  const projectLicense = await readBoundedSource(
    resolve(rootDir, "LICENSE"),
    "project LICENSE",
  );
  const distributedLicense = await readBoundedSource(
    resolve(rootDir, artifact.licenseSource),
    `${artifactName} LICENSE source`,
  );
  if (!distributedLicense.equals(projectLicense)) {
    fail(`${artifactName} LICENSE source does not match the project LICENSE`);
  }
  const notice = await readBoundedSource(
    resolve(rootDir, artifact.noticeSource),
    `${artifactName} THIRD_PARTY_NOTICES source`,
  );
  validateThirdPartyNotice(notice.toString("utf8"), artifactName);
  return {
    license: Buffer.from(projectLicense),
    notice: Buffer.from(notice),
    archiveLicense: artifact.archiveLicense,
    archiveNotice: artifact.archiveNotice,
  };
}

function normalizeDeclaredLicense(pkg, packageName) {
  if (typeof pkg.license === "string" && pkg.license.length > 0) {
    return pkg.license;
  }
  fail(`${packageName} has no single declared license in package.json`);
}

async function verifyNpmRows(rootDir, artifactName, noticeRows) {
  const artifact = LEGAL_ARTIFACTS[artifactName];
  const packageRoot = resolve(rootDir, artifact.packageRoot);
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  for (const packageName of Object.keys(
    packageJson.dependencies ?? {},
  ).sort()) {
    if (FIRST_PARTY_PACKAGES.has(packageName)) continue;
    const installedPackageJson = JSON.parse(
      await readFile(
        join(packageRoot, "node_modules", packageName, "package.json"),
        "utf8",
      ),
    );
    const version = installedPackageJson.version;
    const key = `npm:${packageName}@${version}`;
    const row = noticeRows.get(key);
    if (!row) fail(`${artifactName} notice is missing resolved package ${key}`);
    const declaredLicense = normalizeDeclaredLicense(
      installedPackageJson,
      packageName,
    );
    if (row.license !== declaredLicense) {
      fail(
        `${artifactName} notice license for ${key} is ${row.license}, expected ${declaredLicense}`,
      );
    }
  }
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

export async function verifyRepositoryLegalNotices({
  rootDir = process.cwd(),
} = {}) {
  for (const artifactName of Object.keys(LEGAL_ARTIFACTS)) {
    const legalFiles = await loadReviewedLegalFiles({ rootDir, artifactName });
    const rows = parseThirdPartyNoticeRows(
      legalFiles.notice.toString("utf8"),
      artifactName,
    );
    await verifyNpmRows(rootDir, artifactName, rows);
    if (artifactName === "extension") {
      const cargoLock = await readFile(
        resolve(rootDir, "packages/wasm-simd/Cargo.lock"),
        "utf8",
      );
      for (const { name, version } of parseCargoLockPackages(cargoLock)) {
        if (name === "simd-math") continue;
        const key = `cargo:${name}@${version}`;
        if (!rows.has(key)) {
          fail(`extension notice is missing locked Rust package ${key}`);
        }
      }
    }
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const command = process.argv[2];
  if (command !== "check") {
    console.error("Usage: node scripts/legal-notices.mjs check");
    process.exitCode = 1;
  } else {
    verifyRepositoryLegalNotices({
      rootDir: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    })
      .then(() => console.log("Reviewed legal notices are current."))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
