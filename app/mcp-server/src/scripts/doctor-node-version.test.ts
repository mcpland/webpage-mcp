import { describe, expect, it } from 'vitest';
import {
  MIN_NODE_MAJOR_VERSION,
  parseNodeMajorVersion,
} from './doctor';

describe('doctor Node.js support policy', () => {
  it('requires a maintained Node.js release line', () => {
    expect(MIN_NODE_MAJOR_VERSION).toBe(22);
    expect(parseNodeMajorVersion('v20.19.5')).toBeLessThan(
      MIN_NODE_MAJOR_VERSION,
    );
    expect(parseNodeMajorVersion('v22.22.0')).toBeGreaterThanOrEqual(
      MIN_NODE_MAJOR_VERSION,
    );
    expect(parseNodeMajorVersion('v24.17.0')).toBeGreaterThanOrEqual(
      MIN_NODE_MAJOR_VERSION,
    );
  });

  it('parses prerelease versions and rejects malformed output', () => {
    expect(parseNodeMajorVersion('v24.0.0-rc.1')).toBe(24);
    expect(parseNodeMajorVersion('not-node')).toBeNull();
  });
});
