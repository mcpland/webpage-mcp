import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOCKET_ENV = 'WEBPAGE_MCP_NATIVE_SOCKET';
const SOCKET_DIR_ENV = 'WEBPAGE_MCP_NATIVE_SOCKET_DIR';
const SOCKET_DIR_NAME = '.webpage-mcp';

function getSocketUserToken(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return (process.env.USERNAME || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'default';
  return String(uid).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getDefaultUnixSocketPath(platform: NodeJS.Platform): string {
  const explicitDir = process.env[SOCKET_DIR_ENV]?.trim();
  if (explicitDir) {
    return path.posix.join(explicitDir, `native-${getSocketUserToken(platform)}.sock`);
  }
  const homeDir = process.env.HOME?.trim() || os.homedir();
  return path.posix.join(homeDir, SOCKET_DIR_NAME, `native-${getSocketUserToken(platform)}.sock`);
}

export function getLegacyNativeSocketPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\webpage-mcp-native-${getSocketUserToken(platform)}`;
  }
  return path.posix.join(os.tmpdir(), `webpage-mcp-native-${getSocketUserToken(platform)}.sock`);
}

export function getNativeSocketPath(platform: NodeJS.Platform = process.platform): string {
  const explicit = process.env[SOCKET_ENV]?.trim();
  if (explicit) {
    return explicit;
  }

  if (platform === 'win32') {
    return `\\\\.\\pipe\\webpage-mcp-native-${getSocketUserToken(platform)}`;
  }

  return getDefaultUnixSocketPath(platform);
}

export function hasExplicitNativeSocketConfig(): boolean {
  return Boolean(process.env[SOCKET_ENV]?.trim() || process.env[SOCKET_DIR_ENV]?.trim());
}

/**
 * Longest Unix domain socket path in bytes (sockaddr_un.sun_path minus the
 * terminating NUL): 104 bytes on macOS/BSD, 108 on Linux.
 */
export function getUnixSocketPathByteLimit(platform: NodeJS.Platform = process.platform): number {
  return platform === 'linux' ? 107 : 103;
}

export function isNativeSocketPathWithinLimit(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return true;
  return Buffer.byteLength(socketPath, 'utf8') <= getUnixSocketPathByteLimit(platform);
}

export function getNativeSocketPathCandidates(
  platform: NodeJS.Platform = process.platform,
): string[] {
  const primaryPath = getNativeSocketPath(platform);
  if (hasExplicitNativeSocketConfig()) {
    return [primaryPath];
  }

  const legacyPath = getLegacyNativeSocketPath(platform);
  if (legacyPath === primaryPath || !isNativeSocketPathWithinLimit(legacyPath, platform)) {
    return [primaryPath];
  }
  return [primaryPath, legacyPath];
}

/**
 * Throw a descriptive error for a socket path the OS cannot bind or connect.
 * Without this check the native host only fails with `listen EINVAL` and the
 * extension reports an unexplained "Native host has exited".
 */
export function assertNativeSocketPathFits(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') return; // named pipes have no sun_path limit
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  const limit = getUnixSocketPathByteLimit(platform);
  if (bytes > limit) {
    throw new Error(
      `Native IPC socket path is ${bytes} bytes, longer than the ${limit}-byte Unix socket limit: ${socketPath}. ` +
        `Point ${SOCKET_ENV} (or ${SOCKET_DIR_ENV}) at a shorter path.`,
    );
  }
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
