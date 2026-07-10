import { defineConfig } from 'vitest/config';

const isCI = process.env.CI === 'true';
const enforceCoverage = process.env.ENFORCE_COVERAGE === 'true';
const shouldCollectCoverage = isCI && enforceCoverage;

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./vitest.global-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['node_modules', 'dist', 'coverage'],
    coverage: {
      enabled: shouldCollectCoverage,
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/scripts/**/*'],
      ...(shouldCollectCoverage
        ? {
            thresholds: {
              branches: 70,
              functions: 80,
              lines: 80,
              statements: 80,
            },
          }
        : {}),
    },
  },
});
