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
  it('measures production TypeScript and first-party page and Worker JavaScript', () => {
    const testConfig = (vitestConfig as { test?: Record<string, unknown> }).test;
    const coverage = testConfig?.coverage as CoveragePolicy | undefined;

    expect(coverage?.enabled).toBe(process.env.ENFORCE_COVERAGE === 'true');
    expect(coverage?.include).toEqual(
      expect.arrayContaining([
        'common/**/*.{ts,tsx}',
        'entrypoints/**/*.{ts,tsx}',
        'inject-scripts/**/*.js',
        'shared/**/*.{ts,tsx}',
        'utils/**/*.{ts,tsx}',
        'workers/similarity.worker.js',
      ]),
    );
    expect(coverage?.thresholds).toMatchObject({
      branches: 63,
      functions: 71,
      lines: 48,
      statements: 48,
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
