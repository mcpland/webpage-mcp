import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.webpagemcp.nativehost";
const OFFICIAL_EXTENSION_ORIGIN =
  "chrome-extension://iehgbogeakiedihodennfcnigojnncag/";
const CHROME_CHANNELS = [
  "Chrome",
  "Chrome for Testing",
  "Chrome Beta",
  "Chrome Canary",
];

function requiredEnvironment(name, environment) {
  const value = environment[name];
  assert.ok(value, `${name} is required for the native registration smoke`);
  return value;
}

function canonicalPath(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function assertPathInside(parent, candidate, label) {
  assert.ok(
    isPathInside(parent, candidate),
    `${label} escaped ${parent}: ${candidate}`,
  );
}

export function verifyMacosNativeRegistrationSmoke(
  environment = process.env,
) {
  const smokeRoot = fs.realpathSync(
    requiredEnvironment("SMOKE_ROOT", environment),
  );
  const home = fs.realpathSync(requiredEnvironment("HOME", environment));
  const prefix = fs.realpathSync(
    requiredEnvironment("npm_config_prefix", environment),
  );
  const originalHome = path.resolve(
    requiredEnvironment("ORIGINAL_HOME", environment),
  );
  const doctorReportPath = requiredEnvironment("DOCTOR_REPORT", environment);

  assert.equal(process.platform, "darwin");
  assert.equal(canonicalPath(os.homedir()), home);
  assert.notEqual(home, originalHome);
  assertPathInside(smokeRoot, home, "HOME");
  assertPathInside(smokeRoot, prefix, "npm prefix");

  const runtimeDist = path.join(home, ".webpage-mcp", "runtime", "dist");
  const wrapperPath = path.join(runtimeDist, "run_host.sh");
  const dangerousOriginalConfigRoot = path.join(
    originalHome,
    "Library",
    "Application Support",
  );
  const manifestPaths = [];

  for (const channel of CHROME_CHANNELS) {
    const manifestPath = path.join(
      home,
      "Library",
      "Application Support",
      "Google",
      channel,
      "NativeMessagingHosts",
      `${HOST_NAME}.json`,
    );
    manifestPaths.push(manifestPath);
    assertPathInside(home, manifestPath, `${channel} manifest`);
    assert.ok(
      !isPathInside(dangerousOriginalConfigRoot, manifestPath),
      `${channel} manifest targeted the runner user's real browser config`,
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.name, HOST_NAME);
    assert.equal(manifest.type, "stdio");
    assert.equal(
      fs.realpathSync(manifest.path),
      fs.realpathSync(wrapperPath),
    );
    assert.ok(manifest.allowed_origins.includes(OFFICIAL_EXTENSION_ORIGIN));
  }

  assertPathInside(home, wrapperPath, "native wrapper");
  fs.accessSync(wrapperPath, fs.constants.X_OK);
  fs.accessSync(path.join(runtimeDist, "index.js"), fs.constants.R_OK);
  fs.accessSync(path.join(runtimeDist, "cli.js"), fs.constants.X_OK);
  const registeredNodePath = fs
    .readFileSync(path.join(runtimeDist, "node_path.txt"), "utf8")
    .trim();
  assert.equal(
    fs.realpathSync(registeredNodePath),
    fs.realpathSync(process.execPath),
  );

  const report = JSON.parse(fs.readFileSync(doctorReportPath, "utf8"));
  assert.equal(report.ok, true, JSON.stringify(report.nextSteps));
  assertPathInside(
    prefix,
    report.environment.package.rootDir,
    "installed package root",
  );

  const checks = new Map(report.checks.map((check) => [check.id, check]));
  for (const id of [
    "host.files",
    "host.permissions",
    "node",
    "runtime.dependencies",
    "manifest.chrome",
  ]) {
    assert.equal(
      checks.get(id)?.status,
      "ok",
      `${id}: ${checks.get(id)?.message}`,
    );
  }
  assert.equal(
    fs.realpathSync(checks.get("manifest.chrome").details.path),
    fs.realpathSync(manifestPaths[0]),
  );

  return { home, manifestPaths, prefix, runtimeDist, wrapperPath };
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const result = verifyMacosNativeRegistrationSmoke();
  console.log(
    `macOS native registration smoke verified ${result.manifestPaths.length} manifests`,
  );
}
