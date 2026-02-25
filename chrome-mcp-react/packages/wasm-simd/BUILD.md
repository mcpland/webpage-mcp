# WASM SIMD Build Guide

## 🚀 Quick Build

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install wasm-pack
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
```

### Build Options

1. **Build from project root** (Recommended):

   ```bash
   # Build WASM and automatically copy to Chrome extension
   npm run build:wasm
   ```

2. **Build WASM package only**:

   ```bash
   # From the packages/wasm-simd directory
   npm run build

   # Or use pnpm filter from anywhere
   pnpm --filter @webpage-mcp/wasm-simd build
   ```

3. **Development mode build**:
   ```bash
   npm run build:dev  # Unoptimized version, faster build
   ```

### Build Artifacts

After building, the following files will be generated in the `pkg/` directory:

- `simd_math.js` - JavaScript bindings
- `simd_math_bg.wasm` - WebAssembly binary file
- `simd_math.d.ts` - TypeScript type definitions
- `package.json` - NPM package info

### Integration with Chrome Extension

WASM files are automatically copied to the `app/chrome-extension/workers/` directory, and the Chrome extension can use them directly:

```typescript
// Usage in Chrome extension
const wasmUrl = chrome.runtime.getURL("workers/simd_math.js");
const wasmModule = await import(wasmUrl);
```

## 🔧 Development Workflow

1. Modify the Rust code in `src/lib.rs`
2. Run `npm run build` to rebuild
3. Chrome extension will automatically use the new WASM files

## 📊 Performance Testing

```bash
# Run benchmarks in Chrome extension
import { runSIMDBenchmark } from './utils/simd-benchmark';
await runSIMDBenchmark();
```
