import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_CODEX_AUTO_INSTRUCTIONS_MAX_BYTES,
  AGENT_IDENTIFIER_MAX_BYTES,
  AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES,
  AGENT_MODEL_MAX_BYTES,
  AGENT_SESSION_NAME_MAX_BYTES,
  AGENT_SESSION_OPTIONS_MAX_JSON_BYTES,
  AGENT_SYSTEM_PROMPT_TEXT_MAX_BYTES,
  DEFAULT_CODEX_CONFIG,
} from 'webpage-mcp-shared';
import type { AgentChatService } from './chat-service';
import {
  validateSessionCreatePayload,
  validateSessionUpdatePayload,
} from './session-payload-limits';

const originalAllowedWorkspaceBase = process.env.MCP_ALLOWED_WORKSPACE_BASE;
const originalAgentDataDir = process.env.WEBPAGE_MCP_AGENT_DATA_DIR;
const originalAgentDbFile = process.env.WEBPAGE_MCP_AGENT_DB_FILE;
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
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
  vi.resetModules();

  const [{ upsertProject }, sessionService, { dispatchAgentRpc }] =
    await Promise.all([
      import('./project-service'),
      import('./session-service'),
      import('./rpc-dispatcher'),
    ]);
  const project = await upsertProject({
    name: 'Session Payload Limits Project',
    rootPath: projectRoot,
    allowCreate: true,
  });
  return { project, sessionService, dispatchAgentRpc };
}

afterEach(async () => {
  try {
    const { closeDb } = await import('./db/client');
    closeDb();
  } catch {
    // Pure validation tests do not initialize the database.
  }
  process.env.MCP_ALLOWED_WORKSPACE_BASE = originalAllowedWorkspaceBase;
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = originalAgentDataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = originalAgentDbFile;
  vi.resetModules();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('session configuration byte validation', () => {
  it('keeps the default Claude and Codex session configurations valid', () => {
    expect(() =>
      validateSessionCreatePayload('project', 'claude', {}),
    ).not.toThrow();
    expect(() =>
      validateSessionCreatePayload('project', 'codex', {
        optionsConfig: { codexConfig: DEFAULT_CODEX_CONFIG },
      }),
    ).not.toThrow();
  });

  it('accepts exact UTF-8 boundaries and rejects the first byte beyond them', () => {
    const exactName = `${'界'.repeat(Math.floor(AGENT_SESSION_NAME_MAX_BYTES / 3))}${'a'.repeat(
      AGENT_SESSION_NAME_MAX_BYTES % 3,
    )}`;
    expect(Buffer.byteLength(exactName, 'utf8')).toBe(
      AGENT_SESSION_NAME_MAX_BYTES,
    );

    expect(() =>
      validateSessionCreatePayload('project', 'codex', {
        name: exactName,
        model: 'm'.repeat(AGENT_MODEL_MAX_BYTES),
        systemPromptConfig: {
          type: 'custom',
          text: 'p'.repeat(AGENT_SYSTEM_PROMPT_TEXT_MAX_BYTES),
        },
      }),
    ).not.toThrow();

    for (const [field, value, maximumBytes] of [
      ['name', `${exactName}a`, AGENT_SESSION_NAME_MAX_BYTES],
      ['model', 'm'.repeat(AGENT_MODEL_MAX_BYTES + 1), AGENT_MODEL_MAX_BYTES],
    ] as const) {
      expect(() =>
        validateSessionCreatePayload('project', 'codex', { [field]: value }),
      ).toThrow(
        expect.objectContaining({
          code: 'AGENT_PAYLOAD_TOO_LARGE',
          field,
          maximumBytes,
        }),
      );
    }

    expect(() =>
      validateSessionCreatePayload('project', 'codex', {
        systemPromptConfig: {
          type: 'preset',
          preset: 'claude_code',
          append: 'p'.repeat(AGENT_SYSTEM_PROMPT_TEXT_MAX_BYTES + 1),
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'AGENT_PAYLOAD_TOO_LARGE',
        field: 'systemPromptConfig.append',
      }),
    );
  });

  it('uses the actual escaped JSON byte size for final options storage', () => {
    const empty = { mcpServers: { payload: '' } };
    const framingBytes = Buffer.byteLength(JSON.stringify(empty), 'utf8');
    const exactOptions = {
      mcpServers: {
        payload: 'a'.repeat(
          AGENT_SESSION_OPTIONS_MAX_JSON_BYTES - framingBytes,
        ),
      },
    };
    expect(Buffer.byteLength(JSON.stringify(exactOptions), 'utf8')).toBe(
      AGENT_SESSION_OPTIONS_MAX_JSON_BYTES,
    );
    expect(() =>
      validateSessionCreatePayload('project', 'claude', {
        optionsConfig: exactOptions,
      }),
    ).not.toThrow();

    const escapedOptions = {
      mcpServers: {
        payload: '"'.repeat(
          Math.floor(AGENT_SESSION_OPTIONS_MAX_JSON_BYTES / 2),
        ),
      },
    };
    expect(
      Buffer.byteLength(escapedOptions.mcpServers.payload, 'utf8'),
    ).toBeLessThan(AGENT_SESSION_OPTIONS_MAX_JSON_BYTES);
    expect(() =>
      validateSessionCreatePayload('project', 'claude', {
        optionsConfig: escapedOptions,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'AGENT_PAYLOAD_TOO_LARGE',
        field: 'optionsConfig',
        maximumBytes: AGENT_SESSION_OPTIONS_MAX_JSON_BYTES,
      }),
    );
  });

  it('bounds Codex auto instructions and rejects attacker-controlled keys without reflecting them', () => {
    expect(() =>
      validateSessionCreatePayload('project', 'codex', {
        optionsConfig: {
          codexConfig: {
            autoInstructions: 'a'.repeat(
              AGENT_CODEX_AUTO_INSTRUCTIONS_MAX_BYTES,
            ),
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateSessionCreatePayload('project', 'codex', {
        optionsConfig: {
          codexConfig: {
            autoInstructions: 'a'.repeat(
              AGENT_CODEX_AUTO_INSTRUCTIONS_MAX_BYTES + 1,
            ),
          },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'AGENT_PAYLOAD_TOO_LARGE',
        field: 'optionsConfig.codexConfig.autoInstructions',
      }),
    );

    const maliciousOptions = JSON.parse(
      '{"codexConfig":{"__proto__":true}}',
    ) as Record<string, unknown>;
    expect(() =>
      validateSessionCreatePayload('project', 'codex', {
        optionsConfig: maliciousOptions,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'AGENT_PAYLOAD_INVALID',
        field: 'optionsConfig.codexConfig.keys',
      }),
    );
  });

  it('bounds every persisted identifier and internal management JSON', () => {
    expect(() =>
      validateSessionCreatePayload(
        'p'.repeat(AGENT_IDENTIFIER_MAX_BYTES),
        'claude',
        {
          id: 'i'.repeat(AGENT_IDENTIFIER_MAX_BYTES),
          engineSessionId: 'e'.repeat(AGENT_IDENTIFIER_MAX_BYTES),
        },
      ),
    ).not.toThrow();
    expect(() =>
      validateSessionCreatePayload(
        'p'.repeat(AGENT_IDENTIFIER_MAX_BYTES + 1),
        'claude',
        {},
      ),
    ).toThrow(expect.objectContaining({ field: 'projectId' }));
    expect(() =>
      validateSessionUpdatePayload(
        's'.repeat(AGENT_IDENTIFIER_MAX_BYTES + 1),
        {},
      ),
    ).toThrow(expect.objectContaining({ field: 'sessionId' }));

    const managementFramingBytes = Buffer.byteLength(
      JSON.stringify({ tools: [''] }),
      'utf8',
    );
    const exactManagementInfo = {
      tools: [
        'x'.repeat(
          AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES - managementFramingBytes,
        ),
      ],
    };
    expect(Buffer.byteLength(JSON.stringify(exactManagementInfo), 'utf8')).toBe(
      AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES,
    );
    expect(() =>
      validateSessionUpdatePayload('session', {
        managementInfo: exactManagementInfo,
      }),
    ).not.toThrow();
    exactManagementInfo.tools[0] += 'x';
    expect(() =>
      validateSessionUpdatePayload('session', {
        managementInfo: exactManagementInfo,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'AGENT_PAYLOAD_TOO_LARGE',
        field: 'managementInfo',
        maximumBytes: AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES,
      }),
    );
  });
});

describe('session configuration RPC persistence boundaries', () => {
  it('returns structured create errors without inserting a session', async () => {
    const { project, sessionService, dispatchAgentRpc } =
      await createTestProject('session-create-limit');

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: {
          engineName: 'codex',
          name: 'n'.repeat(AGENT_SESSION_NAME_MAX_BYTES + 1),
        },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(413);
    expect(response.json).toMatchObject({
      code: 'AGENT_PAYLOAD_TOO_LARGE',
      field: 'name',
      actualBytes: AGENT_SESSION_NAME_MAX_BYTES + 1,
      maximumBytes: AGENT_SESSION_NAME_MAX_BYTES,
    });
    expect((response.json as { error: string }).error).toContain(
      'name is too large',
    );
    expect(await sessionService.getSessionsByProject(project.id)).toEqual([]);
  });

  it('validates updates before changing any persisted field', async () => {
    const { project, sessionService, dispatchAgentRpc } =
      await createTestProject('session-update-limit');
    const session = await sessionService.createSession(project.id, 'codex', {
      name: 'original',
      optionsConfig: { codexConfig: { maxTurns: 3 } },
    });

    const response = await dispatchAgentRpc(
      {
        operation: 'agent.sessions.update',
        params: { sessionId: session.id },
        body: {
          name: 'must-not-persist',
          optionsConfig: {
            codexConfig: {
              autoInstructions: 'a'.repeat(
                AGENT_CODEX_AUTO_INSTRUCTIONS_MAX_BYTES + 1,
              ),
            },
          },
        },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(413);
    expect(response.json).toMatchObject({
      code: 'AGENT_PAYLOAD_TOO_LARGE',
      field: 'optionsConfig.codexConfig.autoInstructions',
    });
    expect(await sessionService.getSession(session.id)).toMatchObject({
      name: 'original',
      optionsConfig: { codexConfig: { maxTurns: 3 } },
    });
  });

  it('keeps internal management information unchanged after an oversized update', async () => {
    const { project, sessionService } = await createTestProject(
      'session-management-limit',
    );
    const session = await sessionService.createSession(project.id, 'claude');
    await sessionService.updateSession(session.id, {
      managementInfo: { outputStyle: 'concise' },
    });

    await expect(
      sessionService.updateSession(session.id, {
        name: 'must-not-persist',
        managementInfo: {
          tools: ['x'.repeat(AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES)],
        },
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_PAYLOAD_TOO_LARGE',
      field: 'managementInfo',
    });
    expect(await sessionService.getSession(session.id)).toMatchObject({
      managementInfo: { outputStyle: 'concise' },
    });
    expect((await sessionService.getSession(session.id))?.name).toBeUndefined();
  });

  it('returns structured invalid-payload errors for unsupported configuration keys', async () => {
    const { project, sessionService, dispatchAgentRpc } =
      await createTestProject('session-invalid-key');
    const response = await dispatchAgentRpc(
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId: project.id },
        body: {
          engineName: 'codex',
          optionsConfig: JSON.parse(
            '{"codexConfig":{"constructor":"payload"}}',
          ),
        },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json).toMatchObject({
      code: 'AGENT_PAYLOAD_INVALID',
      field: 'optionsConfig.codexConfig.keys',
    });
    expect(await sessionService.getSessionsByProject(project.id)).toEqual([]);
  });
});
