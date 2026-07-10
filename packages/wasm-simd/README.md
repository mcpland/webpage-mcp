# @webpage-mcp/wasm-simd

SIMD-enabled WebAssembly math functions for vector operations.

## Features

- SIMD acceleration using WebAssembly SIMD instructions
- Vector operations: cosine similarity, batch similarity, similarity matrix
- Browser-compatible WASM module for extension-side use

## Correctness and reproducibility

From the repository root:

```bash
pnpm --filter @webpage-mcp/wasm-simd test
pnpm verify:wasm
```

The Rust tests cover SIMD-lane tails, mismatched and zero-length inputs, and
batch/matrix result ordering. `pnpm verify:wasm` performs a clean deterministic
rebuild, checks the generated JavaScript and WebAssembly export surfaces and
hashes, and executes cosine and batch smoke checks against the generated module.

These checks establish numerical behavior and artifact reproducibility. This
repository does not currently include a reproducible performance benchmark, so
it does not claim a particular speedup over JavaScript.

## API (Rust / wasm-bindgen)

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct SIMDMath;

#[wasm_bindgen]
impl SIMDMath {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SIMDMath { SIMDMath }

    #[wasm_bindgen]
    pub fn cosine_similarity(&self, vec_a: &[f32], vec_b: &[f32]) -> f32 {
        // implementation in src/lib.rs
    }
}
```

## Build

From repository root:

```bash
pnpm build:wasm
pnpm verify:wasm
```

Inside this package:

```bash
pnpm build
pnpm build:dev
```

The release toolchain and generated artifact hashes/exports are recorded in
`rust-toolchain.toml`, `Cargo.lock`, and `artifacts.json`. `pnpm build:wasm`
performs a deterministic release build and synchronizes the extension workers;
`pnpm verify:wasm` independently rebuilds and rejects any source/artifact drift.

## Browser Support

- Chrome 91+
- Firefox 89+
- Safari 16.4+
- Edge 91+

When SIMD is not available, callers should use JavaScript fallback logic.
