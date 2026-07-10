import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileHandler } from './file-handler';

function createTestHandler(): { handler: FileHandler; tempDir: string } {
  const handler = trackHandler(new FileHandler());
  const tempDir = handler.getTempDir();
  return { handler, tempDir };
}

const dirsToCleanup: string[] = [];
const handlersToDispose: FileHandler[] = [];

function trackHandler(handler: FileHandler): FileHandler {
  handlersToDispose.push(handler);
  return handler;
}

afterEach(() => {
  while (handlersToDispose.length > 0) {
    handlersToDispose.pop()?.dispose();
  }
  while (dirsToCleanup.length > 0) {
    const dir = dirsToCleanup.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('FileHandler temp file safety', () => {
  it('bounds native file-operation routing fields before dispatch', async () => {
    const { handler } = createTestHandler();

    await expect(
      handler.handleFileRequest({ action: 'x'.repeat(65) }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('action') });
    await expect(
      handler.handleFileRequest({ action: 'cleanupFile', filePath: 'x'.repeat(4097) }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('filePath') });
    await expect(
      handler.handleFileRequest({
        action: 'analyzeTrace',
        traceFilePath: '/tmp/trace.json',
        insightName: '界'.repeat(100),
      }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('insightName') });
  });

  it('enforces single-file bytes before writing', async () => {
    const handler = trackHandler(
      new FileHandler(os.tmpdir(), {
        maxFileBytes: 4,
        maxTotalBytes: 8,
      }),
    );

    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('12345').toString('base64'),
      fileName: 'oversized.txt',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('File exceeds the 4 byte limit');
    expect(fs.readdirSync(handler.getTempDir())).toEqual([]);
  });

  it('enforces temporary file count and total-byte quotas', async () => {
    const countLimited = trackHandler(
      new FileHandler(os.tmpdir(), {
        maxFileBytes: 4,
        maxFiles: 1,
        maxTotalBytes: 8,
      }),
    );
    const totalLimited = trackHandler(
      new FileHandler(os.tmpdir(), {
        maxFileBytes: 4,
        maxFiles: 3,
        maxTotalBytes: 5,
      }),
    );

    await countLimited.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('a').toString('base64'),
      fileName: 'first.txt',
    });
    const countResult = await countLimited.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('b').toString('base64'),
      fileName: 'second.txt',
    });

    await totalLimited.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('1234').toString('base64'),
      fileName: 'first.txt',
    });
    const totalResult = await totalLimited.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('12').toString('base64'),
      fileName: 'second.txt',
    });

    expect(countResult.success).toBe(false);
    expect(countResult.error).toContain('file limit reached (1)');
    expect(totalResult.success).toBe(false);
    expect(totalResult.error).toContain('storage exceeds the 5 byte limit');
  });

  it('releases quota after cleanup and bounds base64 read responses', async () => {
    const handler = trackHandler(
      new FileHandler(os.tmpdir(), {
        maxFileBytes: 8,
        maxFiles: 1,
        maxTotalBytes: 8,
        maxBase64ReadFileBytes: 2,
      }),
    );
    const saved = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('123').toString('base64'),
      fileName: 'first.txt',
    });

    const readResult = await handler.handleFileRequest({
      action: 'readBase64File',
      filePath: saved.filePath,
    });
    await handler.handleFileRequest({ action: 'cleanupFile', filePath: saved.filePath });
    const replacement = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('next').toString('base64'),
      fileName: 'next.txt',
    });

    expect(readResult.success).toBe(false);
    expect(readResult.error).toContain('2 byte base64 response limit');
    expect(replacement.success).toBe(true);
  });

  it('rejects file names that cannot fit in one filesystem component', async () => {
    const { handler } = createTestHandler();
    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('hello').toString('base64'),
      fileName: `${'界'.repeat(100)}.txt`,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('fileName exceeds the 255 byte limit');
  });

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

  it.skipIf(process.platform === 'win32')('creates private directories and files', async () => {
    const { handler, tempDir } = createTestHandler();
    dirsToCleanup.push(tempDir);
    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('private').toString('base64'),
      fileName: 'private.txt',
    });

    expect(fs.statSync(tempDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(result.filePath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('does not follow symlinks inside the temp directory', async () => {
    const { handler, tempDir } = createTestHandler();
    dirsToCleanup.push(tempDir);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpage-mcp-symlink-victim-'));
    dirsToCleanup.push(outsideDir);
    const victim = path.join(outsideDir, 'victim.txt');
    const link = path.join(tempDir, 'linked.txt');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, link);

    const readResult = await handler.handleFileRequest({
      action: 'readBase64File',
      filePath: link,
    });
    const writeResult = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('overwrite').toString('base64'),
      fileName: 'linked.txt',
    });

    expect(readResult.success).toBe(false);
    expect(readResult.error).toContain('Symbolic links are not allowed');
    expect(writeResult.success).toBe(false);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
  });

  it('removes the private directory on disposal', async () => {
    const { handler, tempDir } = createTestHandler();
    await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('cleanup').toString('base64'),
    });

    handler.dispose();

    expect(fs.existsSync(tempDir)).toBe(false);
  });
});
