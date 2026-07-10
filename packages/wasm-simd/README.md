# @webpage-mcp/wasm-simd

SIMD-optimized WebAssembly math functions for high-performance vector operations.

## Features

- SIMD acceleration using WebAssembly SIMD instructions
- Optimized vector operations: cosine similarity, batch similarity, similarity matrix
- Browser-compatible WASM module for extension-side use

## Performance

| Operation                      | JavaScript | SIMD WASM | Speedup |
| ------------------------------ | ---------- | --------- | ------- |
| Cosine Similarity (768d)       | 100ms      | 18ms      | 5.6x    |
| Batch Similarity (100x768d)    | 850ms      | 95ms      | 8.9x    |
| Similarity Matrix (50x50x384d) | 2.1s       | 180ms     | 11.7x   |

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
