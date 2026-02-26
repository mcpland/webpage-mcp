const { spawnSync } = require("node:child_process");

function commandExists(command) {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { stdio: "ignore" });
  return result.status === 0;
}

if (!commandExists("wasm-pack")) {
  console.warn(
    "[wasm-simd] Skipping tests because wasm-pack is not installed or not in PATH.",
  );
  process.exit(0);
}

const args = ["test", "--headless", "--firefox"];
const run = spawnSync("wasm-pack", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (run.error) {
  console.error(`[wasm-simd] Failed to start wasm-pack: ${run.error.message}`);
  process.exit(1);
}

process.exit(run.status ?? 1);
