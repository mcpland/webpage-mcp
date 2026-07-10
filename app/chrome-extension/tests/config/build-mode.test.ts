import { describe, expect, it } from 'vitest';
import { shouldMinifyExtensionBuild } from '@/config/build-mode';

describe('extension build mode', () => {
  it('minifies production bundles', () => {
    expect(shouldMinifyExtensionBuild('production')).toBe(true);
  });

  it.each(['development', 'test', ''])('keeps %s bundles readable', (mode) => {
    expect(shouldMinifyExtensionBuild(mode)).toBe(false);
  });
});
