const CANONICAL_BUILD_PLATFORM = Object.freeze({ os: "linux", arch: "x64" });

function fail(message) {
  throw new Error(`[wasm-simd] ${message}`);
}

export function assertCanonicalWasmBuildPlatform(
  manifest,
  current = { os: process.platform, arch: process.arch },
) {
  const configured = manifest?.buildPlatform;
  if (
    configured === null ||
    typeof configured !== "object" ||
    Array.isArray(configured) ||
    JSON.stringify(Object.keys(configured)) !==
      JSON.stringify(["os", "arch"]) ||
    configured.os !== CANONICAL_BUILD_PLATFORM.os ||
    configured.arch !== CANONICAL_BUILD_PLATFORM.arch
  ) {
    fail("artifacts.json must pin the canonical Linux x64 build platform");
  }
  if (current.os !== configured.os || current.arch !== configured.arch) {
    fail(
      `release artifact generation requires ${configured.os} ${configured.arch}; ` +
        `current platform is ${current.os} ${current.arch}. Use verify:runtime ` +
        "for cross-platform checks and CI for canonical release bytes",
    );
  }
}
