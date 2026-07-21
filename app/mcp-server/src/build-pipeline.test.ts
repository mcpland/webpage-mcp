import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import bundleBuild from '../tsup.bundle.config';
import transpileBuild from '../tsup.config';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('build pipeline', () => {
  it('runs the two tsup phases serially before postbuild', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.build.split(' && ')).toEqual([
      'tsup --config tsup.config.ts',
      'tsup --config tsup.bundle.config.ts',
      'node scripts/postbuild.mjs',
    ]);
  });

  it('cleans once before the bundled entries overwrite transpiled entries', () => {
    expect(Array.isArray(transpileBuild)).toBe(false);
    expect(Array.isArray(bundleBuild)).toBe(false);
    expect(typeof transpileBuild).toBe('object');
    expect(typeof bundleBuild).toBe('object');

    expect((transpileBuild as { clean?: boolean }).clean).toBe(true);
    expect((bundleBuild as { clean?: boolean }).clean).toBe(false);
    expect((bundleBuild as { metafile?: boolean }).metafile).toBe(true);
    expect((bundleBuild as { noExternal?: string[] }).noExternal).toContain(
      '@modelcontextprotocol/sdk',
    );
  });
});
