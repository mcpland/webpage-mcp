import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INCLUDE_LOGS_MODE,
  parseIncludeLogsMode,
} from './report';

describe('diagnostic report log privacy', () => {
  it('excludes native-host logs unless the caller explicitly opts in', () => {
    expect(DEFAULT_INCLUDE_LOGS_MODE).toBe('none');
    expect(parseIncludeLogsMode(undefined)).toBe('none');
    expect(parseIncludeLogsMode('')).toBe('none');
  });

  it.each(['none', 'tail', 'full'] as const)(
    'accepts the explicit %s mode',
    (mode) => {
      expect(parseIncludeLogsMode(mode)).toBe(mode);
    },
  );

  it('fails closed on an invalid mode', () => {
    expect(() => parseIncludeLogsMode('everything')).toThrow(
      'Invalid include-logs mode',
    );
  });
});
