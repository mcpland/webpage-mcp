// @vitest-environment node

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../../vitest.config';

interface CoveragePolicy {
  enabled?: boolean;
  include?: string[];
  thresholds?: Record<string, number>;
}

describe('extension coverage policy', () => {
  it('measures the full production TypeScript surface at an honest baseline', () => {
    const testConfig = (vitestConfig as { test?: Record<string, unknown> }).test;
    const coverage = testConfig?.coverage as CoveragePolicy | undefined;

    expect(coverage?.enabled).toBe(process.env.ENFORCE_COVERAGE === 'true');
    expect(coverage?.include).toEqual(
      expect.arrayContaining([
        'common/**/*.{ts,tsx}',
        'entrypoints/**/*.{ts,tsx}',
        'shared/**/*.{ts,tsx}',
        'utils/**/*.{ts,tsx}',
      ]),
    );
    expect(coverage?.thresholds).toMatchObject({
      branches: 65,
      functions: 70,
      lines: 45,
      statements: 45,
    });
  });

  it('runs the coverage gate in CI and formal releases', () => {
    const repositoryRoot = path.resolve(__dirname, '../../../..');
    for (const workflowName of ['ci.yml', 'release.yml']) {
      const workflow = fs.readFileSync(
        path.join(repositoryRoot, '.github/workflows', workflowName),
        'utf8',
      );
      expect(workflow).toMatch(/ENFORCE_COVERAGE:\s*["']true["']/);
    }
  });
});
