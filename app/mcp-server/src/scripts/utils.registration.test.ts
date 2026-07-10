import { describe, expect, it } from 'vitest';

import { EXTENSION_ID } from './constant';
import { resolveAllowedOrigins } from './utils';

describe('Native Messaging registration security', () => {
  it('authorizes the published Chrome Web Store extension by default', () => {
    expect(EXTENSION_ID).toBe('iehgbogeakiedihodennfcnigojnncag');
    expect(resolveAllowedOrigins()).toContain(
      'chrome-extension://iehgbogeakiedihodennfcnigojnncag/',
    );
  });
});
