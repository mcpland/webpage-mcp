import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

import {
  WASM_PACK_TOOL,
  assertSupportedWasmPackPlatform,
  formatWasmPackInstallerError,
  installWasmPack,
} from "./install-wasm-pack.mjs";

const INSTALLER_URL = new URL("./install-wasm-pack.mjs", import.meta.url);

test("wasm-pack tool pin binds the official Linux x64 release bytes", async () => {
  assert.deepEqual(WASM_PACK_TOOL, {
    schemaVersion: 1,
    name: "wasm-pack",
    version: "0.15.0",
    platform: "linux",
    arch: "x64",
    archive: {
      url: "https://github.com/wasm-bindgen/wasm-pack/releases/download/v0.15.0/wasm-pack-v0.15.0-x86_64-unknown-linux-musl.tar.gz",
      size: 2_881_231,
      sha256:
        "c09f971ecaed9a2efc80fdcea7a00ef6b53c7fadc8c57d1f61b53a6aa66b668a",
    },
    binary: {
      entry: "wasm-pack-v0.15.0-x86_64-unknown-linux-musl/wasm-pack",
      filename: "wasm-pack",
      size: 7_169_920,
      sha256:
        "c6c3d54702f4bae4a1d51e37e19c2c61b130865dc3fabc745eebe8194b87b253",
      versionOutput: "wasm-pack 0.15.0",
      mode: "0755",
    },
  });
  assert.ok(Object.isFrozen(WASM_PACK_TOOL));
  assert.ok(Object.isFrozen(WASM_PACK_TOOL.archive));
  assert.ok(Object.isFrozen(WASM_PACK_TOOL.binary));

  const source = await readFile(INSTALLER_URL, "utf8");
  assert.doesNotMatch(source, /process\.env/);
});

test("wasm-pack platform and diagnostics fail closed", () => {
  assert.doesNotThrow(() => assertSupportedWasmPackPlatform("linux", "x64"));
  assert.throws(
    () => assertSupportedWasmPackPlatform("darwin", "arm64"),
    /unsupported platform darwin\/arm64/,
  );
  assert.equal(
    formatWasmPackInstallerError(new Error("signed-url-secret")),
    "[install-wasm-pack] installation failed; details withheld",
  );
});

test("wasm-pack installation delegates to the verified byte pipeline", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "wasm-pack-installer-"));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const directory = await realpath(temporary);
  const calls = [];
  let verification = 0;

  const target = await installWasmPack(directory, {
    platform: "linux",
    architecture: "x64",
    downloadArchive: async (archive, destination) => {
      calls.push(["download", archive]);
      await writeFile(destination, "archive");
    },
    extractBinary: async (archivePath, binary, destination) => {
      calls.push(["extract", archivePath, binary]);
      await writeFile(destination, "binary", { mode: 0o755 });
    },
    verifyBinary: async (_path, binary) => {
      calls.push(["verify", binary]);
      verification += 1;
      return verification > 1;
    },
    probeBinary: (binaryPath, binary) =>
      calls.push(["probe", binaryPath, binary]),
  });

  assert.equal(target, join(directory, "wasm-pack"));
  assert.deepEqual(await readFile(target, "utf8"), "binary");
  assert.deepEqual(
    calls.map(([operation]) => operation),
    ["verify", "download", "extract", "verify", "verify", "probe"],
  );
  assert.equal(calls[1][1], WASM_PACK_TOOL.archive);
  assert.equal(calls[2][2], WASM_PACK_TOOL.binary);
  assert.equal(calls.at(-1)[2], WASM_PACK_TOOL.binary);
});
