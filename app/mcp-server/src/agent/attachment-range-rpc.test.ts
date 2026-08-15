import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  AGENT_ATTACHMENT_RPC_CHUNK_BYTES,
} from 'webpage-mcp-shared';
import type { AgentChatService } from './chat-service';

const originalAllowedWorkspaceBase = process.env.MCP_ALLOWED_WORKSPACE_BASE;
const originalAgentDataDir = process.env.WEBPAGE_MCP_AGENT_DATA_DIR;
const originalAgentDbFile = process.env.WEBPAGE_MCP_AGENT_DB_FILE;
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createRpcDeps(): { chatService: AgentChatService } {
  return {
    chatService: {
      getEngineInfos: () => [],
    } as AgentChatService,
  };
}

async function setupProject(name: string) {
  const workspaceBase = await createTempDir('attachment-range-workspace-');
  const dataDir = await createTempDir('attachment-range-data-');
  const projectRoot = path.join(workspaceBase, 'project-root');
  await fs.mkdir(projectRoot, { recursive: true });

  process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = path.join(dataDir, 'agent.db');

  vi.resetModules();
  const [{ upsertProject }, { attachmentService }, { dispatchAgentRpc }] = await Promise.all([
    import('./project-service'),
    import('./attachment-service'),
    import('./rpc-dispatcher'),
  ]);
  const project = await upsertProject({
    name,
    rootPath: projectRoot,
    allowCreate: true,
  });
  return { project, attachmentService, dispatchAgentRpc };
}

afterEach(async () => {
  try {
    const { closeDb } = await import('./db/client');
    closeDb();
  } catch {
    // Ignore cleanup failures when the DB module was not initialized.
  }

  process.env.MCP_ALLOWED_WORKSPACE_BASE = originalAllowedWorkspaceBase;
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = originalAgentDataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = originalAgentDbFile;
  vi.resetModules();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('attachment ranged RPC transport', () => {
  it('keeps small responses compatible with one-shot reads', async () => {
    const { project, attachmentService, dispatchAgentRpc } = await setupProject(
      'Inline Attachment',
    );
    const contents = Buffer.from('small-inline-image');
    const saved = await attachmentService.saveAttachment({
      projectId: project.id,
      messageId: 'msg-inline',
      index: 0,
      attachment: {
        type: 'image',
        name: 'inline.png',
        mimeType: 'image/png',
        dataBase64: contents.toString('base64'),
      },
    });

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.attachments.get',
        params: { projectId: project.id, filename: saved.filename },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-length']).toBe(String(contents.length));
    expect(Buffer.from(response.base64Body || '', 'base64')).toEqual(contents);
  });

  it('transfers large attachments in bounded, contiguous ranges', async () => {
    const { project, attachmentService, dispatchAgentRpc } = await setupProject(
      'Ranged Attachment',
    );
    const contents = Buffer.alloc(AGENT_ATTACHMENT_RPC_CHUNK_BYTES * 2 + 37);
    for (let index = 0; index < contents.length; index += 1) {
      contents[index] = index % 251;
    }
    const saved = await attachmentService.saveAttachment({
      projectId: project.id,
      messageId: 'msg-range',
      index: 0,
      attachment: {
        type: 'image',
        name: 'range.png',
        mimeType: 'image/png',
        dataBase64: contents.toString('base64'),
      },
    });

    const legacyResponse = await dispatchAgentRpc(
      {
        operation: 'agent.attachments.get',
        params: { projectId: project.id, filename: saved.filename },
      },
      createRpcDeps(),
    );
    expect(legacyResponse.statusCode).toBe(413);
    expect(legacyResponse.json).toMatchObject({ code: 'ATTACHMENT_RANGE_REQUIRED' });

    const received: Buffer[] = [];
    let offset = 0;
    while (offset < contents.length) {
      const response = await dispatchAgentRpc(
        {
          operation: 'agent.attachments.get',
          params: { projectId: project.id, filename: saved.filename },
          query: { offset, limit: AGENT_ATTACHMENT_RPC_CHUNK_BYTES * 2 },
        },
        createRpcDeps(),
      );
      const chunk = Buffer.from(response.base64Body || '', 'base64');
      expect(response.statusCode).toBe(206);
      expect(chunk.length).toBeLessThanOrEqual(AGENT_ATTACHMENT_RPC_CHUNK_BYTES);
      expect(response.headers['content-range']).toBe(
        `bytes ${offset}-${offset + chunk.length - 1}/${contents.length}`,
      );
      received.push(chunk);
      offset += chunk.length;
    }
    expect(Buffer.concat(received)).toEqual(contents);

    const outOfRange = await dispatchAgentRpc(
      {
        operation: 'agent.attachments.get',
        params: { projectId: project.id, filename: saved.filename },
        query: { offset: contents.length, limit: 1 },
      },
      createRpcDeps(),
    );
    expect(outOfRange.statusCode).toBe(416);
    expect(outOfRange.headers['content-range']).toBe(`bytes */${contents.length}`);
  }, 30_000);

  it('rejects invalid ranges and oversized files before allocating a content buffer', async () => {
    const { project, attachmentService, dispatchAgentRpc } = await setupProject(
      'Invalid Attachment Range',
    );
    const filename = 'oversized.png';
    const attachmentPath = attachmentService.getAttachmentPath(project.id, filename);
    await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
    await fs.writeFile(attachmentPath, Buffer.alloc(0));
    await fs.truncate(attachmentPath, AGENT_ATTACHMENT_MAX_BYTES + 1);

    for (const query of [
      { offset: 0 },
      { offset: -1, limit: 1 },
      { offset: 0.5, limit: 1 },
      { offset: 0, limit: 0 },
    ]) {
      const response = await dispatchAgentRpc(
        {
          operation: 'agent.attachments.get',
          params: { projectId: project.id, filename },
          query,
        },
        createRpcDeps(),
      );
      expect(response.statusCode).toBe(400);
    }

    const oversized = await dispatchAgentRpc(
      {
        operation: 'agent.attachments.get',
        params: { projectId: project.id, filename },
        query: { offset: 0, limit: AGENT_ATTACHMENT_RPC_CHUNK_BYTES },
      },
      createRpcDeps(),
    );
    expect(oversized.statusCode).toBe(413);
    expect(oversized.base64Body).toBeNull();
    expect(oversized.json).toMatchObject({
      code: 'ATTACHMENT_TOO_LARGE',
      totalBytes: AGENT_ATTACHMENT_MAX_BYTES + 1,
    });
  });
});
