import { describe, expect, it } from 'vitest';
import {
  normalizeBrowserTargetRef,
  normalizeBrowserTargetSelector,
} from '@/entrypoints/background/tools/browser/target-resolution';

describe('browser target input limits', () => {
  it('bounds selectors by UTF-8 bytes', () => {
    expect(() => normalizeBrowserTargetSelector('😀'.repeat(1025))).toThrow(
      '4096-byte UTF-8 limit',
    );
    expect(normalizeBrowserTargetSelector('  #submit  ')).toBe('#submit');
  });

  it('rejects expensive :has selectors at the background boundary', () => {
    expect(() => normalizeBrowserTargetSelector('main:has(button)', 'css')).toThrow(
      ':has()',
    );
    expect(normalizeBrowserTargetSelector('//div[contains(., ":has(")]', 'xpath')).toContain(
      ':has(',
    );
  });

  it('bounds refs independently of selector validation', () => {
    expect(() => normalizeBrowserTargetRef('r'.repeat(129))).toThrow(
      '128-byte UTF-8 limit',
    );
    expect(normalizeBrowserTargetRef('  ref_123  ')).toBe('ref_123');
  });
});
