import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  constantTimeTokenEquals,
  createNativeIpcCredential,
  readNativeIpcCredential,
  removeNativeIpcCredential,
} from './bridge-auth';

const tempDirs: string[] = [];

function createTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webpage-mcp-ipc-auth-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('native IPC bridge credentials', () => {
  it('creates a process credential in a private directory and reads it back', () => {
    const root = createTempDir();
    const authDir = path.join(root, 'auth');
    const socketPath = path.join(root, 'native.sock');

    const credential = createNativeIpcCredential(socketPath, authDir);
    const readBack = readNativeIpcCredential(socketPath, authDir);

    expect(readBack).toEqual(credential);
    expect(credential.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32') {
      expect(fs.statSync(authDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(credential.filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects credentials that are readable by another user', () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = createTempDir();
    const authDir = path.join(root, 'auth');
    const socketPath = path.join(root, 'native.sock');
    const credential = createNativeIpcCredential(socketPath, authDir);
    fs.chmodSync(credential.filePath, 0o644);

    expect(() => readNativeIpcCredential(socketPath, authDir)).toThrow(
      'permissions must be 0600',
    );
  });

  it('only removes the credential created by the same native host process', () => {
    const root = createTempDir();
    const authDir = path.join(root, 'auth');
    const socketPath = path.join(root, 'native.sock');
    const oldCredential = createNativeIpcCredential(socketPath, authDir);
    const currentCredential = createNativeIpcCredential(socketPath, authDir);

    removeNativeIpcCredential(oldCredential);
    expect(readNativeIpcCredential(socketPath, authDir)).toEqual(currentCredential);

    removeNativeIpcCredential(currentCredential);
    expect(fs.existsSync(currentCredential.filePath)).toBe(false);
  });

  it('compares only well-formed tokens without timing-sensitive string equality', () => {
    const root = createTempDir();
    const credential = createNativeIpcCredential(
      path.join(root, 'native.sock'),
      path.join(root, 'auth'),
    );

    expect(constantTimeTokenEquals(credential.token, credential.token)).toBe(true);
    expect(constantTimeTokenEquals(`${credential.token.slice(0, -1)}x`, credential.token)).toBe(
      false,
    );
    expect(constantTimeTokenEquals('not-a-token', credential.token)).toBe(false);
  });
});
