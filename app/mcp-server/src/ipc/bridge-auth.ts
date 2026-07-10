import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getNativeSocketPath } from './socket-path';

const AUTH_DIR_ENV = 'WEBPAGE_MCP_NATIVE_AUTH_DIR';
const AUTH_DIR_NAME = 'ipc-auth';
const AUTH_FILE_VERSION = 1;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const IPC_AUTH_METHOD = 'authenticate';

interface StoredBridgeCredential {
  version: number;
  token: string;
}

export interface NativeIpcCredential {
  filePath: string;
  token: string;
}

function getDefaultAuthDir(): string {
  const explicitDir = process.env[AUTH_DIR_ENV]?.trim();
  if (explicitDir) {
    return path.resolve(explicitDir);
  }
  const homeDir = process.env.HOME?.trim() || os.homedir();
  return path.join(homeDir, '.webpage-mcp', AUTH_DIR_NAME);
}

function assertSecureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Native IPC credential directory must be a real directory');
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, 0o700);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Native IPC credential directory must be owned by the current user');
    }
  }
}

function assertSecureCredentialFile(filePath: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Native IPC credential must be a regular file');
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Native IPC credential must be owned by the current user');
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('Native IPC credential permissions must be 0600');
    }
  }
}

function parseCredential(raw: string): StoredBridgeCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Native IPC credential is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Native IPC credential is invalid');
  }
  const credential = parsed as Partial<StoredBridgeCredential>;
  if (
    credential.version !== AUTH_FILE_VERSION ||
    typeof credential.token !== 'string' ||
    !TOKEN_PATTERN.test(credential.token)
  ) {
    throw new Error('Native IPC credential is invalid');
  }
  return credential as StoredBridgeCredential;
}

export function getNativeIpcCredentialPath(
  socketPath = getNativeSocketPath(),
  authDir = getDefaultAuthDir(),
): string {
  const socketIdentity = createHash('sha256').update(socketPath).digest('hex').slice(0, 32);
  return path.join(authDir, `bridge-${socketIdentity}.json`);
}

export function createNativeIpcCredential(
  socketPath = getNativeSocketPath(),
  authDir = getDefaultAuthDir(),
): NativeIpcCredential {
  assertSecureDirectory(authDir);
  const filePath = getNativeIpcCredentialPath(socketPath, authDir);
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const payload = JSON.stringify({ version: AUTH_FILE_VERSION, token });
  const tempPath = path.join(authDir, `.bridge-credential-${process.pid}-${randomUUID()}.tmp`);

  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, payload, { encoding: 'utf8' });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tempPath, 0o600);
    try {
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (process.platform !== 'win32' || (code !== 'EEXIST' && code !== 'EPERM')) {
        throw error;
      }
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
    }
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    fs.rmSync(tempPath, { force: true });
  }

  return { filePath, token };
}

export function readNativeIpcCredential(
  socketPath = getNativeSocketPath(),
  authDir = getDefaultAuthDir(),
): NativeIpcCredential {
  assertSecureDirectory(authDir);
  const filePath = getNativeIpcCredentialPath(socketPath, authDir);
  assertSecureCredentialFile(filePath);
  const credential = parseCredential(fs.readFileSync(filePath, 'utf8'));
  return { filePath, token: credential.token };
}

export function removeNativeIpcCredential(credential: NativeIpcCredential): void {
  try {
    const current = readNativeIpcCredentialForPath(credential.filePath);
    if (constantTimeTokenEquals(current.token, credential.token)) {
      fs.rmSync(credential.filePath, { force: true });
    }
  } catch {
    // The file is already gone, invalid, or belongs to a newer native host process.
  }
}

function readNativeIpcCredentialForPath(filePath: string): StoredBridgeCredential {
  assertSecureCredentialFile(filePath);
  return parseCredential(fs.readFileSync(filePath, 'utf8'));
}

export function constantTimeTokenEquals(received: unknown, expected: string): boolean {
  if (typeof received !== 'string' || !TOKEN_PATTERN.test(received)) {
    return false;
  }
  const receivedBuffer = Buffer.from(received, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}
