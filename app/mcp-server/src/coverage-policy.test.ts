import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config';

interface CoveragePolicy {
  enabled?: boolean;
  exclude?: string[];
  thresholds?: Record<string, number>;
}

describe('coverage policy', () => {
  it('measures production sources and enforces an honest baseline', () => {
    const coverage = (vitestConfig as { test?: { coverage?: CoveragePolicy } }).test?.coverage;

    expect(coverage?.enabled).toBe(process.env.ENFORCE_COVERAGE === 'true');
    expect(coverage?.exclude).toEqual(
      expect.arrayContaining(['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/*.d.ts']),
    );
    expect(coverage?.exclude).not.toContain('src/scripts/**/*');
    expect(coverage?.thresholds).toMatchObject({
      branches: 65,
      functions: 70,
      lines: 50,
      statements: 50,
    });
  });

  it('enables the coverage gate in the CI test job', () => {
    const workflowPath = path.resolve(__dirname, '../../../.github/workflows/ci.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    expect(workflow).toMatch(/- name: Test[\s\S]*?ENFORCE_COVERAGE:\s*["']?true["']?/);
  });
});
