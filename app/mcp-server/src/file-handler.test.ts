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
});
