import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CLAUDE_PERMISSION_MODE,
  DEFAULT_CODEX_CONFIG,
} from 'webpage-mcp-shared';
import type { AgentChatService } from './chat-service';
import {
  resolveClaudePermissionSettings,
  validateSessionSecurityConfig,
} from './session-security';

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
  const [{ upsertProject }, { dispatchAgentRpc }] = await Promise.all([
    import('./project-service'),
    import('./rpc-dispatcher'),
  ]);
  return { upsertProject, dispatchAgentRpc };
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

async function createTestProject(prefix: string) {
  const workspaceBase = await createTempDir(`${prefix}-workspace-`);
  const dataDir = await createTempDir(`${prefix}-data-`);
  const projectRoot = path.join(workspaceBase, 'project');
  await fs.mkdir(projectRoot, { recursive: true });

  process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = path.join(dataDir, 'agent.db');

  const modules = await loadAgentModules();
  const project = await modules.upsertProject({
    name: 'Session Security Project',
    rootPath: projectRoot,
    allowCreate: true,
  });
  return { ...modules, project };
}

afterEach(async () => {
  try {
    const { closeDb } = await import('./db/client');
    closeDb();
  } catch {
    // The DB may not have been initialized in pure validation tests.
  }

  process.env.MCP_ALLOWED_WORKSPACE_BASE = originalAllowedWorkspaceBase;
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = originalAgentDataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = originalAgentDbFile;
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('safe agent permission defaults', () => {
  it('uses non-bypass defaults for both engines', () => {
    expect(DEFAULT_CLAUDE_PERMISSION_MODE).toBe('acceptEdits');
    expect(DEFAULT_CODEX_CONFIG.sandboxMode).toBe('workspace-write');
    expect(DEFAULT_CODEX_CONFIG.dangerouslyAllowFullAccess).toBe(false);
    expect(resolveClaudePermissionSettings(undefined, undefined)).toEqual({
      permissionMode: 'acceptEdits',
      allowDangerouslySkipPermissions: false,
    });
  });

  it('never infers Claude dangerous permission acknowledgement', () => {
    expect(() => resolveClaudePermissionSettings('bypassPermissions', undefined)).toThrow(
      'requires explicit allowDangerouslySkipPermissions=true',
    );
    expect(() => resolveClaudePermissionSettings('bypassPermissions', false)).toThrow(
      'requires explicit allowDangerouslySkipPermissions=true',
    );
    expect(resolveClaudePermissionSettings('bypassPermissions', true)).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    expect(() => resolveClaudePermissionSettings('acceptEdits', true)).toThrow(
      'only valid with permissionMode "bypassPermissions"',
    );
  });
});

describe('session security validation', () => {
  it('accepts the neutral Codex UI payload but rejects mismatched engine settings', () => {
    expect(
      validateSessionSecurityConfig({
        engineName: 'codex',
        input: {
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
          optionsConfig: { codexConfig: { sandboxMode: 'workspace-write' } },
        },
      }),
    ).toBeUndefined();

    expect(
      validateSessionSecurityConfig({
        engineName: 'codex',
        input: { permissionMode: 'bypassPermissions' },
      }),
    ).toBe('permissionMode must be "default" for codex sessions');
    expect(
      validateSessionSecurityConfig({
        engineName: 'claude',
        input: { optionsConfig: { codexConfig: { sandboxMode: 'workspace-write' } } },
      }),
    ).toBe('optionsConfig.codexConfig is only supported for codex sessions');
    expect(
      validateSessionSecurityConfig({
        engineName: 'codex',
        input: { optionsConfig: { codexConfig: { sandboxMode: 'unrestricted' } } },
      }),
    ).toContain('sandboxMode must be one of');

    expect(
      validateSessionSecurityConfig({
        engineName: 'codex',
        input: { optionsConfig: { codexConfig: { sandboxMode: 'danger-full-access' } } },
      }),
    ).toContain('dangerouslyAllowFullAccess must be true');
    expect(
      validateSessionSecurityConfig({
        engineName: 'codex',
        input: {
          optionsConfig: {
            codexConfig: {
              sandboxMode: 'danger-full-access',
              dangerouslyAllowFullAccess: true,
            },
          },
        },
      }),
    ).toBeUndefined();
    expect(
      validateSessionSecurityConfig({
        engineName: 'codex',
        input: {
          optionsConfig: {
            codexConfig: {
              sandboxMode: 'workspace-write',
              dangerouslyAllowFullAccess: true,
            },
          },
        },
      }),
    ).toContain('dangerouslyAllowFullAccess may only be true');
  });
});

describe('session security RPCs', () => {
  it('creates safe Claude and Codex sessions by default', async () => {
    const { dispatchAgentRpc, project } = await createTestProject('safe-session-create');

    const claudeResponse = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: { engineName: 'claude' },
      },
      createRpcDeps(),
    );
    const codexDefaultResponse = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: { engineName: 'codex' },
      },
      createRpcDeps(),
    );
    const codexResponse = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: {
          engineName: 'codex',
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
          optionsConfig: { codexConfig: { sandboxMode: 'workspace-write' } },
        },
      },
      createRpcDeps(),
    );

    expect(claudeResponse.statusCode).toBe(201);
    expect(claudeResponse.json?.session).toMatchObject({
      engineName: 'claude',
      permissionMode: 'acceptEdits',
      allowDangerouslySkipPermissions: false,
    });
    expect(codexDefaultResponse.statusCode).toBe(201);
    expect(codexDefaultResponse.json?.session).toMatchObject({
      engineName: 'codex',
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    });
    expect(codexResponse.statusCode).toBe(201);
    expect(codexResponse.json?.session).toMatchObject({
      engineName: 'codex',
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      optionsConfig: { codexConfig: { sandboxMode: 'workspace-write' } },
    });
  });

  it('rejects invalid modes and unacknowledged Claude bypass on create', async () => {
    const { dispatchAgentRpc, project } = await createTestProject('safe-session-create-reject');

    const invalidMode = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: { engineName: 'claude', permissionMode: 'unrestricted' },
      },
      createRpcDeps(),
    );
    const missingAcknowledgement = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: { engineName: 'claude', permissionMode: 'bypassPermissions' },
      },
      createRpcDeps(),
    );
    const mismatchedAcknowledgement = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: {
          engineName: 'claude',
          permissionMode: 'acceptEdits',
          allowDangerouslySkipPermissions: true,
        },
      },
      createRpcDeps(),
    );

    expect(invalidMode.statusCode).toBe(400);
    expect(invalidMode.json?.error).toContain('permissionMode must be one of');
    expect(missingAcknowledgement.statusCode).toBe(400);
    expect(missingAcknowledgement.json?.error).toBe(
      'permissionMode "bypassPermissions" requires explicit allowDangerouslySkipPermissions=true',
    );
    expect(mismatchedAcknowledgement.statusCode).toBe(400);
    expect(mismatchedAcknowledgement.json?.error).toBe(
      'allowDangerouslySkipPermissions=true is only valid with permissionMode "bypassPermissions"',
    );
  });

  it('rejects engine-mismatched and invalid Codex configuration on create', async () => {
    const { dispatchAgentRpc, project } = await createTestProject('safe-session-engine-config');

    const codexWithClaudeBypass = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: {
          engineName: 'codex',
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
      },
      createRpcDeps(),
    );
    const claudeWithCodexConfig = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: {
          engineName: 'claude',
          optionsConfig: { codexConfig: { sandboxMode: 'workspace-write' } },
        },
      },
      createRpcDeps(),
    );
    const invalidCodexSandbox = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: {
          engineName: 'codex',
          optionsConfig: { codexConfig: { sandboxMode: 'unrestricted' } },
        },
      },
      createRpcDeps(),
    );
    const unacknowledgedFullAccess = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: {
          engineName: 'codex',
          optionsConfig: { codexConfig: { sandboxMode: 'danger-full-access' } },
        },
      },
      createRpcDeps(),
    );
    const acknowledgedFullAccess = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: {
          engineName: 'codex',
          optionsConfig: {
            codexConfig: {
              sandboxMode: 'danger-full-access',
              dangerouslyAllowFullAccess: true,
            },
          },
        },
      },
      createRpcDeps(),
    );

    expect(codexWithClaudeBypass.statusCode).toBe(400);
    expect(codexWithClaudeBypass.json?.error).toBe(
      'permissionMode must be "default" for codex sessions',
    );
    expect(claudeWithCodexConfig.statusCode).toBe(400);
    expect(claudeWithCodexConfig.json?.error).toBe(
      'optionsConfig.codexConfig is only supported for codex sessions',
    );
    expect(invalidCodexSandbox.statusCode).toBe(400);
    expect(invalidCodexSandbox.json?.error).toContain('sandboxMode must be one of');
    expect(unacknowledgedFullAccess.statusCode).toBe(400);
    expect(unacknowledgedFullAccess.json?.error).toContain(
      'dangerouslyAllowFullAccess must be true',
    );
    expect(acknowledgedFullAccess.statusCode).toBe(201);
    expect(acknowledgedFullAccess.json?.session?.optionsConfig).toEqual({
      codexConfig: {
        sandboxMode: 'danger-full-access',
        dangerouslyAllowFullAccess: true,
      },
    });
  });

  it('requires paired acknowledgement changes when updating Claude bypass mode', async () => {
    const { dispatchAgentRpc, project } = await createTestProject('safe-session-update');
    const created = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: { engineName: 'claude' },
      },
      createRpcDeps(),
    );
    const sessionId = created.json?.session?.id;

    const invalidMode = await dispatchAgentRpc(
      {
        operation: 'agent.sessions.update',
        params: { sessionId },
        body: { permissionMode: 'unrestricted' },
      },
      createRpcDeps(),
    );
    const unacknowledged = await dispatchAgentRpc(
      {
        operation: 'agent.sessions.update',
        params: { sessionId },
        body: { permissionMode: 'bypassPermissions' },
      },
      createRpcDeps(),
    );
    const acknowledged = await dispatchAgentRpc(
      {
        operation: 'agent.sessions.update',
        params: { sessionId },
        body: {
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
      },
      createRpcDeps(),
    );
    const staleAcknowledgement = await dispatchAgentRpc(
      {
        operation: 'agent.sessions.update',
        params: { sessionId },
        body: { permissionMode: 'acceptEdits' },
      },
      createRpcDeps(),
    );
    const safelyDowngraded = await dispatchAgentRpc(
      {
        operation: 'agent.sessions.update',
        params: { sessionId },
        body: {
          permissionMode: 'acceptEdits',
          allowDangerouslySkipPermissions: false,
        },
      },
      createRpcDeps(),
    );

    expect(invalidMode.statusCode).toBe(400);
    expect(invalidMode.json?.error).toContain('permissionMode must be one of');
    expect(unacknowledged.statusCode).toBe(400);
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json?.session).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    expect(staleAcknowledgement.statusCode).toBe(400);
    expect(safelyDowngraded.statusCode).toBe(200);
    expect(safelyDowngraded.json?.session).toMatchObject({
      permissionMode: 'acceptEdits',
      allowDangerouslySkipPermissions: false,
    });
  });
});
