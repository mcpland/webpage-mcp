const isCI = process.env.CI === 'true';

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverage: isCI,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/scripts/**/*'],
  coverageDirectory: 'coverage',
  ...(isCI
    ? {
        coverageThreshold: {
          global: {
            branches: 70,
            functions: 80,
            lines: 80,
            statements: 80,
          },
        },
      }
    : {}),
};
