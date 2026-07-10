import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  removePrivateTempAttachment,
  writePrivateTempAttachment,
} from './private-temp-attachment';

const pathsToRemove: string[] = [];

afterEach(async () => {
  await Promise.all(
    pathsToRemove.splice(0).map((filePath) =>
      fs.rm(path.dirname(filePath), { recursive: true, force: true }),
    ),
  );
});

function attachment(name = 'same-name.png') {
  return {
    type: 'image' as const,
    name,
    mimeType: 'image/png',
    dataBase64: Buffer.from('private-image').toString('base64'),
  };
}

describe('private engine attachment files', () => {
  it('uses unpredictable private directories and client-independent filenames', async () => {
    const [first, second] = await Promise.all([
      writePrivateTempAttachment(attachment('../../escape.png')),
      writePrivateTempAttachment(attachment('../../escape.png')),
    ]);
    pathsToRemove.push(first, second);

    expect(first).not.toBe(second);
    expect(path.dirname(first)).not.toBe(path.dirname(second));
    expect(path.basename(first)).not.toContain('escape');
    expect(await fs.readFile(first, 'utf8')).toBe('private-image');
    expect(await fs.readFile(second, 'utf8')).toBe('private-image');

    if (process.platform !== 'win32') {
      expect((await fs.stat(path.dirname(first))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(first)).mode & 0o777).toBe(0o600);
    }
  });

  it('removes the owned directory and refuses unrelated paths', async () => {
    const filePath = await writePrivateTempAttachment(attachment());
    const directory = path.dirname(filePath);

    await removePrivateTempAttachment(filePath);

    await expect(fs.access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removePrivateTempAttachment('/tmp/unowned/file.png')).rejects.toThrow(
      'unowned',
    );
  });

  it('validates attachment bytes before creating a temporary directory', async () => {
    await expect(
      writePrivateTempAttachment({
        ...attachment(),
        dataBase64: 'not-base64',
      }),
    ).rejects.toThrow('invalid base64');
  });
});
