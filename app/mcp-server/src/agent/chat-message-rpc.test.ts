import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

async function loadAgentModules() {
  vi.resetModules();
  const [
    { upsertProject },
    { createMessage, getMessagesByProjectId },
    { dispatchAgentRpc },
    { closeDb },
  ] = await Promise.all([
    import('./project-service'),
    import('./message-service'),
    import('./rpc-dispatcher'),
    import('./db/client'),
  ]);

  return { upsertProject, createMessage, getMessagesByProjectId, dispatchAgentRpc, closeDb };
}

function createRpcDeps(): { chatService: AgentChatService } {
  return {
    chatService: {
      getEngineInfos: () => [],
    } as AgentChatService,
  };
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

describe('agent.chat.messages.create', () => {
  it('rejects caller-specified ids instead of overwriting existing messages', async () => {
    const workspaceBase = await createTempDir('message-rpc-workspace-');
    const dataDir = await createTempDir('message-rpc-data-');
    const dbFile = path.join(dataDir, 'agent.db');
    const projectRoot = path.join(workspaceBase, 'project-root');
    await fs.mkdir(projectRoot, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, createMessage, getMessagesByProjectId, dispatchAgentRpc } =
      await loadAgentModules();

    const project = await upsertProject({
      name: 'Message RPC Guard',
      rootPath: projectRoot,
      allowCreate: true,
    });

    await createMessage({
      id: 'fixed-message-id',
      projectId: project.id,
      role: 'user',
      messageType: 'chat',
      content: 'original content',
    });

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.chat.messages.create',
        params: { projectId: project.id },
        body: {
          id: 'fixed-message-id',
          content: 'attacker overwrite',
        },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json).toEqual({
      success: false,
      error: 'id is not allowed for agent.chat.messages.create',
    });

    const messages = await getMessagesByProjectId(project.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('fixed-message-id');
    expect(messages[0]?.content).toBe('original content');
  });
});
