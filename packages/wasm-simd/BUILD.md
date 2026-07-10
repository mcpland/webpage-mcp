# WASM SIMD Build Guide

## 🚀 Quick Build

### Prerequisites

```bash
# Install rustup. The repository's rust-toolchain.toml selects Rust 1.94.0
# and the wasm32-unknown-unknown target automatically.
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install the exact generator version recorded in artifacts.json.
cargo install wasm-pack --version '=0.15.0' --locked
```

### Build Options

1. **Build from project root** (Recommended):

   ```bash
   # Build WASM, update its hash manifest, and copy verified runtime files.
   pnpm build:wasm
   ```

2. **Build WASM package only**:

   ```bash
   # From the packages/wasm-simd directory
   pnpm build

   # Or use pnpm filter from anywhere
   pnpm --filter @webpage-mcp/wasm-simd build
   ```

3. **Development mode build**:
   ```bash
   pnpm build:dev  # Unoptimized package-only build, faster build
   ```

### Build Artifacts

After building, the following files will be generated in the `pkg/` directory:

- `simd_math.js` - JavaScript bindings
- `simd_math_bg.wasm` - WebAssembly binary file
- `simd_math.d.ts` - TypeScript type definitions
- `simd_math_bg.wasm.d.ts` - low-level WebAssembly export types

### Integration with Chrome Extension

WASM files are automatically copied to the `app/chrome-extension/workers/` directory, and the Chrome extension can use them directly:

```typescript
// Usage in Chrome extension
const wasmUrl = chrome.runtime.getURL("workers/simd_math.js");
const wasmModule = await import(wasmUrl);
```

## 🔧 Development Workflow

1. Modify the Rust code in `src/lib.rs`
2. Run `pnpm build:wasm` from the repository root
3. Review changes to `artifacts.json`, `simd_math.js`, and `simd_math_bg.wasm`
4. Run `pnpm verify:wasm` to rebuild in a clean temporary directory and verify hashes and exports

Release builds use `Cargo.lock`, the pinned Rust and wasm-pack versions, a fixed
source-date epoch, disabled incremental compilation, and remapped source paths.
This keeps user names, Cargo home paths, and worktree paths out of the committed
WASM binary. CI performs the same clean rebuild and rejects stale artifacts or a
public JavaScript/WebAssembly interface change.

## ✅ Correctness and Artifact Verification

```bash
# Exercise the Rust implementation, including tails and invalid inputs.
pnpm --filter @webpage-mcp/wasm-simd test

# Rebuild in a clean temporary directory and verify hashes, exports, and
# generated-module cosine/batch smoke checks.
pnpm verify:wasm
```

The repository does not currently ship a reproducible performance benchmark.
Performance claims require a checked-in harness, documented hardware and
browser/runtime versions, warm-up and sampling rules, and a reviewable baseline;
the presence of SIMD instructions alone is not a benchmark result.
