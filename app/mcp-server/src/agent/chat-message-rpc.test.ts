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
    { createSession, getSessionsByProject },
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

  return {
    upsertProject,
    createSession,
    getSessionsByProject,
    createMessage,
    getMessagesByProjectId,
    dispatchAgentRpc,
    closeDb,
  };
}

function createRpcDeps(): { chatService: AgentChatService } {
  return {
    chatService: {
      getEngineInfos: () => [],
      cancelSessionExecutions: () => 0,
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

describe('agent.sessions.history', () => {
  it('filters out messages whose project does not match the resolved session', async () => {
    const workspaceBase = await createTempDir('session-history-workspace-');
    const dataDir = await createTempDir('session-history-data-');
    const dbFile = path.join(dataDir, 'agent.db');
    const projectRootA = path.join(workspaceBase, 'history-project-a');
    const projectRootB = path.join(workspaceBase, 'history-project-b');
    await fs.mkdir(projectRootA, { recursive: true });
    await fs.mkdir(projectRootB, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, createSession, createMessage, dispatchAgentRpc } = await loadAgentModules();

    const projectA = await upsertProject({
      name: 'History Project A',
      rootPath: projectRootA,
      allowCreate: true,
    });
    const projectB = await upsertProject({
      name: 'History Project B',
      rootPath: projectRootB,
      allowCreate: true,
    });
    const session = await createSession(projectA.id, 'codex' as any);

    await createMessage({
      projectId: projectA.id,
      sessionId: session.id,
      role: 'user',
      messageType: 'chat',
      content: 'expected session history message',
    });
    await createMessage({
      projectId: projectB.id,
      sessionId: session.id,
      role: 'assistant',
      messageType: 'chat',
      content: 'cross-project leaked message',
    });

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.sessions.history',
        params: { sessionId: session.id },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json?.messages).toHaveLength(1);
    expect(response.json?.messages?.[0]?.content).toBe('expected session history message');
    expect(response.json?.totalCount).toBe(1);
  });
});

describe('agent.chat.act', () => {
  it('returns 409 when a requestId is already active for the same session', async () => {
    const workspaceBase = await createTempDir('act-request-conflict-workspace-');
    const dataDir = await createTempDir('act-request-conflict-data-');
    const dbFile = path.join(dataDir, 'agent.db');
    const projectRoot = path.join(workspaceBase, 'project-root');
    await fs.mkdir(projectRoot, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, createSession, dispatchAgentRpc } = await loadAgentModules();

    const project = await upsertProject({
      name: 'Act Conflict Project',
      rootPath: projectRoot,
      allowCreate: true,
    });
    const session = await createSession(project.id, 'codex' as any);

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.chat.act',
        params: { sessionId: session.id },
        body: {
          instruction: 'hello',
          requestId: 'duplicate-request',
        },
      },
      {
        chatService: {
          getEngineInfos: () => [],
          handleAct: vi.fn().mockRejectedValue(new Error('requestId is already active for this session')),
        } as unknown as AgentChatService,
      },
    );

    expect(response.statusCode).toBe(409);
    expect(response.json).toEqual({
      error: 'requestId is already active for this session',
    });
  });
});

describe('project-scoped chat message RPCs', () => {
  it('returns Project not found consistently for list/create/delete', async () => {
    const workspaceBase = await createTempDir('missing-project-workspace-');
    const dataDir = await createTempDir('missing-project-data-');
    const dbFile = path.join(dataDir, 'agent.db');

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { dispatchAgentRpc } = await loadAgentModules();
    const missingProjectId = 'missing-project';

    const [listResponse, createResponse, deleteResponse] = await Promise.all([
      dispatchAgentRpc(
        {
          operation: 'agent.chat.messages.list',
          params: { projectId: missingProjectId },
        },
        createRpcDeps(),
      ),
      dispatchAgentRpc(
        {
          operation: 'agent.chat.messages.create',
          params: { projectId: missingProjectId },
          body: { content: 'hello' },
        },
        createRpcDeps(),
      ),
      dispatchAgentRpc(
        {
          operation: 'agent.chat.messages.delete',
          params: { projectId: missingProjectId },
        },
        createRpcDeps(),
      ),
    ]);

    expect(listResponse.statusCode).toBe(404);
    expect(listResponse.json).toEqual({ error: 'Project not found' });

    expect(createResponse.statusCode).toBe(404);
    expect(createResponse.json).toEqual({ error: 'Project not found' });

    expect(deleteResponse.statusCode).toBe(404);
    expect(deleteResponse.json).toEqual({ error: 'Project not found' });
  });

  it('sanitizes non-public web editor page urls in stored messages', async () => {
    const workspaceBase = await createTempDir('message-sanitize-workspace-');
    const dataDir = await createTempDir('message-sanitize-data-');
    const dbFile = path.join(dataDir, 'agent.db');
    const projectRoot = path.join(workspaceBase, 'message-sanitize-project');
    await fs.mkdir(projectRoot, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, createSession, createMessage, dispatchAgentRpc } = await loadAgentModules();

    const project = await upsertProject({
      name: 'Message Sanitize Project',
      rootPath: projectRoot,
      allowCreate: true,
    });
    const session = await createSession(project.id, 'codex' as any);

    await createMessage({
      projectId: project.id,
      sessionId: session.id,
      role: 'user',
      messageType: 'chat',
      content: 'Goal: apply the browser edit\n\nPage URL: file:///tmp/secret.txt\n\nContinue.',
      metadata: {
        clientMeta: {
          kind: 'web_editor_apply_single',
          pageUrl: 'file:///tmp/secret.txt',
          elementCount: 1,
        },
        displayText: 'Apply change',
      },
    });

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.chat.messages.list',
        params: { projectId: project.id },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json?.data).toHaveLength(1);
    expect(response.json?.data?.[0]?.content).toContain('Page URL: [redacted non-public page]');
    expect(response.json?.data?.[0]?.content).not.toContain('file:///tmp/secret.txt');
    expect(response.json?.data?.[0]?.metadata?.clientMeta).toEqual({
      kind: 'web_editor_apply_single',
      pageUrl: null,
      pageUrlRedacted: true,
      elementCount: 1,
    });
  });
});

describe('agent.sessions.delete', () => {
  it('removes persisted session messages when deleting the session', async () => {
    const workspaceBase = await createTempDir('session-delete-workspace-');
    const dataDir = await createTempDir('session-delete-data-');
    const dbFile = path.join(dataDir, 'agent.db');
    const projectRoot = path.join(workspaceBase, 'delete-project');
    await fs.mkdir(projectRoot, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, createSession, createMessage, getMessagesByProjectId, dispatchAgentRpc } =
      await loadAgentModules();

    const project = await upsertProject({
      name: 'Session Delete Cleanup',
      rootPath: projectRoot,
      allowCreate: true,
    });
    const session = await createSession(project.id, 'codex' as any);

    await createMessage({
      projectId: project.id,
      sessionId: session.id,
      role: 'user',
      messageType: 'chat',
      content: 'message that should be deleted with the session',
    });

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.sessions.delete',
        params: { sessionId: session.id },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(204);
    expect(await getMessagesByProjectId(project.id)).toHaveLength(0);
  });

  it('cancels running executions before deleting the session', async () => {
    const workspaceBase = await createTempDir('session-delete-cancel-workspace-');
    const dataDir = await createTempDir('session-delete-cancel-data-');
    const dbFile = path.join(dataDir, 'agent.db');
    const projectRoot = path.join(workspaceBase, 'delete-cancel-project');
    await fs.mkdir(projectRoot, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, createSession, dispatchAgentRpc } = await loadAgentModules();

    const project = await upsertProject({
      name: 'Session Delete Cancel',
      rootPath: projectRoot,
      allowCreate: true,
    });
    const session = await createSession(project.id, 'codex' as any);
    const cancelSessionExecutions = vi.fn().mockReturnValue(1);

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.sessions.delete',
        params: { sessionId: session.id },
      },
      {
        chatService: {
          getEngineInfos: () => [],
          cancelSessionExecutions,
        } as unknown as AgentChatService,
      },
    );

    expect(response.statusCode).toBe(204);
    expect(cancelSessionExecutions).toHaveBeenCalledWith(session.id);
  });

  it('returns Session not found when deleting a missing session', async () => {
    const workspaceBase = await createTempDir('session-delete-missing-workspace-');
    const dataDir = await createTempDir('session-delete-missing-data-');
    const dbFile = path.join(dataDir, 'agent.db');
    const projectRoot = path.join(workspaceBase, 'delete-missing-project');
    await fs.mkdir(projectRoot, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { dispatchAgentRpc } = await loadAgentModules();

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.sessions.delete',
        params: { sessionId: 'missing-session-id' },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(404);
    expect(response.json).toEqual({ error: 'Session not found' });
  });
});

describe('agent.projects.sessions.list', () => {
  it('returns Project not found when listing sessions for a missing project', async () => {
    const workspaceBase = await createTempDir('project-sessions-list-workspace-');
    const dataDir = await createTempDir('project-sessions-list-data-');
    const dbFile = path.join(dataDir, 'agent.db');

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { dispatchAgentRpc } = await loadAgentModules();

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.list',
        params: { projectId: 'missing-project-id' },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(404);
    expect(response.json).toEqual({ error: 'Project not found' });
  });

  it('redacts non-public web editor preview metadata', async () => {
    const workspaceBase = await createTempDir('project-sessions-preview-workspace-');
    const dataDir = await createTempDir('project-sessions-preview-data-');
    const dbFile = path.join(dataDir, 'agent.db');
    const projectRoot = path.join(workspaceBase, 'preview-project');
    await fs.mkdir(projectRoot, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, createSession, createMessage, dispatchAgentRpc } = await loadAgentModules();

    const project = await upsertProject({
      name: 'Session Preview Redaction Project',
      rootPath: projectRoot,
      allowCreate: true,
    });
    const session = await createSession(project.id, 'codex' as any);

    await createMessage({
      projectId: project.id,
      sessionId: session.id,
      role: 'user',
      messageType: 'chat',
      content: 'Goal: apply the browser edit\n\nPage URL: file:///tmp/private.html\n\nContinue.',
      metadata: {
        clientMeta: {
          kind: 'web_editor_apply_batch',
          pageUrl: 'file:///tmp/private.html',
          elementCount: 2,
          elementLabels: ['Headline', 'CTA'],
        },
        displayText: 'Apply 2 changes',
      },
    });

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.list',
        params: { projectId: project.id },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json?.sessions).toHaveLength(1);
    expect(response.json?.sessions?.[0]?.previewMeta?.displayText).toBe('Apply 2 changes');
    expect(response.json?.sessions?.[0]?.previewMeta?.clientMeta).toEqual({
      kind: 'web_editor_apply_batch',
      pageUrl: null,
      pageUrlRedacted: true,
      elementCount: 2,
      elementLabels: ['Headline', 'CTA'],
    });
    expect(response.json?.sessions?.[0]?.previewMeta?.fullContent).toContain(
      'Page URL: [redacted non-public page]',
    );
    expect(response.json?.sessions?.[0]?.previewMeta?.fullContent).not.toContain(
      'file:///tmp/private.html',
    );
  });
});

describe('session-scoped message boundaries', () => {
  it('builds session previews from messages that belong to the owning project', async () => {
    const workspaceBase = await createTempDir('session-preview-workspace-');
    const dataDir = await createTempDir('session-preview-data-');
    const dbFile = path.join(dataDir, 'agent.db');
    const projectRootA = path.join(workspaceBase, 'preview-project-a');
    const projectRootB = path.join(workspaceBase, 'preview-project-b');
    await fs.mkdir(projectRootA, { recursive: true });
    await fs.mkdir(projectRootB, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, createSession, getSessionsByProject, createMessage } =
      await loadAgentModules();

    const projectA = await upsertProject({
      name: 'Preview Project A',
      rootPath: projectRootA,
      allowCreate: true,
    });
    const projectB = await upsertProject({
      name: 'Preview Project B',
      rootPath: projectRootB,
      allowCreate: true,
    });
    const session = await createSession(projectA.id, 'codex' as any);

    await createMessage({
      projectId: projectB.id,
      sessionId: session.id,
      role: 'user',
      messageType: 'chat',
      content: 'foreign preview text',
    });
    await createMessage({
      projectId: projectA.id,
      sessionId: session.id,
      role: 'user',
      messageType: 'chat',
      content: 'owning project preview text',
    });

    const sessions = await getSessionsByProject(projectA.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.preview).toBe('owning project preview text');
  });

  it('resets only messages that belong to the owning project', async () => {
    const workspaceBase = await createTempDir('session-reset-workspace-');
    const dataDir = await createTempDir('session-reset-data-');
    const dbFile = path.join(dataDir, 'agent.db');
    const projectRootA = path.join(workspaceBase, 'reset-project-a');
    const projectRootB = path.join(workspaceBase, 'reset-project-b');
    await fs.mkdir(projectRootA, { recursive: true });
    await fs.mkdir(projectRootB, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, createSession, createMessage, getMessagesByProjectId, dispatchAgentRpc } =
      await loadAgentModules();

    const projectA = await upsertProject({
      name: 'Reset Project A',
      rootPath: projectRootA,
      allowCreate: true,
    });
    const projectB = await upsertProject({
      name: 'Reset Project B',
      rootPath: projectRootB,
      allowCreate: true,
    });
    const session = await createSession(projectA.id, 'codex' as any);

    await createMessage({
      projectId: projectA.id,
      sessionId: session.id,
      role: 'user',
      messageType: 'chat',
      content: 'message owned by project A',
    });
    await createMessage({
      projectId: projectB.id,
      sessionId: session.id,
      role: 'assistant',
      messageType: 'chat',
      content: 'dirty foreign message',
    });

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.sessions.reset',
        params: { sessionId: session.id },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json?.deletedMessages).toBe(1);
    expect(await getMessagesByProjectId(projectA.id)).toHaveLength(0);
    expect(await getMessagesByProjectId(projectB.id)).toHaveLength(1);
  });
});
