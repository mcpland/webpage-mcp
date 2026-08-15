import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export const RUNTIME_NODE_MODULES_PATH_FILE = "node_modules_path.txt";
export const RUNTIME_REQUIRED_MODULE_IDS = [
  "better-sqlite3",
  "cross-spawn",
  "drizzle-orm",
  "drizzle-orm/sqlite-core",
  "uuid",
  "zod/v4",
] as const;

const DEPENDENCY_LAYOUT_VERSION = 1;
const DEPENDENCY_GENERATIONS_DIR = "dependencies";
const DEPENDENCY_GENERATION_PREFIX = `v${DEPENDENCY_LAYOUT_VERSION}-`;
const DEPENDENCY_MARKER_FILE = ".dependency-generation.json";
const INSTALL_LOCK_DIR = ".install-lock";
const INSTALL_LOCK_STALE_MS = 5 * 60 * 1000;
const INSTALL_LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const INSTALL_LOCK_POLL_MS = 50;
const STALE_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RETAINED_GENERATIONS = 2;
const PACKAGE_NAME_PATTERN =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface RuntimePackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bundledDependencies?: string[];
  bundleDependencies?: string[];
}

interface RuntimePackageNode {
  root: string;
  manifestPath: string;
  manifestContents: string;
  manifest: RuntimePackageManifest;
  name: string;
  version: string;
  dependencies: Map<string, RuntimePackageNode>;
  nativeBinaryHashes: string[];
}

interface RuntimeDependencyGraph {
  roots: Map<string, RuntimePackageNode>;
  nodes: Map<string, RuntimePackageNode>;
}

interface DependencyGenerationMarker {
  layoutVersion: number;
  fingerprint: string;
  platform: string;
  architecture: string;
  nodeModuleAbi: string;
  packageCount: number;
}

export interface StableRuntimeDependencyInstallOptions {
  allowExistingGenerationWithoutSource?: boolean;
  warn?: (message: string) => void;
}

export interface StableRuntimeDependencyInstallResult {
  fingerprint: string;
  nodeModulesDir: string;
  packageCount: number;
  reused: boolean;
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const canonicalize = (filePath: string): string => {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return path.resolve(filePath);
    }
  };
  const relative = path.relative(
    canonicalize(parentPath),
    canonicalize(candidatePath),
  );
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function chmodPrivate(filePath: string, mode: number): void {
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, mode);
  }
}

function ensurePrivateDirectory(directoryPath: string): void {
  if (fs.existsSync(directoryPath)) {
    const stats = fs.lstatSync(directoryPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `Runtime dependency path is not a directory: ${directoryPath}`,
      );
    }
  } else {
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  }
  chmodPrivate(directoryPath, 0o700);
}

function writePrivateFile(filePath: string, contents: string): void {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  chmodPrivate(filePath, 0o600);
}

function writePrivateFileAtomically(filePath: string, contents: string): void {
  const parentDirectory = path.dirname(filePath);
  ensurePrivateDirectory(parentDirectory);
  const stagingDirectory = fs.mkdtempSync(
    path.join(parentDirectory, `.${path.basename(filePath)}-`),
  );
  chmodPrivate(stagingDirectory, 0o700);
  const stagingPath = path.join(stagingDirectory, "value");

  try {
    writePrivateFile(stagingPath, contents);
    fs.renameSync(stagingPath, filePath);
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

function packageNameFromModuleId(moduleId: string): string {
  const segments = moduleId.split("/");
  const packageName = moduleId.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new Error(`Invalid runtime package name: ${packageName}`);
  }
  return packageName;
}

function packagePath(nodeModulesDir: string, packageName: string): string {
  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new Error(`Invalid runtime package name: ${packageName}`);
  }
  return path.join(nodeModulesDir, ...packageName.split("/"));
}

function findNodeModulesDirectories(startDirectory: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(startDirectory);
  while (true) {
    directories.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

function resolveInstalledPackageRoot(
  startDirectory: string,
  packageName: string,
  fallbackNodeModulesDirs: readonly string[],
): string | null {
  const candidates = [
    ...findNodeModulesDirectories(startDirectory),
    ...fallbackNodeModulesDirs,
  ];
  const seen = new Set<string>();

  for (const nodeModulesDir of candidates) {
    const candidate = packagePath(nodeModulesDir, packageName);
    if (seen.has(candidate) || !fs.existsSync(candidate)) {
      continue;
    }
    seen.add(candidate);

    try {
      const realRoot = fs.realpathSync(candidate);
      const stats = fs.statSync(realRoot);
      if (!stats.isDirectory()) {
        continue;
      }
      const manifest = JSON.parse(
        fs.readFileSync(path.join(realRoot, "package.json"), "utf8"),
      ) as RuntimePackageManifest;
      if (manifest.name === packageName) {
        return realRoot;
      }
    } catch {
      // Continue through Node's remaining lookup locations.
    }
  }

  return null;
}

function listNativeBinaryHashes(packageRoot: string): string[] {
  const hashes: string[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") {
        continue;
      }
      const sourcePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(sourcePath, relativePath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".node")) {
        const digest = crypto
          .createHash("sha256")
          .update(fs.readFileSync(sourcePath))
          .digest("hex");
        hashes.push(`${relativePath.split(path.sep).join("/")}:${digest}`);
      }
    }
  };

  visit(packageRoot, "");
  return hashes.sort();
}

function readPackageNode(packageRoot: string): RuntimePackageNode {
  const manifestPath = path.join(packageRoot, "package.json");
  const manifestContents = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestContents) as RuntimePackageManifest;
  if (
    typeof manifest.name !== "string" ||
    !PACKAGE_NAME_PATTERN.test(manifest.name) ||
    typeof manifest.version !== "string" ||
    !manifest.version
  ) {
    throw new Error(`Invalid runtime dependency manifest: ${manifestPath}`);
  }
  return {
    root: packageRoot,
    manifestPath,
    manifestContents,
    manifest,
    name: manifest.name,
    version: manifest.version,
    dependencies: new Map(),
    nativeBinaryHashes: listNativeBinaryHashes(packageRoot),
  };
}

function dependencyNamesForNode(node: RuntimePackageNode): {
  optional: Set<string>;
  required: Set<string>;
} {
  const required = new Set(Object.keys(node.manifest.dependencies ?? {}));
  const optional = new Set(
    Object.keys(node.manifest.optionalDependencies ?? {}),
  );

  for (const bundledDependencies of [
    node.manifest.bundledDependencies,
    node.manifest.bundleDependencies,
  ]) {
    if (!Array.isArray(bundledDependencies)) {
      continue;
    }
    for (const dependencyName of bundledDependencies) {
      required.add(dependencyName);
    }
  }
  for (const dependencyName of Object.keys(
    node.manifest.peerDependencies ?? {},
  )) {
    if (!node.manifest.peerDependenciesMeta?.[dependencyName]?.optional) {
      required.add(dependencyName);
    }
  }

  for (const dependencyName of optional) {
    required.delete(dependencyName);
  }
  return { optional, required };
}

function readConfiguredNodeModulesDir(runtimeDistDir: string): string | null {
  const pathFile = getRuntimeNodeModulesPathFile(runtimeDistDir);
  try {
    const configuredPath = fs.readFileSync(pathFile, "utf8").trim();
    if (!configuredPath) {
      return null;
    }
    const stats = fs.lstatSync(configuredPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return null;
    }
    return path.resolve(configuredPath);
  } catch {
    return null;
  }
}

function buildRuntimeDependencyGraph(
  sourceDistDir: string,
  fallbackNodeModulesDirs: readonly string[],
): RuntimeDependencyGraph {
  const nodes = new Map<string, RuntimePackageNode>();

  const loadNode = (packageRoot: string): RuntimePackageNode => {
    const canonicalRoot = fs.realpathSync(packageRoot);
    const existing = nodes.get(canonicalRoot);
    if (existing) {
      return existing;
    }

    const node = readPackageNode(canonicalRoot);
    nodes.set(canonicalRoot, node);
    const dependencyNames = dependencyNamesForNode(node);
    const allNames = [
      ...dependencyNames.required,
      ...dependencyNames.optional,
    ].sort();
    for (const dependencyName of allNames) {
      if (!PACKAGE_NAME_PATTERN.test(dependencyName)) {
        throw new Error(
          `Invalid dependency name ${dependencyName} in ${node.manifestPath}`,
        );
      }
      const dependencyRoot = resolveInstalledPackageRoot(
        canonicalRoot,
        dependencyName,
        fallbackNodeModulesDirs,
      );
      if (!dependencyRoot) {
        if (dependencyNames.required.has(dependencyName)) {
          throw new Error(
            `Required dependency ${dependencyName} for ${node.name}@${node.version} is not installed`,
          );
        }
        continue;
      }
      node.dependencies.set(dependencyName, loadNode(dependencyRoot));
    }
    return node;
  };

  const roots = new Map<string, RuntimePackageNode>();
  const rootPackageNames = new Set(
    RUNTIME_REQUIRED_MODULE_IDS.map(packageNameFromModuleId),
  );
  for (const packageName of [...rootPackageNames].sort()) {
    const packageRoot = resolveInstalledPackageRoot(
      sourceDistDir,
      packageName,
      fallbackNodeModulesDirs,
    );
    if (!packageRoot) {
      throw new Error(
        `Runtime dependency ${packageName} is not installed near ${sourceDistDir}`,
      );
    }
    roots.set(packageName, loadNode(packageRoot));
  }

  return { roots, nodes };
}

function createDependencyFingerprint(graph: RuntimeDependencyGraph): string {
  const records = new Set<string>();
  for (const node of graph.nodes.values()) {
    const manifestHash = crypto
      .createHash("sha256")
      .update(node.manifestContents)
      .digest("hex");
    const dependencies = [...node.dependencies.entries()]
      .map(
        ([name, dependency]) =>
          `${name}=${dependency.name}@${dependency.version}`,
      )
      .sort();
    records.add(
      JSON.stringify({
        name: node.name,
        version: node.version,
        manifestHash,
        nativeBinaryHashes: node.nativeBinaryHashes,
        dependencies,
      }),
    );
  }

  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        layoutVersion: DEPENDENCY_LAYOUT_VERSION,
        platform: process.platform,
        architecture: process.arch,
        nodeModuleAbi: process.versions.modules ?? "unknown",
        requiredModuleIds: RUNTIME_REQUIRED_MODULE_IDS,
        packageRecords: [...records].sort(),
      }),
    )
    .digest("hex");
}

function copyPackageEntry(
  sourcePath: string,
  destinationPath: string,
  sourcePackageRoot: string,
  activeDirectories: Set<string>,
): void {
  const stats = fs.lstatSync(sourcePath);
  if (stats.isSymbolicLink()) {
    const realPath = fs.realpathSync(sourcePath);
    if (!isPathInside(sourcePackageRoot, realPath)) {
      throw new Error(
        `Runtime dependency contains an external symlink: ${sourcePath}`,
      );
    }
    copyPackageEntry(
      realPath,
      destinationPath,
      sourcePackageRoot,
      activeDirectories,
    );
    return;
  }

  if (stats.isDirectory()) {
    const canonicalDirectory = fs.realpathSync(sourcePath);
    if (activeDirectories.has(canonicalDirectory)) {
      throw new Error(
        `Runtime dependency contains a directory cycle: ${sourcePath}`,
      );
    }
    activeDirectories.add(canonicalDirectory);
    fs.mkdirSync(destinationPath, { mode: 0o700 });
    chmodPrivate(destinationPath, 0o700);
    try {
      for (const entry of fs.readdirSync(sourcePath)) {
        if (entry === "node_modules") {
          continue;
        }
        copyPackageEntry(
          path.join(sourcePath, entry),
          path.join(destinationPath, entry),
          sourcePackageRoot,
          activeDirectories,
        );
      }
    } finally {
      activeDirectories.delete(canonicalDirectory);
    }
    return;
  }

  if (stats.isFile()) {
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    chmodPrivate(destinationPath, stats.mode & 0o111 ? 0o700 : 0o600);
    return;
  }

  throw new Error(`Unsupported runtime dependency entry: ${sourcePath}`);
}

function copyPackageTree(
  node: RuntimePackageNode,
  targetPackageRoot: string,
  ancestors: Set<string>,
  hoistedPackages: ReadonlyMap<string, RuntimePackageNode>,
): void {
  copyPackageEntry(node.root, targetPackageRoot, node.root, new Set());
  const nextAncestors = new Set(ancestors).add(node.root);

  for (const [dependencyName, dependency] of [
    ...node.dependencies.entries(),
  ].sort(([left], [right]) => left.localeCompare(right))) {
    if (hoistedPackages.get(dependencyName)?.root === dependency.root) {
      continue;
    }
    if (nextAncestors.has(dependency.root)) {
      continue;
    }
    const targetNodeModulesDir = path.join(targetPackageRoot, "node_modules");
    ensurePrivateDirectory(targetNodeModulesDir);
    const targetDependencyRoot = packagePath(
      targetNodeModulesDir,
      dependencyName,
    );
    ensurePrivateDirectory(path.dirname(targetDependencyRoot));
    copyPackageTree(
      dependency,
      targetDependencyRoot,
      nextAncestors,
      hoistedPackages,
    );
  }
}

function selectHoistedPackages(
  graph: RuntimeDependencyGraph,
): Map<string, RuntimePackageNode> {
  const packagesByName = new Map<string, RuntimePackageNode[]>();
  for (const node of graph.nodes.values()) {
    const packages = packagesByName.get(node.name) ?? [];
    packages.push(node);
    packagesByName.set(node.name, packages);
  }

  const hoistedPackages = new Map<string, RuntimePackageNode>();
  for (const [packageName, packages] of packagesByName) {
    if (packages.length === 1) {
      hoistedPackages.set(packageName, packages[0]);
    }
  }
  for (const [packageName, rootPackage] of graph.roots) {
    hoistedPackages.set(packageName, rootPackage);
  }
  return hoistedPackages;
}

function copyDependencyGraph(
  graph: RuntimeDependencyGraph,
  targetNodeModulesDir: string,
): void {
  const hoistedPackages = selectHoistedPackages(graph);

  for (const [packageName, node] of [...hoistedPackages.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const targetPackageRoot = packagePath(targetNodeModulesDir, packageName);
    ensurePrivateDirectory(path.dirname(targetPackageRoot));
    copyPackageEntry(node.root, targetPackageRoot, node.root, new Set());
  }

  for (const [packageName, node] of [...hoistedPackages.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const targetPackageRoot = packagePath(targetNodeModulesDir, packageName);
    const ancestors = new Set<string>([node.root]);
    for (const [dependencyName, dependency] of [
      ...node.dependencies.entries(),
    ].sort(([left], [right]) => left.localeCompare(right))) {
      if (hoistedPackages.get(dependencyName)?.root === dependency.root) {
        continue;
      }
      const nestedNodeModulesDir = path.join(targetPackageRoot, "node_modules");
      ensurePrivateDirectory(nestedNodeModulesDir);
      const nestedPackageRoot = packagePath(
        nestedNodeModulesDir,
        dependencyName,
      );
      ensurePrivateDirectory(path.dirname(nestedPackageRoot));
      copyPackageTree(
        dependency,
        nestedPackageRoot,
        ancestors,
        hoistedPackages,
      );
    }
  }
}

function readDependencyGenerationMarker(
  generationDir: string,
): DependencyGenerationMarker | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(generationDir, DEPENDENCY_MARKER_FILE), "utf8"),
    ) as DependencyGenerationMarker;
  } catch {
    return null;
  }
}

function validateRuntimeDependencies(
  nodeModulesDir: string,
  loadNativeModule: boolean,
): void {
  const stats = fs.lstatSync(nodeModulesDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `Runtime node_modules is not a directory: ${nodeModulesDir}`,
    );
  }

  const runtimeRequire = createRequire(
    path.join(nodeModulesDir, ".webpage-mcp-runtime-validator.cjs"),
  );
  for (const moduleId of RUNTIME_REQUIRED_MODULE_IDS) {
    const resolvedPath = fs.realpathSync(runtimeRequire.resolve(moduleId));
    if (!isPathInside(nodeModulesDir, resolvedPath)) {
      throw new Error(
        `Runtime dependency ${moduleId} resolved outside the stable runtime: ${resolvedPath}`,
      );
    }
  }

  if (loadNativeModule) {
    const nativeValidation = spawnSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "--eval",
        [
          'const { createRequire } = require("node:module");',
          'const path = require("node:path");',
          'const runtimeRequire = createRequire(path.join(process.argv[1], ".webpage-mcp-native-validator.cjs"));',
          'const BetterSqlite3 = runtimeRequire("better-sqlite3");',
          'const database = new BetterSqlite3(":memory:");',
          "database.close();",
        ].join("\n"),
        nodeModulesDir,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    if (nativeValidation.error) {
      throw new Error(
        `Unable to validate the stable better-sqlite3 runtime: ${nativeValidation.error.message}`,
      );
    }
    if (nativeValidation.status !== 0) {
      const details = `${nativeValidation.stderr || nativeValidation.stdout}`
        .trim()
        .slice(0, 4096);
      throw new Error(
        `Stable better-sqlite3 runtime validation exited with status ${String(nativeValidation.status)}${details ? `: ${details}` : ""}`,
      );
    }
  }
}

function isUsableGeneration(
  generationDir: string,
  expectedFingerprint?: string,
): boolean {
  try {
    const stats = fs.lstatSync(generationDir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return false;
    }
    const marker = readDependencyGenerationMarker(generationDir);
    if (
      !marker ||
      marker.layoutVersion !== DEPENDENCY_LAYOUT_VERSION ||
      marker.platform !== process.platform ||
      marker.architecture !== process.arch ||
      marker.nodeModuleAbi !== (process.versions.modules ?? "unknown") ||
      (expectedFingerprint && marker.fingerprint !== expectedFingerprint)
    ) {
      return false;
    }
    validateRuntimeDependencies(
      path.join(generationDir, "node_modules"),
      false,
    );
    return true;
  } catch {
    return false;
  }
}

function writeDependencyGenerationMarker(
  generationDir: string,
  marker: DependencyGenerationMarker,
): void {
  writePrivateFile(
    path.join(generationDir, DEPENDENCY_MARKER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function acquireInstallLock(
  generationsRoot: string,
  generationDir: string,
  fingerprint: string,
): Promise<() => void> {
  const lockPath = path.join(generationsRoot, INSTALL_LOCK_DIR);
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;

  while (true) {
    let createdLock = false;
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      createdLock = true;
      chmodPrivate(lockPath, 0o700);
      const token = crypto.randomUUID();
      writePrivateFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          token,
          fingerprint,
          createdAt: new Date().toISOString(),
        })}\n`,
      );
      return () => {
        try {
          const owner = JSON.parse(
            fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"),
          ) as { token?: string };
          if (owner.token === token) {
            fs.rmSync(lockPath, { recursive: true, force: true });
          }
        } catch {
          // A missing or replaced lock no longer belongs to this installer.
        }
      };
    } catch (error) {
      if (createdLock) {
        fs.rmSync(lockPath, { recursive: true, force: true });
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
    }

    if (isUsableGeneration(generationDir, fingerprint)) {
      return () => undefined;
    }

    let removeAbandonedLock = false;
    try {
      const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
      try {
        const owner = JSON.parse(
          fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"),
        ) as { pid?: number };
        if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid)) {
          try {
            process.kill(owner.pid, 0);
          } catch (error) {
            removeAbandonedLock =
              (error as NodeJS.ErrnoException).code !== "EPERM";
          }
        } else {
          removeAbandonedLock = lockAge > INSTALL_LOCK_STALE_MS;
        }
      } catch {
        removeAbandonedLock = lockAge > INSTALL_LOCK_STALE_MS;
      }
    } catch {
      // The lock disappeared between checks; retry after a short wait.
    }
    if (removeAbandonedLock) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for runtime dependency installation lock: ${lockPath}`,
      );
    }
    await wait(INSTALL_LOCK_POLL_MS);
  }
}

function promoteStagingGeneration(
  stagingDir: string,
  generationDir: string,
  fingerprint: string,
): boolean {
  if (isUsableGeneration(generationDir, fingerprint)) {
    return false;
  }

  if (fs.existsSync(generationDir)) {
    const invalidPath = `${generationDir}.invalid-${crypto.randomUUID()}`;
    fs.renameSync(generationDir, invalidPath);
    fs.rmSync(invalidPath, { recursive: true, force: true });
  }
  fs.renameSync(stagingDir, generationDir);
  return true;
}

function cleanOldDependencyGenerations(
  generationsRoot: string,
  currentGenerationDir: string,
  warn: (message: string) => void,
): void {
  const now = Date.now();
  const generations: Array<{ path: string; mtimeMs: number }> = [];
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(generationsRoot, { withFileTypes: true });
  } catch (error) {
    warn(
      `Unable to inspect runtime dependency generations ${generationsRoot}: ${String(error)}`,
    );
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(generationsRoot, entry.name);
    if (entry.name.startsWith(".staging-")) {
      try {
        if (now - fs.statSync(entryPath).mtimeMs > STALE_STAGING_MAX_AGE_MS) {
          fs.rmSync(entryPath, { recursive: true, force: true });
        }
      } catch (error) {
        warn(
          `Unable to remove stale runtime dependency staging directory ${entryPath}: ${String(error)}`,
        );
      }
      continue;
    }
    if (
      !entry.name.startsWith(DEPENDENCY_GENERATION_PREFIX) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      continue;
    }
    try {
      generations.push({
        path: entryPath,
        mtimeMs: fs.statSync(entryPath).mtimeMs,
      });
    } catch {
      // Ignore entries that disappear during concurrent cleanup.
    }
  }

  generations.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const retained = new Set(
    [
      currentGenerationDir,
      ...generations
        .filter((generation) => generation.path !== currentGenerationDir)
        .slice(0, RETAINED_GENERATIONS - 1)
        .map((generation) => generation.path),
    ].map((generationPath) => path.resolve(generationPath)),
  );

  for (const generation of generations) {
    if (retained.has(path.resolve(generation.path))) {
      continue;
    }
    try {
      fs.rmSync(generation.path, { recursive: true, force: true });
    } catch (error) {
      warn(
        `Unable to remove old runtime dependency generation ${generation.path}: ${String(error)}`,
      );
    }
  }
}

function resultFromGeneration(
  generationDir: string,
  reused: boolean,
): StableRuntimeDependencyInstallResult {
  const marker = readDependencyGenerationMarker(generationDir);
  if (!marker) {
    throw new Error(
      `Runtime dependency generation marker is missing: ${generationDir}`,
    );
  }
  return {
    fingerprint: marker.fingerprint,
    nodeModulesDir: path.join(generationDir, "node_modules"),
    packageCount: marker.packageCount,
    reused,
  };
}

export function getRuntimeNodeModulesPathFile(runtimeDistDir: string): string {
  return path.join(runtimeDistDir, RUNTIME_NODE_MODULES_PATH_FILE);
}

export function getMissingStableRuntimeDependencies(
  runtimeDistDir: string,
  fallbackNodeModulesDirs: readonly string[] = [],
): string[] {
  const configuredPath = readConfiguredNodeModulesDir(runtimeDistDir);
  const resolvePaths = [configuredPath, ...fallbackNodeModulesDirs].filter(
    (candidate): candidate is string =>
      Boolean(candidate && fs.existsSync(candidate)),
  );
  const entryPath = path.join(runtimeDistDir, "index.js");
  if (!fs.existsSync(entryPath)) {
    return [];
  }

  try {
    const runtimeRequire = createRequire(entryPath);
    return RUNTIME_REQUIRED_MODULE_IDS.filter((moduleId) => {
      try {
        runtimeRequire.resolve(moduleId, { paths: resolvePaths });
        return false;
      } catch {
        return true;
      }
    });
  } catch {
    return [...RUNTIME_REQUIRED_MODULE_IDS];
  }
}

export async function installStableRuntimeDependencies(
  sourceDistDir: string,
  runtimeDistDir: string,
  options: StableRuntimeDependencyInstallOptions = {},
): Promise<StableRuntimeDependencyInstallResult> {
  const warn = options.warn ?? (() => undefined);
  const runtimeRoot = path.dirname(path.resolve(runtimeDistDir));
  const generationsRoot = path.join(runtimeRoot, DEPENDENCY_GENERATIONS_DIR);
  const configuredPath = readConfiguredNodeModulesDir(runtimeDistDir);

  if (
    options.allowExistingGenerationWithoutSource &&
    configuredPath &&
    isPathInside(generationsRoot, configuredPath)
  ) {
    const generationDir = path.dirname(configuredPath);
    if (isUsableGeneration(generationDir)) {
      return resultFromGeneration(generationDir, true);
    }
  }

  const fallbackNodeModulesDirs = configuredPath ? [configuredPath] : [];
  const graph = buildRuntimeDependencyGraph(
    path.resolve(sourceDistDir),
    fallbackNodeModulesDirs,
  );
  const fingerprint = createDependencyFingerprint(graph);
  const generationDir = path.join(
    generationsRoot,
    `${DEPENDENCY_GENERATION_PREFIX}${fingerprint}`,
  );

  ensurePrivateDirectory(runtimeRoot);
  ensurePrivateDirectory(generationsRoot);

  if (isUsableGeneration(generationDir, fingerprint)) {
    writePrivateFileAtomically(
      getRuntimeNodeModulesPathFile(runtimeDistDir),
      `${path.join(generationDir, "node_modules")}\n`,
    );
    cleanOldDependencyGenerations(generationsRoot, generationDir, warn);
    return resultFromGeneration(generationDir, true);
  }

  const releaseLock = await acquireInstallLock(
    generationsRoot,
    generationDir,
    fingerprint,
  );
  let stagingDir: string | null = null;
  let reused = false;

  try {
    if (isUsableGeneration(generationDir, fingerprint)) {
      reused = true;
    } else {
      stagingDir = fs.mkdtempSync(path.join(generationsRoot, ".staging-"));
      chmodPrivate(stagingDir, 0o700);
      const stagingNodeModulesDir = path.join(stagingDir, "node_modules");
      ensurePrivateDirectory(stagingNodeModulesDir);

      copyDependencyGraph(graph, stagingNodeModulesDir);

      const marker: DependencyGenerationMarker = {
        layoutVersion: DEPENDENCY_LAYOUT_VERSION,
        fingerprint,
        platform: process.platform,
        architecture: process.arch,
        nodeModuleAbi: process.versions.modules ?? "unknown",
        packageCount: graph.nodes.size,
      };
      writeDependencyGenerationMarker(stagingDir, marker);
      validateRuntimeDependencies(stagingNodeModulesDir, true);
      reused = !promoteStagingGeneration(
        stagingDir,
        generationDir,
        fingerprint,
      );
      stagingDir = null;
    }

    writePrivateFileAtomically(
      getRuntimeNodeModulesPathFile(runtimeDistDir),
      `${path.join(generationDir, "node_modules")}\n`,
    );
    cleanOldDependencyGenerations(generationsRoot, generationDir, warn);
    return resultFromGeneration(generationDir, reused);
  } finally {
    if (stagingDir) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    releaseLock();
  }
}
