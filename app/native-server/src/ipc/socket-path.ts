import os from 'node:os';
import path from 'node:path';

const SOCKET_ENV = 'WEBPAGE_MCP_NATIVE_SOCKET';

export function getNativeSocketPath(): string {
  const explicit = process.env[SOCKET_ENV]?.trim();
  if (explicit) {
    return explicit;
  }

  if (process.platform === 'win32') {
    const user = (process.env.USERNAME || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `\\\\.\\pipe\\webpage-mcp-native-${user}`;
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : 'default';
  return path.join(os.tmpdir(), `webpage-mcp-native-${uid}.sock`);
}
