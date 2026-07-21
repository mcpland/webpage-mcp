import console from "node:console";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

export const MCP_NPM_SHRINKWRAP_PATH = "app/mcp-server/npm-shrinkwrap.json";
export const MCP_NPM_SHRINKWRAP_SCOPE = "npm-runtime-and-bundled-closure";

const MAX_SHRINKWRAP_BYTES = 8 * 1024 * 1024;
const MAX_COMPONENTS = 4096;
const EXACT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME_PATTERN =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const execFileAsync = promisify(execFile);

function fail(message) {
  throw new Error(`[mcp-npm-shrinkwrap] ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExactVersions(record, description) {
  if (!isRecord(record) || Object.keys(record).length === 0) {
    fail(`${description} must be a non-empty object`);
  }
  for (const [name, version] of Object.entries(record)) {
    if (
      !PACKAGE_NAME_PATTERN.test(name) ||
      !EXACT_VERSION_PATTERN.test(version)
    ) {
      fail(`${description} must pin ${name} to an exact stable version`);
    }
  }
}

function packageNameFromLockPath(packagePath) {
  if (
    typeof packagePath !== "string" ||
    packagePath.length === 0 ||
    packagePath.length > 8192 ||
    packagePath.includes("\\") ||
    packagePath.startsWith("/") ||
    packagePath
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`lockfile contains an unsafe package path: ${String(packagePath)}`);
  }
  const marker = "node_modules/";
  const markerIndex = packagePath.lastIndexOf(marker);
  if (markerIndex < 0)
    fail(`lockfile package is outside node_modules: ${packagePath}`);
  const tail = packagePath.slice(markerIndex + marker.length);
  const segments = tail.split("/");
  const name = tail.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    fail(`lockfile contains an invalid package name at ${packagePath}`);
  }
  return name;
}

function resolveLockedDependency(packages, parentPath, dependencyName) {
  let current = parentPath;
  while (true) {
    const candidate = current
      ? `${current}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (current === "") return undefined;
    const markerIndex = current.lastIndexOf("/node_modules/");
    current = markerIndex < 0 ? "" : current.slice(0, markerIndex);
  }
}

function validateRegistryArchive(resolved, name, version) {
  let url;
  try {
    url = new URL(resolved);
  } catch {
    fail(`${name}@${version} has an invalid resolved archive URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "registry.npmjs.org" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    fail(`${name}@${version} must resolve from the canonical npm registry`);
  }
}

export function parseMcpNpmShrinkwrap(bytes, { sourcePackage } = {}) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_SHRINKWRAP_BYTES
  ) {
    fail(`npm-shrinkwrap.json must be 1-${MAX_SHRINKWRAP_BYTES} bytes`);
  }
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    fail("npm-shrinkwrap.json must be valid UTF-8");
  }
  let lock;
  try {
    lock = JSON.parse(source);
  } catch {
    fail("npm-shrinkwrap.json is invalid JSON (details withheld)");
  }
  if (`${JSON.stringify(lock, null, 2)}\n` !== source) {
    fail("npm-shrinkwrap.json is not in canonical JSON form");
  }
  if (
    !isRecord(lock) ||
    lock.lockfileVersion !== 3 ||
    lock.requires !== true ||
    !isRecord(lock.packages) ||
    !isRecord(lock.packages[""])
  ) {
    fail("npm-shrinkwrap.json must be a lockfileVersion 3 package lock");
  }
  if (Object.keys(lock.packages).length - 1 > MAX_COMPONENTS) {
    fail(`npm-shrinkwrap.json exceeds ${MAX_COMPONENTS} packages`);
  }

  const root = lock.packages[""];
  if (lock.name !== root.name || lock.version !== root.version) {
    fail(
      "npm-shrinkwrap.json top-level identity does not match its root package",
    );
  }
  assertExactVersions(root.dependencies, "shrinkwrap root dependencies");
  if (root.devDependencies !== undefined) {
    fail("npm-shrinkwrap.json may not contain development dependencies");
  }
  if (sourcePackage !== undefined) {
    if (!isRecord(sourcePackage)) fail("source package must be an object");
    assertExactVersions(
      sourcePackage.dependencies,
      "source runtime dependencies",
    );
    if (
      lock.name !== sourcePackage.name ||
      lock.version !== sourcePackage.version ||
      root.name !== sourcePackage.name ||
      root.version !== sourcePackage.version ||
      root.license !== sourcePackage.license ||
      !sameJson(root.engines, sourcePackage.engines) ||
      !sameJson(root.dependencies, sourcePackage.dependencies) ||
      root.hasInstallScript !== true
    ) {
      fail(
        "npm-shrinkwrap.json root does not match app/mcp-server/package.json",
      );
    }
    if (sourcePackage.overrides !== undefined) {
      assertExactVersions(sourcePackage.overrides, "source npm overrides");
    }
  }

  const components = new Map();
  const visitedPaths = new Set();
  const pending = [""];
  while (pending.length > 0) {
    const packagePath = pending.pop();
    if (visitedPaths.has(packagePath)) continue;
    visitedPaths.add(packagePath);
    const entry = lock.packages[packagePath];
    if (!isRecord(entry)) fail(`missing lockfile package entry ${packagePath}`);
    if (packagePath !== "") {
      const name = packageNameFromLockPath(packagePath);
      const version = entry.version;
      if (!EXACT_VERSION_PATTERN.test(version)) {
        fail(`${name} at ${packagePath} has an invalid version`);
      }
      if (entry.link === true || entry.dev === true) {
        fail(`${name}@${version} is not a published production dependency`);
      }
      if (typeof entry.resolved !== "string") {
        fail(`${name}@${version} has no resolved registry archive`);
      }
      validateRegistryArchive(entry.resolved, name, version);
      if (!SHA512_INTEGRITY_PATTERN.test(entry.integrity)) {
        fail(`${name}@${version} has no SHA-512 registry integrity`);
      }
      const key = `${name}@${version}`;
      const existing = components.get(key);
      if (
        existing &&
        (existing.resolved !== entry.resolved ||
          existing.integrity !== entry.integrity)
      ) {
        fail(`${key} resolves to conflicting registry archives`);
      }
      if (existing) existing.lockPaths.add(packagePath);
      else {
        components.set(key, {
          name,
          version,
          resolved: entry.resolved,
          integrity: entry.integrity,
          paths: new Set(),
          lockPaths: new Set([packagePath]),
        });
      }
    }

    const dependencyFields = [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ];
    for (const field of dependencyFields) {
      const dependencies = entry[field];
      if (dependencies === undefined) continue;
      if (!isRecord(dependencies))
        fail(`${packagePath || "root"} ${field} must be an object`);
      for (const dependencyName of Object.keys(dependencies)) {
        if (!PACKAGE_NAME_PATTERN.test(dependencyName)) {
          fail(`${packagePath || "root"} contains an invalid dependency name`);
        }
        if (
          field === "peerDependencies" &&
          entry.peerDependenciesMeta?.[dependencyName]?.optional === true
        ) {
          continue;
        }
        const dependencyPath = resolveLockedDependency(
          lock.packages,
          packagePath,
          dependencyName,
        );
        if (!dependencyPath) {
          fail(
            `${packagePath || "root"} cannot resolve ${dependencyName} in npm-shrinkwrap.json`,
          );
        }
        if (
          packagePath === "" &&
          field === "dependencies" &&
          lock.packages[dependencyPath]?.version !==
            dependencies[dependencyName]
        ) {
          fail(
            `root dependency ${dependencyName} is not locked to its declared version`,
          );
        }
        pending.push(dependencyPath);
      }
    }
  }

  const unreachable = Object.keys(lock.packages).filter(
    (path) => !visitedPaths.has(path),
  );
  if (unreachable.length > 0) {
    fail(
      `npm-shrinkwrap.json contains unreachable packages: ${unreachable.slice(0, 5).join(", ")}`,
    );
  }
  if (sourcePackage?.overrides) {
    for (const [name, version] of Object.entries(sourcePackage.overrides)) {
      const versions = new Set(
        [...components.values()]
          .filter((component) => component.name === name)
          .map((component) => component.version),
      );
      if (versions.size !== 1 || !versions.has(version)) {
        fail(
          `npm override ${name}@${version} is not enforced by npm-shrinkwrap.json`,
        );
      }
    }
  }
  return { lock, components, firstPartyWorkspacePackages: new Set() };
}

async function readSourcePackage(rootDir) {
  return JSON.parse(
    await readFile(resolve(rootDir, "app/mcp-server/package.json"), "utf8"),
  );
}

async function readCommittedShrinkwrap(rootDir) {
  const path = resolve(rootDir, MCP_NPM_SHRINKWRAP_PATH);
  const stats = await lstat(path);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size <= 0 ||
    stats.size > MAX_SHRINKWRAP_BYTES
  ) {
    fail("committed npm-shrinkwrap.json must be a bounded regular file");
  }
  return readFile(path);
}

export async function verifyMcpNpmShrinkwrap({ rootDir = process.cwd() } = {}) {
  const [sourcePackage, bytes] = await Promise.all([
    readSourcePackage(rootDir),
    readCommittedShrinkwrap(rootDir),
  ]);
  return parseMcpNpmShrinkwrap(bytes, { sourcePackage });
}

function normalizedComponentClosure(parsed) {
  return [...parsed.components.values()]
    .map(({ name, version, resolved, integrity }) => ({
      name,
      version,
      resolved,
      integrity,
    }))
    .sort((left, right) =>
      `${left.name}\0${left.version}`.localeCompare(
        `${right.name}\0${right.version}`,
      ),
    );
}

export function assertSameMcpNpmClosure(committed, current) {
  if (
    JSON.stringify(normalizedComponentClosure(committed)) !==
    JSON.stringify(normalizedComponentClosure(current))
  ) {
    fail(
      "fresh npm resolution drifted from npm-shrinkwrap.json; run pnpm shrinkwrap:mcp and review the dependency change",
    );
  }
}

async function writeAtomically(target, bytes) {
  const temporary = `${target}.refresh-${process.pid}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function generateCurrentMcpNpmShrinkwrap({
  rootDir = process.cwd(),
} = {}) {
  const sourcePackage = await readSourcePackage(rootDir);
  assertExactVersions(
    sourcePackage.dependencies,
    "source runtime dependencies",
  );
  if (sourcePackage.overrides !== undefined) {
    assertExactVersions(sourcePackage.overrides, "source npm overrides");
  }
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "webpage-mcp-shrinkwrap-"),
  );
  try {
    const generationPackage = {
      name: sourcePackage.name,
      version: sourcePackage.version,
      license: sourcePackage.license,
      engines: sourcePackage.engines,
      scripts: { postinstall: sourcePackage.scripts?.postinstall },
      dependencies: sourcePackage.dependencies,
      ...(sourcePackage.overrides
        ? { overrides: sourcePackage.overrides }
        : {}),
    };
    await writeFile(
      join(temporaryRoot, "package.json"),
      `${JSON.stringify(generationPackage, null, 2)}\n`,
      "utf8",
    );
    const npmEnvironment = {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
      npm_config_registry: "https://registry.npmjs.org/",
    };
    await execFileAsync(
      "npm",
      ["install", "--package-lock-only", "--omit=dev", "--ignore-scripts"],
      { cwd: temporaryRoot, env: npmEnvironment, maxBuffer: 8 * 1024 * 1024 },
    );
    await execFileAsync(
      "npm",
      ["audit", "--omit=dev", "--package-lock-only", "--audit-level=low"],
      {
        cwd: temporaryRoot,
        env: { ...npmEnvironment, npm_config_audit: "true" },
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    // package-lock.json and npm-shrinkwrap.json share lockfileVersion 3's
    // schema. Generate the former directly because newer npm versions no
    // longer expose a separate `npm shrinkwrap` command.
    const bytes = await readFile(join(temporaryRoot, "package-lock.json"));
    const parsed = parseMcpNpmShrinkwrap(bytes, { sourcePackage });
    return { bytes, parsed };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function verifyCurrentMcpNpmShrinkwrap({
  rootDir = process.cwd(),
} = {}) {
  const committed = await verifyMcpNpmShrinkwrap({ rootDir });
  const current = await generateCurrentMcpNpmShrinkwrap({ rootDir });
  assertSameMcpNpmClosure(committed, current.parsed);
  return { components: committed.components.size };
}

export async function refreshMcpNpmShrinkwrap({
  rootDir = process.cwd(),
} = {}) {
  const { bytes, parsed } = await generateCurrentMcpNpmShrinkwrap({ rootDir });
  await writeAtomically(resolve(rootDir, MCP_NPM_SHRINKWRAP_PATH), bytes);
  return { bytes: bytes.length, components: parsed.components.size };
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const command = process.argv[2];
  if (command === "refresh") {
    refreshMcpNpmShrinkwrap({ rootDir })
      .then(({ bytes, components }) => {
        console.log(
          `Generated audited npm-shrinkwrap.json with ${components} components (${bytes} bytes).`,
        );
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  } else if (command === "check") {
    verifyMcpNpmShrinkwrap({ rootDir })
      .then(({ components }) => {
        console.log(
          `Verified npm-shrinkwrap.json with ${components.size} components.`,
        );
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  } else if (command === "check-current") {
    verifyCurrentMcpNpmShrinkwrap({ rootDir })
      .then(({ components }) => {
        console.log(
          `Verified current npm resolution against ${components} committed components.`,
        );
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  } else {
    console.error(
      "Usage: node scripts/mcp-npm-shrinkwrap.mjs <refresh|check|check-current>",
    );
    process.exitCode = 1;
  }
}
