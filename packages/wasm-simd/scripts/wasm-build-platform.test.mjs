import assert from "node:assert/strict";
import test from "node:test";
import { assertCanonicalWasmBuildPlatform } from "./wasm-build-platform.mjs";

const manifest = { buildPlatform: { os: "linux", arch: "x64" } };

test("canonical WASM release builds accept Linux x64", () => {
  assert.doesNotThrow(() =>
    assertCanonicalWasmBuildPlatform(manifest, { os: "linux", arch: "x64" }),
  );
});

test("WASM release builds reject a noncanonical host with actionable guidance", () => {
  assert.throws(
    () =>
      assertCanonicalWasmBuildPlatform(manifest, {
        os: "darwin",
        arch: "arm64",
      }),
    /requires linux x64; current platform is darwin arm64.*verify:runtime/,
  );
});

test("WASM release policy rejects manifest platform drift", () => {
  assert.throws(
    () =>
      assertCanonicalWasmBuildPlatform(
        { buildPlatform: { os: "darwin", arch: "arm64" } },
        { os: "darwin", arch: "arm64" },
      ),
    /must pin the canonical Linux x64 build platform/,
  );
});
