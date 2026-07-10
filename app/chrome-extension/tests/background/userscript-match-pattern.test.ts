import { describe, expect, it } from 'vitest';

import { matchUrl } from '@/entrypoints/background/tools/browser/userscript';

describe('userscript URL match patterns', () => {
  it('matches explicit schemes, wildcard hosts, paths, queries, and fragments', () => {
    expect(matchUrl(['https://*.example.com/api/*'], 'https://example.com/api/users')).toBe(true);
    expect(matchUrl(['https://*.example.com/api/*'], 'https://a.b.example.com/api/users')).toBe(
      true,
    );
    expect(matchUrl(['http://example.com/search*done'], 'http://example.com/search?q=1#done')).toBe(
      true,
    );
    expect(matchUrl(['https://example.com/*'], 'http://example.com/path')).toBe(false);
    expect(matchUrl(['<all_urls>'], 'https://anywhere.test/path')).toBe(true);
  });

  it('handles many wildcard segments without compiling a backtracking regex', () => {
    const repeated = `${'*a'.repeat(500)}*z`;
    const longPath = `${'a'.repeat(8_000)}y`;

    expect(matchUrl([`https://example.com/${repeated}`], `https://example.com/${longPath}`)).toBe(
      false,
    );
  });

  it('ignores excessive patterns and boundedly processes only the first set', () => {
    const patterns = Array.from({ length: 100 }, () => 'https://blocked.test/*');
    patterns.push('https://example.com/*');
    expect(matchUrl(patterns, 'https://example.com/path')).toBe(false);
    expect(matchUrl([`https://example.com/${'x'.repeat(3_000)}`], 'https://example.com/path')).toBe(
      false,
    );
  });
});
