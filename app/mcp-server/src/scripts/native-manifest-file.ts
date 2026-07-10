import fs from 'fs';
import os from 'os';
import path from 'path';

import { HOST_NAME } from './constant';

export interface SecureTemporaryManifest {
  directory: string;
  filePath: string;
}

function writeNewFile(filePath: string, contents: string, mode: number): void {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    mode,
  );
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, mode);
  }
}

/**
 * Creates a private, unpredictable source file for commands that the user will
 * rerun with elevated privileges. The caller owns cleanup after those commands
 * have consumed the file.
 */
export function createSecureTemporaryManifest(
  contents: string,
  temporaryRoot = os.tmpdir(),
): SecureTemporaryManifest {
  const directory = fs.mkdtempSync(
    path.join(temporaryRoot, `${HOST_NAME}-`),
  );
  const filePath = path.join(directory, 'manifest.json');
  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(directory, 0o700);
    }
    writeNewFile(filePath, contents, 0o600);
    return { directory, filePath };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Writes a manifest beside its destination and atomically replaces the old
 * directory entry. A destination symlink is replaced rather than followed.
 */
export function writeManifestAtomically(
  manifestPath: string,
  contents: string,
): void {
  const parentDirectory = path.dirname(manifestPath);
  fs.mkdirSync(parentDirectory, { recursive: true });

  const stagingDirectory = fs.mkdtempSync(
    path.join(parentDirectory, `.${path.basename(manifestPath)}-`),
  );
  const stagingPath = path.join(stagingDirectory, 'manifest.json');

  try {
    writeNewFile(stagingPath, contents, 0o600);
    if (process.platform !== 'win32') {
      fs.chmodSync(stagingPath, 0o644);
    }
    fs.renameSync(stagingPath, manifestPath);
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
