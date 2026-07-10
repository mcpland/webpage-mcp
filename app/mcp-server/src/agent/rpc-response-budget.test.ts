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
  const [projectService, sessionService, messageService, rpcDispatcher] = await Promise.all([
    import('./project-service'),
    import('./session-service'),
    import('./message-service'),
    import('./rpc-dispatcher'),
  ]);
  return { projectService, sessionService, messageService, rpcDispatcher };
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
    responseToRequestId: 'agent-rpc-response-budget-test',
    payload: {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      ...response,
    },
  });

  expect(output.chunks).toHaveLength(1);
  expect(output.chunks[0].readUInt32LE(0)).toBe(output.chunks[0].length - 4);
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

describe('Agent RPC response encoding', () => {
  it('keeps successful JSON in one field while preserving readable error bodies', async () => {
    const { rpcDispatcher } = await loadAgentModules();

    const success = await rpcDispatcher.dispatchAgentRpc(
      { operation: 'health.ping' },
      createRpcDeps(),
    );
    expect(success.statusCode).toBe(200);
    expect(success.body).toBe('');
    expect(success.json).toEqual({ status: 'ok', message: 'pong' });
    await expectNativeWriterAccepts(success);

    const failure = await rpcDispatcher.dispatchAgentRpc(
      { operation: 'agent.sessions.get', params: {} },
      createRpcDeps(),
    );
    expect(failure.statusCode).toBe(400);
    expect(failure.body).toBe('sessionId is required');
    expect(failure.json).toEqual({ error: 'sessionId is required' });
    await expectNativeWriterAccepts(failure);
  });

  it('paginates escaped message JSON by exact bytes without loss or stalled offsets', async () => {
    const workspaceBase = await createTempDir('rpc-budget-workspace-');
    const dataDir = await createTempDir('rpc-budget-data-');
    const projectRoot = path.join(workspaceBase, 'project');
    await fs.mkdir(projectRoot, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = path.join(dataDir, 'agent.db');

    const { projectService, sessionService, messageService, rpcDispatcher } =
      await loadAgentModules();
    const project = await projectService.upsertProject({
      name: 'RPC response budget',
      rootPath: projectRoot,
      allowCreate: true,
    });
    const session = await sessionService.createSession(project.id, 'codex');
    const escapedContent = '\n'.repeat(100_000);
    expect(jsonBytes(escapedContent)).toBeGreaterThan(Buffer.byteLength(escapedContent, 'utf8'));

    const expectedIds: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const message = await messageService.createMessage({
        projectId: project.id,
        sessionId: session.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        messageType: 'chat',
        content: escapedContent,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
      expectedIds.push(message.id);
    }

    const readAllPages = async (options: {
      operation: 'agent.sessions.history' | 'agent.chat.messages.list';
      params: Record<string, string>;
      collection: 'messages' | 'data';
    }): Promise<{ ids: string[]; firstCount: number }> => {
      const ids: string[] = [];
      let offset = 0;
      let firstCount = 0;

      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
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
        await expectNativeWriterAccepts(response);

        const payload = response.json as {
          messages?: Array<{ id: string }>;
          data?: Array<{ id: string }>;
          totalCount: number;
          pagination: {
            count: number;
            hasMore: boolean;
            nextOffset: number | null;
          };
        };
        const pageMessages = payload[options.collection] ?? [];
        if (pageIndex === 0) firstCount = pageMessages.length;
        expect(payload.totalCount).toBe(expectedIds.length);
        expect(payload.pagination.count).toBe(pageMessages.length);
        ids.push(...pageMessages.map((message) => message.id));

        if (!payload.pagination.hasMore) {
          expect(payload.pagination.nextOffset).toBeNull();
          return { ids, firstCount };
        }

        expect(pageMessages.length).toBeGreaterThan(0);
        expect(payload.pagination.nextOffset).toBe(offset + pageMessages.length);
        expect(payload.pagination.nextOffset).toBeGreaterThan(offset);
        offset = payload.pagination.nextOffset!;
      }

      throw new Error('Message pagination did not terminate');
    };

    const history = await readAllPages({
      operation: 'agent.sessions.history',
      params: { sessionId: session.id },
      collection: 'messages',
    });
    const projectMessages = await readAllPages({
      operation: 'agent.chat.messages.list',
      params: { projectId: project.id },
      collection: 'data',
    });

    expect(history.firstCount).toBeGreaterThan(0);
    expect(history.firstCount).toBeLessThan(expectedIds.length);
    expect(projectMessages.firstCount).toBe(history.firstCount);
    expect([...history.ids].sort()).toEqual([...expectedIds].sort());
    expect([...projectMessages.ids].sort()).toEqual([...expectedIds].sort());
    expect(new Set(history.ids).size).toBe(expectedIds.length);
    expect(new Set(projectMessages.ids).size).toBe(expectedIds.length);
  });
});
