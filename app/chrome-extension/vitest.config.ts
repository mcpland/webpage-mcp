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
        'shared/**/*.{ts,tsx}',
        'utils/**/*.{ts,tsx}',
      ],
      exclude: ['**/*.d.ts'],
      // Measured across all production TypeScript. Keep a small runtime margin
      // while preventing material regressions on the extension's broad surface.
      thresholds: {
        branches: 65,
        functions: 70,
        lines: 45,
        statements: 45,
      },
    },
    // TypeScript support via esbuild (faster than ts-jest)
    typecheck: {
      enabled: false,
    },
  },
});
