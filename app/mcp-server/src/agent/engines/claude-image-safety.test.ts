import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertClaudeSafeAttachment,
  assertClaudeSafeImagePath,
  detectUnsafeClaudeImageFormat,
  enforceClaudeImageReadSafety,
  enforceClaudeToolResultImageSafety,
} from './claude-image-safety';

const temporaryDirectories: string[] = [];

async function temporaryFile(name: string, bytes: Uint8Array): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-image-safety-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('Claude image decoder boundary', () => {
  it.each([
    ['GIF', Buffer.from('GIF89a', 'ascii')],
    ['TIFF', Buffer.from([0x49, 0x49, 0x2a, 0x00])],
    ['TIFF', Buffer.from([0x4d, 0x4d, 0x00, 0x2b])],
    ['VIPS', Buffer.from([0xb6, 0xa6, 0xf2, 0x08])],
    ['VIPS', Buffer.from([0x08, 0xf2, 0xa6, 0xb6])],
  ] as const)('detects %s by content rather than filename', (format, bytes) => {
    expect(detectUnsafeClaudeImageFormat(bytes)).toBe(format);
  });

  it('allows image formats outside the affected loader set', () => {
    expect(
      detectUnsafeClaudeImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBeUndefined();
  });

  it('rejects unsafe direct attachments before creating a Claude prompt', () => {
    expect(() =>
      assertClaudeSafeAttachment({
        type: 'image',
        name: 'disguised.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('GIF89a', 'ascii').toString('base64'),
      }),
    ).toThrow(/GIF images are temporarily blocked/);
  });

  it('rejects persisted unsafe attachments and unreadable attachment paths', async () => {
    const gif = await temporaryFile('disguised.png', Buffer.from('GIF87a', 'ascii'));
    await expect(assertClaudeSafeImagePath(gif)).rejects.toThrow(/GIF images/);
    await expect(assertClaudeSafeImagePath(`${gif}.missing`)).rejects.toThrow(
      /could not be inspected safely/,
    );
  });

  it('denies built-in Read for unsafe image content, including relative paths', async () => {
    const gif = await temporaryFile('payload.txt', Buffer.from('GIF89a', 'ascii'));
    const result = await enforceClaudeImageReadSafety({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.basename(gif) },
      cwd: path.dirname(gif),
    });
    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
  });

  it('does not interfere with safe files and denies uninspectable Read targets', async () => {
    const png = await temporaryFile(
      'safe.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'read_file',
      tool_input: { path: png },
      cwd: '/',
    };
    await expect(enforceClaudeImageReadSafety(input)).resolves.toEqual({});
    await expect(
      enforceClaudeImageReadSafety({
        ...input,
        tool_input: { file_path: `${png}.missing` },
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
  });

  it('replaces unsafe base64 image tool results before model delivery', async () => {
    const result = await enforceClaudeToolResultImageSafety({
      hook_event_name: 'PostToolUse',
      tool_response: {
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: Buffer.from('GIF89a', 'ascii').toString('base64'),
          },
        ],
      },
    });
    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: { isError: true },
      },
    });
  });

  it('detects unsafe data URLs and allows safe image tool results', async () => {
    await expect(
      enforceClaudeToolResultImageSafety({
        hook_event_name: 'PostToolUse',
        tool_response: {
          type: 'image',
          source: {
            type: 'base64',
            data: `data:image/tiff;base64,${Buffer.from([0x49, 0x49, 0x2a, 0x00]).toString('base64')}`,
          },
        },
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { hookEventName: 'PostToolUse' },
    });

    await expect(
      enforceClaudeToolResultImageSafety({
        hook_event_name: 'PostToolUse',
        tool_response: {
          content: [
            {
              type: 'image',
              data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
                'base64',
              ),
            },
          ],
        },
      }),
    ).resolves.toEqual({});
  });
});
