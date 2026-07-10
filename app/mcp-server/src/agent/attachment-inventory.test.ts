import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_ATTACHMENT_CLEANUP_MAX_PROJECT_IDS,
  AGENT_ATTACHMENT_CLEANUP_MAX_RESULTS,
  AGENT_ATTACHMENT_CLEANUP_PROJECT_IDS_MAX_JSON_BYTES,
  AGENT_ATTACHMENT_STATS_MAX_OFFSET,
  AGENT_IDENTIFIER_MAX_BYTES,
  type AttachmentCleanupResponse,
  type AttachmentStatsResponse,
} from 'webpage-mcp-shared';
import type { AgentChatService } from './chat-service';
import { AttachmentService } from './attachment-service';
import { normalizeAttachmentCleanupRequest } from './attachment-inventory-limits';
import { AGENT_RPC_JSON_RESPONSE_MAX_BYTES } from './rpc-dispatcher';

const originalAgentDataDir = process.env.WEBPAGE_MCP_AGENT_DATA_DIR;
const originalAgentDbFile = process.env.WEBPAGE_MCP_AGENT_DB_FILE;
const originalAllowedWorkspaceBase = process.env.MCP_ALLOWED_WORKSPACE_BASE;
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function createService(
  prefix: string,
  options: ConstructorParameters<typeof AttachmentService>[0] = {},
) {
  const dataDir = await createTempDir(prefix);
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
  const service = new AttachmentService(options);
  return {
    dataDir,
    rootDir: service.getAttachmentsRootDir(),
    service,
  };
}

async function createProjectInventory(
  rootDir: string,
  projectCount: number,
  filesPerProject: number,
): Promise<void> {
  await Promise.all(
    Array.from({ length: projectCount }, async (_, projectIndex) => {
      const projectDir = path.join(rootDir, `project-${projectIndex.toString().padStart(3, '0')}`);
      await fs.mkdir(projectDir, { recursive: true });
      await Promise.all(
        Array.from({ length: filesPerProject }, (_, fileIndex) =>
          fs.writeFile(path.join(projectDir, `file-${fileIndex}.png`), 'data'),
        ),
      );
    }),
  );
}

function createRpcDeps(): { chatService: AgentChatService } {
  return {
    chatService: {
      getEngineInfos: () => [
        { name: 'codex', supportsMcp: false },
        { name: 'claude', supportsMcp: true },
      ],
      cancelSessionExecutions: () => 0,
    } as AgentChatService,
  };
}

async function createRpcRuntime(prefix: string) {
  const workspaceBase = await createTempDir(`${prefix}-workspace-`);
  const dataDir = await createTempDir(`${prefix}-data-`);
  process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = path.join(dataDir, 'agent.db');
  vi.resetModules();
  const [{ dispatchAgentRpc }, { attachmentService }] = await Promise.all([
    import('./rpc-dispatcher'),
    import('./attachment-service'),
  ]);
  return {
    workspaceBase,
    dataDir,
    rootDir: attachmentService.getAttachmentsRootDir(),
    attachmentService,
    dispatchAgentRpc,
  };
}

afterEach(async () => {
  try {
    const { closeDb } = await import('./db/client');
    closeDb();
  } catch {
    // Service-only tests do not initialize the database.
  }
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = originalAgentDataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = originalAgentDbFile;
  process.env.MCP_ALLOWED_WORKSPACE_BASE = originalAllowedWorkspaceBase;
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe('bounded attachment inventory service', () => {
  it('paginates root entries and bounds every per-project file scan', async () => {
    const { rootDir, service } = await createService('attachment-stats-bounds-', {
      maxProjectBytes: 1024,
      maxProjectFiles: 100,
      maxProjectScanEntries: 3,
      maxStatsRootScanEntries: 2,
    });
    await createProjectInventory(rootDir, 5, 5);

    const first = await service.getAttachmentStats({ limit: 100, offset: 0 });
    expect(first.projects).toHaveLength(2);
    expect(first.totalFiles).toBe(6);
    expect(first.totalBytes).toBe(24);
    expect(first.truncatedProjects).toBe(2);
    expect(first.inventoryTruncated).toBe(true);
    expect(first.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileCount: 3,
          scannedEntries: 3,
          inventoryTruncated: true,
        }),
      ]),
    );
    expect(first.pagination).toMatchObject({
      limit: 100,
      offset: 0,
      count: 2,
      hasMore: true,
      nextOffset: 2,
      scannedEntries: 2,
      scanTruncated: true,
    });

    const second = await service.getAttachmentStats({
      limit: 100,
      offset: first.pagination.nextOffset ?? 0,
    });
    expect(second.pagination.offset).toBe(2);
    expect(second.projects).toHaveLength(2);
    expect(second.projects.map((project) => project.projectId)).not.toEqual(
      first.projects.map((project) => project.projectId),
    );
  });

  it('deletes every project sequentially while retaining only bounded results', async () => {
    const { rootDir, service } = await createService('attachment-cleanup-bounds-', {
      maxProjectBytes: 1024,
      maxProjectFiles: 100,
      maxProjectScanEntries: 2,
      maxCleanupResults: 2,
    });
    await createProjectInventory(rootDir, 5, 4);

    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await service.cleanupAttachments(undefined, { continueOnError: true });
    logSpy.mockRestore();

    expect(result).toMatchObject({
      removedFiles: 10,
      removedBytes: 40,
      processedProjects: 5,
      failedProjects: 0,
      skippedProjects: 0,
      countsTruncatedProjects: 5,
      resultCount: 2,
      resultsTruncated: true,
      enumerationTruncated: false,
    });
    expect(result.results).toHaveLength(2);
    expect(result.results.every((entry) => entry.countsTruncated)).toBe(true);
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it('treats an explicitly empty selection as cleanup-none', async () => {
    const { rootDir, service } = await createService('attachment-cleanup-empty-', {
      maxProjectBytes: 1024,
      maxProjectFiles: 10,
    });
    const projectDir = path.join(rootDir, 'keep-project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'keep.png'), 'keep');

    const result = await service.cleanupAttachments({ projectIds: [] });

    expect(result.processedProjects).toBe(0);
    expect(result.results).toEqual([]);
    expect((await fs.stat(projectDir)).isDirectory()).toBe(true);
  });

  it('checks project emptiness without materializing every directory entry', async () => {
    const { rootDir, service } = await createService('attachment-delete-one-', {
      maxProjectBytes: 1024,
      maxProjectFiles: 10,
    });
    const projectDir = path.join(rootDir, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(projectDir, 'target.png'), 'target'),
      fs.writeFile(path.join(projectDir, 'keep.png'), 'keep'),
    ]);
    const readdirSpy = vi.spyOn(fs, 'readdir');

    await service.deleteAttachment('project', 'target.png');

    expect(readdirSpy).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(projectDir, 'keep.png'), 'utf8')).toBe('keep');

    await service.deleteAttachment('project', 'keep.png');
    await expect(fs.stat(projectDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when quota enforcement encounters a truncated inventory', async () => {
    const { rootDir, service } = await createService('attachment-quota-scan-limit-', {
      maxProjectBytes: 1024,
      maxProjectFiles: 100,
      maxProjectScanEntries: 1,
    });
    const projectDir = path.join(rootDir, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(projectDir, 'existing-1.png'), 'one'),
      fs.writeFile(path.join(projectDir, 'existing-2.png'), 'two'),
    ]);

    await expect(
      service.saveAttachment({
        projectId: 'project',
        messageId: 'message',
        index: 0,
        attachment: {
          type: 'image',
          name: 'new.png',
          mimeType: 'image/png',
          dataBase64: Buffer.from('new').toString('base64'),
        },
      }),
    ).rejects.toThrow('inventory exceeds the safe scan limit');
    expect(await fs.readdir(projectDir)).toHaveLength(2);
  });

  it('rejects selected-id count and byte attacks before normalization', () => {
    expect(
      normalizeAttachmentCleanupRequest({
        projectIds: [' project-1 ', 'project-1'],
      }),
    ).toEqual({ selected: true, projectIds: ['project-1'] });

    const tooMany = Array.from(
      { length: AGENT_ATTACHMENT_CLEANUP_MAX_PROJECT_IDS + 1 },
      () => 'p',
    );
    expect(() => normalizeAttachmentCleanupRequest({ projectIds: tooMany })).toThrow(
      expect.objectContaining({
        code: 'AGENT_PAYLOAD_INVALID',
        field: 'projectIds.count',
      }),
    );

    const oversizedIds = Array.from(
      { length: AGENT_ATTACHMENT_CLEANUP_MAX_PROJECT_IDS },
      (_, index) => `${index.toString().padStart(3, '0')}${'a'.repeat(253)}`,
    );
    expect(Buffer.byteLength(JSON.stringify(oversizedIds), 'utf8')).toBeGreaterThan(
      AGENT_ATTACHMENT_CLEANUP_PROJECT_IDS_MAX_JSON_BYTES,
    );
    expect(() =>
      normalizeAttachmentCleanupRequest({ projectIds: oversizedIds }),
    ).toThrow(
      expect.objectContaining({
        code: 'AGENT_PAYLOAD_TOO_LARGE',
        field: 'projectIds',
      }),
    );
    expect(() =>
      normalizeAttachmentCleanupRequest({
        projectIds: ['a'.repeat(AGENT_IDENTIFIER_MAX_BYTES + 1)],
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'AGENT_PAYLOAD_TOO_LARGE',
        field: 'projectIds[0]',
      }),
    );
  });
});

describe('bounded attachment inventory RPCs', () => {
  it('returns byte-bounded stats pages with explicit pagination', async () => {
    const runtime = await createRpcRuntime('attachment-stats-rpc');
    await createProjectInventory(runtime.rootDir, 3, 2);

    const response = await runtime.dispatchAgentRpc(
      {
        operation: 'agent.attachments.stats',
        query: { limit: '2', offset: '0' },
      },
      createRpcDeps(),
    );
    const payload = response.json as AttachmentStatsResponse;

    expect(response.statusCode).toBe(200);
    expect(payload.projects).toHaveLength(2);
    expect(payload.pagination).toMatchObject({
      limit: 2,
      offset: 0,
      count: 2,
      hasMore: true,
      nextOffset: 2,
    });
    expect(payload.inventoryTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(
      AGENT_RPC_JSON_RESPONSE_MAX_BYTES,
    );

    const invalidOffset = await runtime.dispatchAgentRpc(
      {
        operation: 'agent.attachments.stats',
        query: { offset: AGENT_ATTACHMENT_STATS_MAX_OFFSET + 1 },
      },
      createRpcDeps(),
    );
    expect(invalidOffset.statusCode).toBe(400);
    expect(invalidOffset.json).toMatchObject({
      code: 'AGENT_PAYLOAD_INVALID',
      field: 'offset',
    });
  });

  it('rejects malicious selected arrays without touching attachment directories', async () => {
    const runtime = await createRpcRuntime('attachment-cleanup-rpc-limit');
    const keepDir = path.join(runtime.rootDir, 'keep-project');
    await fs.mkdir(keepDir, { recursive: true });
    await fs.writeFile(path.join(keepDir, 'keep.png'), 'keep');
    const projectIds = Array.from(
      { length: AGENT_ATTACHMENT_CLEANUP_MAX_PROJECT_IDS + 1 },
      () => 'keep-project',
    );

    const response = await runtime.dispatchAgentRpc(
      {
        operation: 'agent.attachments.deleteAll',
        body: { projectIds },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json).toMatchObject({
      code: 'AGENT_PAYLOAD_INVALID',
      field: 'projectIds.count',
    });
    const oversizedIds = Array.from(
      { length: AGENT_ATTACHMENT_CLEANUP_MAX_PROJECT_IDS },
      (_, index) => `${index.toString().padStart(3, '0')}${'a'.repeat(253)}`,
    );
    const oversizedResponse = await runtime.dispatchAgentRpc(
      {
        operation: 'agent.attachments.deleteAll',
        body: { projectIds: oversizedIds },
      },
      createRpcDeps(),
    );
    expect(oversizedResponse.statusCode).toBe(413);
    expect(oversizedResponse.json).toMatchObject({
      code: 'AGENT_PAYLOAD_TOO_LARGE',
      field: 'projectIds',
    });
    expect((await fs.stat(keepDir)).isDirectory()).toBe(true);
  });

  it('processes all cleanup directories but caps results and response bytes', async () => {
    const runtime = await createRpcRuntime('attachment-cleanup-rpc-results');
    (
      runtime.attachmentService as unknown as {
        maxProjectScanEntries: number;
      }
    ).maxProjectScanEntries = 1;
    await createProjectInventory(
      runtime.rootDir,
      AGENT_ATTACHMENT_CLEANUP_MAX_RESULTS + 5,
      2,
    );

    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await runtime.dispatchAgentRpc(
      { operation: 'agent.attachments.deleteAll' },
      createRpcDeps(),
    );
    logSpy.mockRestore();
    const payload = response.json as AttachmentCleanupResponse;

    expect(response.statusCode).toBe(200);
    expect(payload.processedProjects).toBe(
      AGENT_ATTACHMENT_CLEANUP_MAX_RESULTS + 5,
    );
    expect(payload.results).toHaveLength(AGENT_ATTACHMENT_CLEANUP_MAX_RESULTS);
    expect(payload.resultCount).toBe(AGENT_ATTACHMENT_CLEANUP_MAX_RESULTS);
    expect(payload.resultsTruncated).toBe(true);
    expect(payload.enumerationTruncated).toBe(false);
    expect(payload.countsTruncatedProjects).toBe(
      AGENT_ATTACHMENT_CLEANUP_MAX_RESULTS + 5,
    );
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(
      AGENT_RPC_JSON_RESPONSE_MAX_BYTES,
    );
    expect(await fs.readdir(runtime.rootDir)).toEqual([]);
  });
});
