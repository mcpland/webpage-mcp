import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentChatService } from './chat-service';
import {
  CHROME_NATIVE_MESSAGE_MAX_OUTBOUND_BYTES,
  NativeMessageWriter,
} from '../native-message-output';

const originalAllowedWorkspaceBase = process.env.MCP_ALLOWED_WORKSPACE_BASE;
const originalAgentDataDir = process.env.WEBPAGE_MCP_AGENT_DATA_DIR;
const originalAgentDbFile = process.env.WEBPAGE_MCP_AGENT_DB_FILE;
const tempDirs: string[] = [];

class CollectingWritable extends Writable {
  public readonly chunks: Buffer[] = [];
  public _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadAgentModules() {
  vi.resetModules();
  const [db, sessionService, rpcDispatcher] = await Promise.all([
    import('./db'),
    import('./session-service'),
    import('./rpc-dispatcher'),
  ]);
  return { db, sessionService, rpcDispatcher };
}

function createRpcDeps(): { chatService: AgentChatService } {
  return {
    chatService: {
      getEngineInfos: () => [{ name: 'codex' }],
      cancelSessionExecutions: () => 0,
      withSessionLifecycleMutation: async (_sessionId: string, mutation: () => Promise<unknown>) =>
        mutation(),
      withProjectLifecycleMutation: async (
        _projectId: string,
        resolveSessionIds: () => Promise<string[]>,
        mutation: () => Promise<unknown>,
      ) => {
        await resolveSessionIds();
        return mutation();
      },
    } as AgentChatService,
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function expectNativeWriterAccepts(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json: unknown;
  isBinary: boolean;
  base64Body: string | null;
}): Promise<void> {
  const output = new CollectingWritable();
  const writer = new NativeMessageWriter(output);
  await writer.send({
    responseToRequestId: 'agent-rpc-collection-page-test',
    payload: { ok: response.statusCode >= 200 && response.statusCode < 300, ...response },
  });
  expect(output.chunks).toHaveLength(1);
  expect(output.chunks[0].length - 4).toBeLessThanOrEqual(
    CHROME_NATIVE_MESSAGE_MAX_OUTBOUND_BYTES,
  );
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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Agent RPC project and session collection pagination', () => {
  it('reads 500 projects and sessions in complete bounded batches', async () => {
    const workspaceBase = await createTempDir('rpc-collection-workspace-');
    const dataDir = await createTempDir('rpc-collection-data-');
    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = path.join(dataDir, 'agent.db');

    const { db, rpcDispatcher } = await loadAgentModules();
    const database = db.getDb();
    const baseTime = Date.UTC(2026, 0, 1);
    const projectRows = Array.from({ length: 500 }, (_, index) => {
      const timestamp = new Date(baseTime + index).toISOString();
      return {
        id: `project-${String(index).padStart(4, '0')}`,
        name: `Project ${index}`,
        description: null,
        rootPath: path.join(workspaceBase, `project-${index}`),
        preferredCli: 'codex',
        selectedModel: null,
        activeClaudeSessionId: null,
        enableWebpageMcp: '1',
        createdAt: timestamp,
        updatedAt: timestamp,
        lastActiveAt: timestamp,
      };
    });
    const sessionRows = Array.from({ length: 500 }, (_, index) => {
      const timestamp = new Date(baseTime + index).toISOString();
      return {
        id: `session-${String(index).padStart(4, '0')}`,
        projectId: projectRows[0].id,
        engineName: 'codex',
        engineSessionId: null,
        name: `Session ${index}`,
        model: null,
        permissionMode: 'default',
        allowDangerouslySkipPermissions: null,
        systemPromptConfig: null,
        optionsConfig: null,
        managementInfo: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
    for (let offset = 0; offset < 500; offset += 100) {
      await database.insert(db.projects).values(projectRows.slice(offset, offset + 100));
      await database.insert(db.sessions).values(sessionRows.slice(offset, offset + 100));
    }

    const defaultPage = await rpcDispatcher.dispatchAgentRpc(
      { operation: 'agent.projects.list' },
      createRpcDeps(),
    );
    expect(defaultPage.json).toMatchObject({
      totalCount: 500,
      pagination: {
        limit: 50,
        offset: 0,
        count: rpcDispatcher.AGENT_RPC_COLLECTION_PAGE_FETCH_LIMIT,
        hasMore: true,
        nextOffset: rpcDispatcher.AGENT_RPC_COLLECTION_PAGE_FETCH_LIMIT,
      },
    });

    const readAllPages = async (options: {
      operation:
        | 'agent.projects.list'
        | 'agent.sessions.list'
        | 'agent.projects.sessions.list';
      params?: Record<string, string>;
      collection: 'projects' | 'sessions';
    }): Promise<string[]> => {
      const ids: string[] = [];
      let offset = 0;
      for (let pageIndex = 0; pageIndex < 40; pageIndex += 1) {
        const response = await rpcDispatcher.dispatchAgentRpc(
          {
            operation: options.operation,
            params: options.params,
            query: { limit: 500, offset },
          },
          createRpcDeps(),
        );
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe('');
        expect(jsonBytes(response.json)).toBeLessThanOrEqual(
          rpcDispatcher.AGENT_RPC_JSON_RESPONSE_MAX_BYTES,
        );
        const payload = response.json as {
          projects?: Array<{ id: string }>;
          sessions?: Array<{ id: string }>;
          totalCount: number;
          pagination: {
            limit: number;
            count: number;
            hasMore: boolean;
            nextOffset: number | null;
          };
        };
        const pageItems = payload[options.collection] ?? [];
        expect(payload.totalCount).toBe(500);
        expect(payload.pagination.limit).toBe(500);
        expect(payload.pagination.count).toBe(pageItems.length);
        expect(pageItems.length).toBeLessThanOrEqual(
          rpcDispatcher.AGENT_RPC_COLLECTION_PAGE_FETCH_LIMIT,
        );
        if (pageIndex === 0) await expectNativeWriterAccepts(response);
        ids.push(...pageItems.map((item) => item.id));
        if (!payload.pagination.hasMore) {
          expect(payload.pagination.nextOffset).toBeNull();
          return ids;
        }
        expect(pageItems.length).toBeGreaterThan(0);
        expect(payload.pagination.nextOffset).toBe(offset + pageItems.length);
        offset = payload.pagination.nextOffset!;
      }
      throw new Error('Collection pagination did not terminate');
    };

    const expectedProjects = projectRows.map((row) => row.id).reverse();
    const expectedSessions = sessionRows.map((row) => row.id).reverse();
    expect(await readAllPages({ operation: 'agent.projects.list', collection: 'projects' })).toEqual(
      expectedProjects,
    );
    expect(await readAllPages({ operation: 'agent.sessions.list', collection: 'sessions' })).toEqual(
      expectedSessions,
    );
    expect(
      await readAllPages({
        operation: 'agent.projects.sessions.list',
        params: { projectId: projectRows[0].id },
        collection: 'sessions',
      }),
    ).toEqual(expectedSessions);
  });

  it('byte-paginates large public sessions while every page remains native-writable', async () => {
    const workspaceBase = await createTempDir('rpc-large-session-workspace-');
    const dataDir = await createTempDir('rpc-large-session-data-');
    const projectRoot = path.join(workspaceBase, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = path.join(dataDir, 'agent.db');

    const { db, sessionService, rpcDispatcher } = await loadAgentModules();
    const now = new Date().toISOString();
    await db.getDb().insert(db.projects).values({
      id: 'large-session-project',
      name: 'Large sessions',
      rootPath: projectRoot,
      preferredCli: 'codex',
      enableWebpageMcp: '1',
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
    });
    const sessions = await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        sessionService.createSession('large-session-project', 'codex', {
          name: `Large session ${index}`,
          systemPromptConfig: { type: 'custom', text: 'x'.repeat(120 * 1024) },
        }),
      ),
    );
    const listedIds: string[] = [];
    let offset = 0;
    let firstPageCount = 0;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const response = await rpcDispatcher.dispatchAgentRpc(
        { operation: 'agent.sessions.list', query: { limit: 500, offset } },
        createRpcDeps(),
      );
      expect(jsonBytes(response.json)).toBeLessThanOrEqual(
        rpcDispatcher.AGENT_RPC_JSON_RESPONSE_MAX_BYTES,
      );
      await expectNativeWriterAccepts(response);
      const payload = response.json as {
        sessions: Array<{ id: string }>;
        pagination: { hasMore: boolean; nextOffset: number | null };
      };
      if (pageIndex === 0) firstPageCount = payload.sessions.length;
      listedIds.push(...payload.sessions.map((session) => session.id));
      if (!payload.pagination.hasMore) break;
      expect(payload.pagination.nextOffset).toBe(offset + payload.sessions.length);
      offset = payload.pagination.nextOffset!;
    }
    expect(firstPageCount).toBeGreaterThan(0);
    expect(firstPageCount).toBeLessThan(sessions.length);
    expect(listedIds.sort()).toEqual(sessions.map((session) => session.id).sort());
  });
});
