import { describe, expect, it } from 'vitest';
import { assertNativeSocketPathFits, getUnixSocketPathByteLimit } from './socket-path';

describe('assertNativeSocketPathFits', () => {
  it('accepts the default-length socket paths', () => {
    expect(() =>
      assertNativeSocketPathFits('/Users/someone/.webpage-mcp/native-501.sock', 'darwin'),
    ).not.toThrow();
  });

  it('rejects paths longer than the platform limit with an actionable message', () => {
    const tooLong = `/private/tmp/${'x'.repeat(100)}/native.sock`;
    expect(() => assertNativeSocketPathFits(tooLong, 'darwin')).toThrow(
      /longer than the 103-byte Unix socket limit.*WEBPAGE_MCP_NATIVE_SOCKET/,
    );
  });

  it('uses the exact sun_path limits per platform', () => {
    expect(getUnixSocketPathByteLimit('darwin')).toBe(103);
    expect(getUnixSocketPathByteLimit('linux')).toBe(107);
    const linuxEdge = `/${'a'.repeat(106)}`;
    expect(() => assertNativeSocketPathFits(linuxEdge, 'linux')).not.toThrow();
    expect(() => assertNativeSocketPathFits(`${linuxEdge}b`, 'linux')).toThrow();
    expect(() => assertNativeSocketPathFits(linuxEdge, 'darwin')).toThrow();
  });

  it('measures UTF-8 bytes rather than characters', () => {
    const multibyte = `/${'é'.repeat(52)}`; // 105 bytes, 53 characters
    expect(() => assertNativeSocketPathFits(multibyte, 'darwin')).toThrow();
  });

  it('does not restrict Windows named pipes', () => {
    expect(() =>
      assertNativeSocketPathFits(`\\\\.\\pipe\\${'x'.repeat(200)}`, 'win32'),
    ).not.toThrow();
  });
});
