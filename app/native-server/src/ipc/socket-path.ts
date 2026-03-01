import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOCKET_ENV = 'WEBPAGE_MCP_NATIVE_SOCKET';
const SOCKET_DIR_ENV = 'WEBPAGE_MCP_NATIVE_SOCKET_DIR';
const SOCKET_DIR_NAME = '.webpage-mcp';

function getSocketUserToken(): string {
  if (process.platform === 'win32') {
    return (process.env.USERNAME || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'default';
  return String(uid).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getDefaultUnixSocketPath(): string {
  const explicitDir = process.env[SOCKET_DIR_ENV]?.trim();
  if (explicitDir) {
    return path.join(explicitDir, `native-${getSocketUserToken()}.sock`);
  }
  const homeDir = process.env.HOME?.trim() || os.homedir();
  return path.join(homeDir, SOCKET_DIR_NAME, `native-${getSocketUserToken()}.sock`);
}

export function getLegacyNativeSocketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\webpage-mcp-native-${getSocketUserToken()}`;
  }
  return path.join(os.tmpdir(), `webpage-mcp-native-${getSocketUserToken()}.sock`);
}

export function getNativeSocketPath(): string {
  const explicit = process.env[SOCKET_ENV]?.trim();
  if (explicit) {
    return explicit;
  }

  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\webpage-mcp-native-${getSocketUserToken()}`;
  }

  return getDefaultUnixSocketPath();
}

export function ensureNativeSocketParentDir(socketPath = getNativeSocketPath()): void {
  if (process.platform === 'win32') {
    return;
  }
  const parentDir = path.dirname(socketPath);
  if (!parentDir || parentDir === '.') {
    return;
  }
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
}
