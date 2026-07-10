import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const enforceCoverage = process.env.ENFORCE_COVERAGE === 'true';

export default defineConfig({
  resolve: {
    alias: {
      // Match WXT's path aliases from .wxt/tsconfig.json
      '@': rootDir,
      '~': rootDir,
      // Mock hnswlib-wasm-static to avoid native module issues in tests
      'hnswlib-wasm-static': `${rootDir}/tests/__mocks__/hnswlib-wasm-static.ts`,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', '.output', 'dist', '.wxt'],
    setupFiles: ['tests/vitest.setup.ts'],
    environmentOptions: {
      jsdom: {
        // Provide a stable URL for anchor/href tests
        url: 'https://example.com/',
      },
    },
    // Auto-cleanup mocks between tests
    clearMocks: true,
    restoreMocks: true,
    testTimeout: enforceCoverage ? 30_000 : 5_000,
    coverage: {
      enabled: enforceCoverage,
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'html'],
      include: [
        'common/**/*.{ts,tsx}',
        'config/**/*.{ts,tsx}',
        'entrypoints/**/*.{ts,tsx}',
        'inject-scripts/**/*.js',
        'shared/**/*.{ts,tsx}',
        'utils/**/*.{ts,tsx}',
        'workers/similarity.worker.js',
      ],
      exclude: ['**/*.d.ts'],
      // Measured across production TypeScript plus first-party page/Worker JS.
      // Generated WASM glue and vendored runtime files are intentionally outside
      // these roots. Keep a small runtime margin while preventing regressions.
      thresholds: {
        branches: 63,
        functions: 71,
        lines: 48,
        statements: 48,
      },
    },
    // TypeScript support via esbuild (faster than ts-jest)
    typecheck: {
      enabled: false,
    },
  },
});
