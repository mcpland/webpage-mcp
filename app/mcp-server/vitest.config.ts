import { defineConfig } from 'vitest/config';

const enforceCoverage = process.env.ENFORCE_COVERAGE === 'true';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./vitest.global-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['node_modules', 'dist', 'coverage'],
    coverage: {
      enabled: enforceCoverage,
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
      ],
      // Production-only baseline. Raise these as untested CLI/engine paths gain coverage.
      thresholds: {
        branches: 65,
        functions: 70,
        lines: 50,
        statements: 50,
      },
    },
  },
});
