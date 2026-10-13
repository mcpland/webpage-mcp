import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertClaudeSafeAttachment,
  assertClaudeSafeImagePath,
  detectUnsafeClaudeImageFormat,
  detectUnsafeClaudeImagePayload,
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

describe("bundled libheif admission boundary", () => {
  const containers = [
    "avif",
    "avis",
    "heic",
    "heix",
    "mif1",
    "msf1",
    "zzzz",
  ].map((brand) => {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt32BE(bytes.length);
    bytes.write("ftyp", 4);
    bytes.write(brand, 8);
    bytes.write("avif", 16);
    return [brand, bytes] as const;
  });

  it.each(containers)(
    "blocks %s containers through every image input path",
    async (_brand, bytes) => {
      expect(detectUnsafeClaudeImageFormat(bytes)).toBe("HEIF");
      expect(() =>
        assertClaudeSafeAttachment({
          type: "image",
          name: "disguised.png",
          mimeType: "image/png",
          dataBase64: bytes.toString("base64"),
        }),
      ).toThrow(/HEIF images/);
      const file = await temporaryFile("disguised.png", bytes);
      await expect(assertClaudeSafeImagePath(file)).rejects.toThrow(
        /HEIF images/,
      );
      await expect(
        enforceClaudeImageReadSafety({
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: file },
        }),
      ).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      for (const data of [
        bytes.toString("base64"),
        `data:image/png;base64,${bytes.toString("base64")}`,
      ]) {
        await expect(
          enforceClaudeToolResultImageSafety({
            hook_event_name: "PostToolUse",
            tool_response: { type: "image", source: { type: "base64", data } },
          }),
        ).resolves.toMatchObject({
          hookSpecificOutput: { updatedToolOutput: { isError: true } },
        });
      }
    },
  );

  it("rejects extended-size and truncated ftyp headers without parsing box lengths", () => {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt32BE(1);
    bytes.write("ftyp", 4);
    expect(detectUnsafeClaudeImageFormat(bytes)).toBe("HEIF");
    expect(detectUnsafeClaudeImageFormat(bytes.subarray(0, 8))).toBe("HEIF");
    expect(detectUnsafeClaudeImageFormat(bytes.subarray(0, 7))).toBeUndefined();
  });
});

describe('bundled librsvg admission boundary', () => {
  const svgPayloads = [
    ['plain SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['an XML prolog and comment', Buffer.from('<?xml version="1.0"?>\n<!-- icon -->\n<SVG/>')],
    ['UTF-8 text before the tag', Buffer.from('é中\u{1f600} <Svg>')],
    ['stray continuation bytes', Buffer.concat([Buffer.from([0x89, 0x80]), Buffer.from('<svg>')])],
    ['a gzip stream', Buffer.from([0x1f, 0x8b, 0x08, 0x00])],
  ] as const;

  it.each(svgPayloads)('blocks %s through every image input path', async (_name, bytes) => {
    expect(detectUnsafeClaudeImagePayload(bytes, { complete: true })).toBe('SVG');
    expect(() =>
      assertClaudeSafeAttachment({
        type: 'image',
        name: 'disguised.png',
        mimeType: 'image/png',
        dataBase64: bytes.toString('base64'),
      }),
    ).toThrow(/SVG images/);
    const file = await temporaryFile('disguised.png', bytes);
    await expect(assertClaudeSafeImagePath(file)).rejects.toThrow(/SVG images/);
    for (const data of [
      bytes.toString('base64'),
      `data:image/svg+xml;base64,${bytes.toString('base64')}`,
    ]) {
      await expect(
        enforceClaudeToolResultImageSafety({
          hook_event_name: 'PostToolUse',
          tool_response: { type: 'image', source: { type: 'base64', data } },
        }),
      ).resolves.toMatchObject({
        hookSpecificOutput: { updatedToolOutput: { isError: true } },
      });
    }
  });

  it('stops scanning where libvips stops', () => {
    expect(
      detectUnsafeClaudeImagePayload(Buffer.from('text\0<svg>'), { complete: true }),
    ).toBeUndefined();
    expect(
      detectUnsafeClaudeImagePayload(Buffer.concat([Buffer.from([0xff]), Buffer.from('<svg>')]), {
        complete: true,
      }),
    ).toBeUndefined();
    expect(detectUnsafeClaudeImagePayload(Buffer.from('plain text'), { complete: true })).toBe(
      undefined,
    );
  });

  it('treats text running past an inspected prefix as SVG', () => {
    expect(detectUnsafeClaudeImagePayload(Buffer.from('<?xml version'), { complete: false })).toBe(
      'SVG',
    );
  });

  const webp = Buffer.alloc(16);
  webp.write('RIFF', 0);
  webp.writeUInt32LE(4096, 4);
  webp.write('WEBPVP8 ', 8);

  it.each([
    [
      'PNG',
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52,
      ]),
    ],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])],
    ['WebP', webp],
  ] as const)('keeps %s deliverable from a truncated prefix', async (_name, bytes) => {
    expect(detectUnsafeClaudeImagePayload(bytes, { complete: false })).toBeUndefined();
    await expect(
      enforceClaudeToolResultImageSafety({
        hook_event_name: 'PostToolUse',
        tool_response: {
          content: [
            { type: 'image', data: Buffer.concat([bytes, Buffer.alloc(64, 0x41)]).toString('base64') },
          ],
        },
      }),
    ).resolves.toEqual({});
  });

  it('keeps SVG and HTML sources readable through built-in Read', async () => {
    for (const [name, text] of [
      ['icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ['page.html', '<!doctype html><body><svg></svg></body>'],
    ]) {
      const file = await temporaryFile(name, Buffer.from(text));
      await expect(
        enforceClaudeImageReadSafety({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: file },
        }),
      ).resolves.toEqual({});
    }
  });
});
