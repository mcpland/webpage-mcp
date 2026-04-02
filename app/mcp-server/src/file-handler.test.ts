import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileHandler } from './file-handler';

function createTestHandler(): { handler: FileHandler; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpage-mcp-file-handler-'));
  const handler = new FileHandler();
  (handler as any).tempDir = tempDir;
  return { handler, tempDir };
}

const dirsToCleanup: string[] = [];

afterEach(() => {
  while (dirsToCleanup.length > 0) {
    const dir = dirsToCleanup.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('FileHandler temp file safety', () => {
  it('sanitizes client-provided file names before writing temp files', async () => {
    const { handler, tempDir } = createTestHandler();
    dirsToCleanup.push(tempDir);

    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('hello').toString('base64'),
      fileName: '../../outside.txt',
    });

    expect(result.success).toBe(true);
    expect(result.fileName).toBe('outside.txt');
    expect(result.filePath).toBe(path.join(tempDir, 'outside.txt'));
    expect(fs.readFileSync(result.filePath, 'utf8')).toBe('hello');
  });

  it('replaces invalid filename characters before writing temp files', async () => {
    const { handler, tempDir } = createTestHandler();
    dirsToCleanup.push(tempDir);

    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('hello').toString('base64'),
      fileName: 'bad\u0000name?.txt',
    });

    expect(result.success).toBe(true);
    expect(result.fileName).toBe('bad_name_.txt');
    expect(result.filePath).toBe(path.join(tempDir, 'bad_name_.txt'));
    expect(fs.readFileSync(result.filePath, 'utf8')).toBe('hello');
  });

  it('rejects cleanup paths that escape tempDir via traversal segments', async () => {
    const { handler, tempDir } = createTestHandler();
    dirsToCleanup.push(tempDir);

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpage-mcp-outside-'));
    dirsToCleanup.push(outsideDir);
    const outsideFile = path.join(outsideDir, 'keep.txt');
    fs.writeFileSync(outsideFile, 'keep');

    const deceptivePath = `${tempDir}/../../${path.basename(outsideDir)}/keep.txt`;
    expect(deceptivePath.startsWith(tempDir)).toBe(true);

    const result = await handler.handleFileRequest({
      action: 'cleanupFile',
      filePath: deceptivePath,
    });

    expect(result.success).toBe(false);
    expect(fs.existsSync(outsideFile)).toBe(true);
  });

  it('only reads base64 from files inside tempDir', async () => {
    const { handler, tempDir } = createTestHandler();
    dirsToCleanup.push(tempDir);

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpage-mcp-outside-read-'));
    dirsToCleanup.push(outsideDir);
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret');

    const result = await handler.handleFileRequest({
      action: 'readBase64File',
      filePath: outsideFile,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Can only read files in temp directory');
  });

  it('rejects prepareFile requests that try to verify arbitrary local paths', async () => {
    const { handler, tempDir } = createTestHandler();
    dirsToCleanup.push(tempDir);

    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      filePath: '/etc/hosts',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('base64Data is required');
  });
});
