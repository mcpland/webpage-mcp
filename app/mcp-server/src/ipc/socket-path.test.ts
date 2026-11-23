import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNativeSocketPathFits,
  getNativeSocketPathCandidates,
  getUnixSocketPathByteLimit,
} from './socket-path';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

describe('getNativeSocketPathCandidates', () => {
  it('returns a single named pipe for Windows regardless of the host platform', () => {
    vi.stubEnv('WEBPAGE_MCP_NATIVE_SOCKET', '');
    vi.stubEnv('WEBPAGE_MCP_NATIVE_SOCKET_DIR', '');
    vi.stubEnv('USERNAME', 'example.user');
    expect(getNativeSocketPathCandidates('win32')).toEqual([String.raw`\\.\pipe\webpage-mcp-native-example_user`]);
  });

  it('omits the legacy tmp path when WEBPAGE_MCP_NATIVE_SOCKET_DIR is set', () => {
    vi.stubEnv('WEBPAGE_MCP_NATIVE_SOCKET', '');
    vi.stubEnv('WEBPAGE_MCP_NATIVE_SOCKET_DIR', '/tmp/short-wmcp');
    const candidates = getNativeSocketPathCandidates('darwin');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatch(/^\/tmp\/short-wmcp\/native-/);
  });

  it('drops an oversized legacy tmp path instead of aborting retries on a valid primary path', () => {
    vi.stubEnv('WEBPAGE_MCP_NATIVE_SOCKET', '');
    vi.stubEnv('WEBPAGE_MCP_NATIVE_SOCKET_DIR', '');
    vi.stubEnv('HOME', '/tmp/h');
    vi.spyOn(os, 'tmpdir').mockReturnValue(`/private/tmp/${'x'.repeat(95)}`);
    const candidates = getNativeSocketPathCandidates('darwin');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatch(/^\/tmp\/h\/\.webpage-mcp\/native-/);
  });
});
