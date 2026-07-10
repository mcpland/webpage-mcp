import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(scriptDir, "..");
const repoRoot = resolve(crateDir, "../..");
const manifestPath = join(crateDir, "artifacts.json");
const packageOutputDir = join(crateDir, "pkg");
const extensionWorkerDir = join(repoRoot, "app/chrome-extension/workers");
const artifactNames = ["simd_math.js", "simd_math_bg.wasm"];

function fail(message) {
  throw new Error(`[wasm-simd] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: crateDir,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env ?? process.env,
    shell: false,
  });

  if (result.error) {
    fail(`failed to start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stdout ?? ""}${result.stderr ?? ""}`
      : "";
    fail(`${command} exited with status ${result.status}${detail}`);
  }

  return options.capture ? result.stdout.trim() : undefined;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function assertEqualList(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `${label} changed\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`,
    );
  }
}

async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) {
    fail(`unsupported artifact manifest schema: ${manifest.schemaVersion}`);
  }
  return manifest;
}

async function assertToolchain(manifest) {
  const rustVersion = run("rustc", ["--version"], { capture: true });
  if (!rustVersion.startsWith(`rustc ${manifest.toolchain.rust} `)) {
    fail(
      `Rust ${manifest.toolchain.rust} is required; active toolchain is ${rustVersion}`,
    );
  }

  const wasmPackVersion = run("wasm-pack", ["--version"], { capture: true });
  if (wasmPackVersion !== `wasm-pack ${manifest.toolchain.wasmPack}`) {
    fail(
      `wasm-pack ${manifest.toolchain.wasmPack} is required; found ${wasmPackVersion}`,
    );
  }

  const cargoLock = await readFile(join(crateDir, "Cargo.lock"), "utf8");
  const lockedWasmBindgen = cargoLock.match(
    /\[\[package\]\]\nname = "wasm-bindgen"\nversion = "([^"]+)"/,
  )?.[1];
  if (lockedWasmBindgen !== manifest.toolchain.wasmBindgen) {
    fail(
      `Cargo.lock must pin wasm-bindgen ${manifest.toolchain.wasmBindgen}; found ${lockedWasmBindgen ?? "no entry"}`,
    );
  }

  const toolchainFile = await readFile(
    join(repoRoot, "rust-toolchain.toml"),
    "utf8",
  );
  if (!toolchainFile.includes(`channel = "${manifest.toolchain.rust}"`)) {
    fail("rust-toolchain.toml and artifacts.json disagree");
  }
}

async function deterministicBuildEnvironment() {
  const configuredCargoHome = resolve(
    process.env.CARGO_HOME || join(homedir(), ".cargo"),
  );
  const cargoHome = await realpath(configuredCargoHome);
  const canonicalRepoRoot = await realpath(repoRoot);
  const pathRemaps = new Map([
    [configuredCargoHome, "/cargo-home"],
    [cargoHome, "/cargo-home"],
    [repoRoot, "/workspace"],
    [canonicalRepoRoot, "/workspace"],
  ]);
  const env = {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: Array.from(
      pathRemaps,
      ([source, destination]) => `--remap-path-prefix=${source}=${destination}`,
    ).join("\x1f"),
    CARGO_INCREMENTAL: "0",
    LANG: "C",
    LC_ALL: "C",
    SOURCE_DATE_EPOCH: "1",
    TZ: "UTC",
  };
  for (const name of [
    "CARGO_BUILD_RUSTFLAGS",
    "CARGO_PROFILE_RELEASE_CODEGEN_UNITS",
    "CARGO_PROFILE_RELEASE_DEBUG",
    "CARGO_PROFILE_RELEASE_LTO",
    "CARGO_PROFILE_RELEASE_OPT_LEVEL",
    "CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "RUSTFLAGS",
  ]) {
    delete env[name];
  }
  return {
    env,
    forbiddenPaths: Array.from(
      new Set([
        configuredCargoHome,
        cargoHome,
        repoRoot,
        canonicalRepoRoot,
        homedir(),
      ]),
    ),
  };
}

async function build(outDir) {
  const { env, forbiddenPaths } = await deterministicBuildEnvironment();
  await rm(outDir, { force: true, recursive: true });
  run(
    "wasm-pack",
    [
      "build",
      "--target",
      "web",
      "--out-dir",
      outDir,
      "--out-name",
      "simd_math",
      "--release",
      "--locked",
      "--no-pack",
    ],
    { env },
  );
  return forbiddenPaths;
}

async function inspectArtifacts(outDir, forbiddenPaths) {
  const js = await readFile(join(outDir, "simd_math.js"));
  const wasm = await readFile(join(outDir, "simd_math_bg.wasm"));

  for (const forbiddenPath of forbiddenPaths) {
    const encodedPath = Buffer.from(forbiddenPath);
    if (js.includes(encodedPath) || wasm.includes(encodedPath)) {
      fail(
        `generated artifacts contain an unremapped machine path: ${forbiddenPath}`,
      );
    }
  }

  const moduleUrl = `data:text/javascript;base64,${js.toString("base64")}`;
  const wasmModule = await import(moduleUrl);
  const moduleExports = Object.keys(wasmModule).sort();
  const simdMathMethods = Object.getOwnPropertyNames(
    wasmModule.SIMDMath.prototype,
  ).sort();
  const wasmExports = WebAssembly.Module.exports(new WebAssembly.Module(wasm))
    .map(({ name }) => name)
    .sort();

  await wasmModule.default({ module_or_path: wasm });
  const math = new wasmModule.SIMDMath();
  try {
    const cosine = math.cosine_similarity(
      new Float32Array([1, 0]),
      new Float32Array([1, 0]),
    );
    const batch = Array.from(
      math.batch_similarity(
        new Float32Array([1, 0, 0, 1]),
        new Float32Array([1, 0]),
        2,
      ),
    );
    if (Math.abs(cosine - 1) > 1e-5 || JSON.stringify(batch) !== "[1,0]") {
      fail(`WASM runtime smoke test failed (cosine ${cosine}, batch ${batch})`);
    }
  } finally {
    math.free();
  }

  return {
    contents: {
      "simd_math.js": js,
      "simd_math_bg.wasm": wasm,
    },
    hashes: {
      "simd_math.js": sha256(js),
      "simd_math_bg.wasm": sha256(wasm),
    },
    interface: { moduleExports, simdMathMethods, wasmExports },
  };
}

function assertInterface(actual, expected) {
  assertEqualList(
    "JavaScript module exports",
    actual.moduleExports,
    expected.moduleExports,
  );
  assertEqualList(
    "SIMDMath prototype",
    actual.simdMathMethods,
    expected.simdMathMethods,
  );
  assertEqualList(
    "WebAssembly exports",
    actual.wasmExports,
    expected.wasmExports,
  );
}

async function copyRuntimeArtifacts(contents) {
  for (const artifactName of artifactNames) {
    const destination = join(extensionWorkerDir, artifactName);
    if (contents) {
      await writeFile(destination, contents[artifactName]);
    } else {
      await copyFile(join(packageOutputDir, artifactName), destination);
    }
  }
}

async function sync(manifest) {
  const forbiddenPaths = await build(packageOutputDir);
  const artifacts = await inspectArtifacts(packageOutputDir, forbiddenPaths);
  assertInterface(artifacts.interface, manifest.interface);

  const updatedManifest = { ...manifest, artifacts: artifacts.hashes };
  await writeFile(
    manifestPath,
    `${JSON.stringify(updatedManifest, null, 2)}\n`,
    "utf8",
  );
  await copyRuntimeArtifacts(artifacts.contents);

  console.log(
    `[wasm-simd] synchronized ${artifactNames.length} runtime artifacts`,
  );
  for (const artifactName of artifactNames) {
    console.log(
      `[wasm-simd] ${artifacts.hashes[artifactName]}  ${artifactName}`,
    );
  }
}

async function verify(manifest) {
  const temporaryOutput = await mkdtemp(join(tmpdir(), "webpage-mcp-wasm-"));
  try {
    const forbiddenPaths = await build(temporaryOutput);
    const rebuilt = await inspectArtifacts(temporaryOutput, forbiddenPaths);
    assertInterface(rebuilt.interface, manifest.interface);

    for (const artifactName of artifactNames) {
      const expectedHash = manifest.artifacts[artifactName];
      const rebuiltHash = rebuilt.hashes[artifactName];
      if (rebuiltHash !== expectedHash) {
        fail(
          `${artifactName} is stale (manifest ${expectedHash}, rebuilt ${rebuiltHash}); run pnpm build:wasm`,
        );
      }

      const tracked = await readFile(join(extensionWorkerDir, artifactName));
      const trackedHash = sha256(tracked);
      if (trackedHash !== expectedHash) {
        fail(
          `tracked ${artifactName} does not match artifacts.json (expected ${expectedHash}, found ${trackedHash})`,
        );
      }
    }

    console.log(
      "[wasm-simd] source rebuild, runtime behavior, hashes, and public interface verified",
    );
  } finally {
    await rm(temporaryOutput, { force: true, recursive: true });
  }
}

async function copy(manifest) {
  const { forbiddenPaths } = await deterministicBuildEnvironment();
  const artifacts = await inspectArtifacts(packageOutputDir, forbiddenPaths);
  assertInterface(artifacts.interface, manifest.interface);
  for (const artifactName of artifactNames) {
    if (artifacts.hashes[artifactName] !== manifest.artifacts[artifactName]) {
      fail(`${artifactName} in pkg is not the verified release artifact`);
    }
  }
  await copyRuntimeArtifacts();
  console.log(
    `[wasm-simd] copied ${artifactNames.length} verified runtime artifacts`,
  );
}

const command = process.argv[2];
const manifest = await loadManifest();

if (command === "sync" || command === "verify") {
  await assertToolchain(manifest);
}

if (command === "sync") {
  await sync(manifest);
} else if (command === "verify") {
  await verify(manifest);
} else if (command === "copy") {
  await copy(manifest);
} else {
  fail("usage: wasm-artifacts.mjs <sync|verify|copy>");
}
