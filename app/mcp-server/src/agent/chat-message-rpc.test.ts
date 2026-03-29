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
    { createSession },
    { createMessage, getMessagesByProjectId },
    { dispatchAgentRpc },
    { closeDb },
  ] = await Promise.all([
    import('./project-service'),
    import('./session-service'),
    import('./message-service'),
    import('./rpc-dispatcher'),
    import('./db/client'),
  ]);

  return { upsertProject, createSession, createMessage, getMessagesByProjectId, dispatchAgentRpc, closeDb };
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

  it('rejects session ids that belong to a different project', async () => {
    const workspaceBase = await createTempDir('message-rpc-session-workspace-');
    const dataDir = await createTempDir('message-rpc-session-data-');
    const dbFile = path.join(dataDir, 'agent.db');
    const projectRootA = path.join(workspaceBase, 'project-a');
    const projectRootB = path.join(workspaceBase, 'project-b');
    await fs.mkdir(projectRootA, { recursive: true });
    await fs.mkdir(projectRootB, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, createSession, getMessagesByProjectId, dispatchAgentRpc } =
      await loadAgentModules();

    const projectA = await upsertProject({
      name: 'Project A',
      rootPath: projectRootA,
      allowCreate: true,
    });
    const projectB = await upsertProject({
      name: 'Project B',
      rootPath: projectRootB,
      allowCreate: true,
    });
    const session = await createSession(projectA.id, 'codex' as any);

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.chat.messages.create',
        params: { projectId: projectB.id },
        body: {
          content: 'cross-project injection',
          sessionId: session.id,
        },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json).toEqual({
      success: false,
      error: 'sessionId must belong to the target project',
    });

    const projectBMessages = await getMessagesByProjectId(projectB.id);
    expect(projectBMessages).toHaveLength(0);
  });
});
