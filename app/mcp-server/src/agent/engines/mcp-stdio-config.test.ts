import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MCP_INSTANCE_ID } from 'webpage-mcp-shared';
import { WEBPAGE_MCP_INSTANCE_ID_ENV } from '../../instance-id';
import { resolveWebpageMcpStdioConfig } from './mcp-stdio-config';

const ORIGINAL_COMMAND = process.env.WEBPAGE_MCP_STDIO_COMMAND;
const ORIGINAL_ARGS = process.env.WEBPAGE_MCP_STDIO_ARGS;
const ORIGINAL_SOCKET = process.env.WEBPAGE_MCP_NATIVE_SOCKET;
const ORIGINAL_SOCKET_PATH = ORIGINAL_SOCKET?.trim();

function restoreEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  restoreEnvironmentValue('WEBPAGE_MCP_STDIO_COMMAND', ORIGINAL_COMMAND);
  restoreEnvironmentValue('WEBPAGE_MCP_STDIO_ARGS', ORIGINAL_ARGS);
  restoreEnvironmentValue('WEBPAGE_MCP_NATIVE_SOCKET', ORIGINAL_SOCKET);
});

describe('resolveWebpageMcpStdioConfig', () => {
  it('targets the default instance when the owning Server omits instanceId', () => {
    delete process.env.WEBPAGE_MCP_NATIVE_SOCKET;

    const config = resolveWebpageMcpStdioConfig();

    expect(config.env).toEqual({
      [WEBPAGE_MCP_INSTANCE_ID_ENV]: DEFAULT_MCP_INSTANCE_ID,
    });
  });

  it('carries a non-default Server instance through the embedded MCP environment', () => {
    process.env.WEBPAGE_MCP_NATIVE_SOCKET = '/tmp/custom-native.sock';

    const config = resolveWebpageMcpStdioConfig('tenant-a');

    expect(config.env).toEqual({
      [WEBPAGE_MCP_INSTANCE_ID_ENV]: 'tenant-a',
      WEBPAGE_MCP_NATIVE_SOCKET: '/tmp/custom-native.sock',
    });
  });

  it('keeps instance routing when an explicit stdio command is configured', () => {
    process.env.WEBPAGE_MCP_STDIO_COMMAND = 'custom-webpage-mcp-stdio';
    process.env.WEBPAGE_MCP_STDIO_ARGS = '--mode embedded';

    expect(resolveWebpageMcpStdioConfig('tenant-b')).toEqual({
      command: 'custom-webpage-mcp-stdio',
      args: ['--mode', 'embedded'],
      env: {
        [WEBPAGE_MCP_INSTANCE_ID_ENV]: 'tenant-b',
        ...(ORIGINAL_SOCKET_PATH ? { WEBPAGE_MCP_NATIVE_SOCKET: ORIGINAL_SOCKET_PATH } : {}),
      },
    });
  });
});
