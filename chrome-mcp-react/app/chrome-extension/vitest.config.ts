import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

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
    // TypeScript support via esbuild (faster than ts-jest)
    typecheck: {
      enabled: false, // Run separately with vue-tsc
    },
  },
});
