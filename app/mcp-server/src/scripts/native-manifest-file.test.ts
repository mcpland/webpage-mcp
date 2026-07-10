import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSecureTemporaryManifest,
  writeManifestAtomically,
} from './native-manifest-file';

describe('Native Messaging manifest file writes', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it.skipIf(
    process.platform === 'win32',
  )('does not follow a pre-planted fixed-name symlink in the temp directory', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'webpage-mcp-manifest-test-'),
    );
    temporaryDirectories.push(temporaryRoot);
    const victimPath = path.join(temporaryRoot, 'victim.json');
    const legacyFixedPath = path.join(
      temporaryRoot,
      'com.webpagemcp.nativehost.json',
    );
    await fs.writeFile(victimPath, 'do not overwrite');
    await fs.symlink(victimPath, legacyFixedPath);

    const temporaryManifest = createSecureTemporaryManifest(
      '{"safe":true}',
      temporaryRoot,
    );

    expect(temporaryManifest.filePath).not.toBe(legacyFixedPath);
    await expect(fs.readFile(victimPath, 'utf8')).resolves.toBe(
      'do not overwrite',
    );
    await expect(
      fs.readFile(temporaryManifest.filePath, 'utf8'),
    ).resolves.toBe('{"safe":true}');
    if (process.platform !== 'win32') {
      expect((await fs.stat(temporaryManifest.directory)).mode & 0o777).toBe(
        0o700,
      );
      expect((await fs.stat(temporaryManifest.filePath)).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it.skipIf(
    process.platform === 'win32',
  )('atomically replaces a destination symlink instead of following it', async () => {
    const destinationDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'webpage-mcp-manifest-target-test-'),
    );
    temporaryDirectories.push(destinationDirectory);
    const victimPath = path.join(destinationDirectory, 'victim.json');
    const manifestPath = path.join(destinationDirectory, 'manifest.json');
    await fs.writeFile(victimPath, 'do not overwrite');
    await fs.symlink(victimPath, manifestPath);

    writeManifestAtomically(manifestPath, '{"safe":true}');

    expect((await fs.lstat(manifestPath)).isSymbolicLink()).toBe(false);
    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(
      '{"safe":true}',
    );
    await expect(fs.readFile(victimPath, 'utf8')).resolves.toBe(
      'do not overwrite',
    );
    if (process.platform !== 'win32') {
      expect((await fs.stat(manifestPath)).mode & 0o777).toBe(0o644);
    }
  });
});
