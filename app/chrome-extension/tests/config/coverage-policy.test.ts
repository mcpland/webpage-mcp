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
    const ciWorkflow = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows/ci.yml'),
      'utf8',
    );
    const releaseWorkflow = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows/release.yml'),
      'utf8',
    );

    expect(ciWorkflow).toMatch(/ENFORCE_COVERAGE:\s*["']true["']/);
    expect(releaseWorkflow).toContain(
      "ENFORCE_COVERAGE: ${{ matrix.enforce_coverage && 'true' || 'false' }}",
    );
    expect(releaseWorkflow).toMatch(
      /platform: Linux\s*\n\s+os: ubuntu-latest\s*\n\s+enforce_coverage: true/,
    );
    expect(releaseWorkflow.match(/enforce_coverage:\s*true/g)).toHaveLength(1);
    expect(releaseWorkflow.match(/enforce_coverage:\s*false/g)).toHaveLength(2);
  });
});
