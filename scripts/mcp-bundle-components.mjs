import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

const MAX_METAFILE_BYTES = 8 * 1024 * 1024;
const EXACT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const FIRST_PARTY_PACKAGES = new Set(["webpage-mcp", "webpage-mcp-shared"]);

function fail(message) {
  throw new Error(`[mcp-bundle-components] ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseMcpBundleComponents(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 64 * 1024) {
    fail("bundle component manifest exceeds its size limit");
  }
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    fail("bundle component manifest is invalid JSON");
  }
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    fail("bundle component manifest must be a non-empty object");
  }
  if (`${JSON.stringify(raw, null, 2)}\n` !== source) {
    fail("bundle component manifest is not canonical JSON");
  }
  const components = new Map();
  let previousName = "";
  for (const [name, version] of Object.entries(raw)) {
    if (
      name <= previousName ||
      !/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
        name,
      ) ||
      !EXACT_VERSION_PATTERN.test(version)
    ) {
      fail("bundle component manifest entries must be sorted exact packages");
    }
    components.set(name, version);
    previousName = name;
  }
  return components;
}

export function loadMcpBundleComponents(rootDir) {
  return parseMcpBundleComponents(
    fs.readFileSync(
      path.resolve(rootDir, "scripts/mcp-bundle-components.json"),
      "utf8",
    ),
  );
}

function packageIdentityForInput(projectRoot, inputPath) {
  let current = path.dirname(path.resolve(projectRoot, inputPath));
  const repositoryRoot = path.resolve(projectRoot, "../..");
  while (
    current === repositoryRoot ||
    current.startsWith(`${repositoryRoot}${path.sep}`)
  ) {
    const manifestPath = path.join(current, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (
        typeof manifest.name === "string" &&
        typeof manifest.version === "string"
      ) {
        return { name: manifest.name, version: manifest.version };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function verifyMcpBundleMetafile({ projectRoot, metafilePath }) {
  const stats = fs.lstatSync(metafilePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size <= 0 ||
    stats.size > MAX_METAFILE_BYTES
  ) {
    fail("esbuild metafile must be a bounded regular file");
  }
  const metafile = JSON.parse(fs.readFileSync(metafilePath, "utf8"));
  if (!isRecord(metafile?.inputs) || !isRecord(metafile?.outputs)) {
    fail("esbuild metafile is missing inputs or outputs");
  }
  const activeInputs = new Set();
  for (const output of Object.values(metafile.outputs)) {
    if (
      !isRecord(output) ||
      !isRecord(output.inputs) ||
      !Array.isArray(output.imports)
    ) {
      fail("esbuild metafile contains an invalid output");
    }
    for (const [inputPath, contribution] of Object.entries(output.inputs)) {
      if (isRecord(contribution) && contribution.bytesInOutput > 0) {
        activeInputs.add(inputPath);
      }
    }
  }

  const actual = new Map();
  for (const inputPath of activeInputs) {
    const identity = packageIdentityForInput(projectRoot, inputPath);
    if (!identity || FIRST_PARTY_PACKAGES.has(identity.name)) continue;
    const previous = actual.get(identity.name);
    if (previous !== undefined && previous !== identity.version) {
      fail(`bundle contains multiple versions of ${identity.name}`);
    }
    actual.set(identity.name, identity.version);
  }
  const expected = loadMcpBundleComponents(path.resolve(projectRoot, "../.."));
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected])) {
    const missing = [...expected].filter(
      ([name, version]) => actual.get(name) !== version,
    );
    const unexpected = [...actual].filter(
      ([name, version]) => expected.get(name) !== version,
    );
    fail(
      `bundle component closure drifted; missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`,
    );
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (
        imported.external === true &&
        [...expected.keys()].some(
          (name) =>
            imported.path === name || imported.path.startsWith(`${name}/`),
        )
      ) {
        fail(`bundle leaves reviewed component external: ${imported.path}`);
      }
    }
  }
  return { components: actual, activeInputCount: activeInputs.size };
}
