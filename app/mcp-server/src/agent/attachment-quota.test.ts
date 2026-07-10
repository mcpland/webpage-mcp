import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentService } from './attachment-service';

const originalAgentDataDir = process.env.WEBPAGE_MCP_AGENT_DATA_DIR;
const tempDirs: string[] = [];

async function createService(options: { maxProjectBytes: number; maxProjectFiles: number }) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-quota-'));
  tempDirs.push(dataDir);
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
  return new AttachmentService(options);
}

function attachment(contents: string, name: string) {
  return {
    type: 'image' as const,
    name,
    mimeType: 'image/png',
    dataBase64: Buffer.from(contents).toString('base64'),
  };
}

afterEach(async () => {
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = originalAgentDataDir;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('project attachment quotas', () => {
  it('serializes concurrent writes so the byte quota cannot be raced', async () => {
    const service = await createService({ maxProjectBytes: 5, maxProjectFiles: 10 });

    const results = await Promise.allSettled([
      service.saveAttachment({
        projectId: 'project-1',
        messageId: 'message-1',
        index: 0,
        attachment: attachment('four', 'first.png'),
      }),
      service.saveAttachment({
        projectId: 'project-1',
        messageId: 'message-2',
        index: 0,
        attachment: attachment('four', 'second.png'),
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const stats = await service.getAttachmentStats();
    expect(stats.totalFiles).toBe(1);
    expect(stats.totalBytes).toBe(4);
  });

  it('enforces the per-project file count limit', async () => {
    const service = await createService({ maxProjectBytes: 100, maxProjectFiles: 1 });
    await service.saveAttachment({
      projectId: 'project-1',
      messageId: 'message-1',
      index: 0,
      attachment: attachment('one', 'first.png'),
    });

    await expect(
      service.saveAttachment({
        projectId: 'project-1',
        messageId: 'message-2',
        index: 0,
        attachment: attachment('two', 'second.png'),
      }),
    ).rejects.toThrow('Project attachment file limit (1) reached');
  });
});
