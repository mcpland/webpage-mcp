import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_IDENTIFIER_MAX_BYTES,
  AGENT_MODEL_MAX_BYTES,
  AGENT_PROJECT_DESCRIPTION_MAX_BYTES,
  AGENT_PROJECT_LOCATION_MAX,
  AGENT_PROJECT_NAME_MAX_BYTES,
  AGENT_PROJECT_ROOT_MAX_BYTES,
  AGENT_PROJECT_UPSERT_MAX_JSON_BYTES,
} from 'webpage-mcp-shared';
import type { AgentChatService } from './chat-service';
import {
  validateProjectOpenFilePayload,
  validateProjectUpsertPayload,
} from './project-payload-limits';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

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
      withProjectLifecycleMutation: async (
        _projectId: string,
        _listSessionIds: () => Promise<string[]>,
        mutation: () => Promise<unknown>,
      ) => mutation(),
    } as AgentChatService,
  };
}

async function createTestRuntime(prefix: string) {
  const workspaceBase = await createTempDir(`${prefix}-workspace-`);
  const dataDir = await createTempDir(`${prefix}-data-`);
  const dbFile = path.join(dataDir, 'agent.db');

  process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;
  vi.resetModules();

  const [projectService, { dispatchAgentRpc }, openProject] = await Promise.all([
    import('./project-service'),
    import('./rpc-dispatcher'),
    import('./open-project'),
  ]);
  return {
    workspaceBase,
    dbFile,
    projectService,
    dispatchAgentRpc,
    openProject,
  };
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(async () => {
  try {
    const { closeDb } = await import('./db/client');
    closeDb();
  } catch {
    // Pure validation paths intentionally never initialize the database.
  }
  process.env.MCP_ALLOWED_WORKSPACE_BASE = originalAllowedWorkspaceBase;
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = originalAgentDataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = originalAgentDbFile;
  vi.resetModules();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe('project payload byte validation', () => {
  it('accepts every exact field boundary and rejects the first byte beyond it', () => {
    const exact = {
      id: 'i'.repeat(AGENT_IDENTIFIER_MAX_BYTES),
      name: 'n'.repeat(AGENT_PROJECT_NAME_MAX_BYTES),
      description: 'd'.repeat(AGENT_PROJECT_DESCRIPTION_MAX_BYTES),
      rootPath: 'r'.repeat(AGENT_PROJECT_ROOT_MAX_BYTES),
      preferredCli: 'codex',
      selectedModel: 'm'.repeat(AGENT_MODEL_MAX_BYTES),
      enableWebpageMcp: true,
      allowCreate: false,
    };
    expect(() => validateProjectUpsertPayload(exact)).not.toThrow();

    const cases = [
      ['id', 'i'.repeat(AGENT_IDENTIFIER_MAX_BYTES + 1)],
      ['name', 'n'.repeat(AGENT_PROJECT_NAME_MAX_BYTES + 1)],
      [
        'description',
        'd'.repeat(AGENT_PROJECT_DESCRIPTION_MAX_BYTES + 1),
      ],
      ['rootPath', 'r'.repeat(AGENT_PROJECT_ROOT_MAX_BYTES + 1)],
      ['selectedModel', 'm'.repeat(AGENT_MODEL_MAX_BYTES + 1)],
    ] as const;

    for (const [field, value] of cases) {
      expect(() =>
        validateProjectUpsertPayload({
          name: 'project',
          rootPath: '/workspace',
          [field]: value,
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'AGENT_PAYLOAD_TOO_LARGE',
          field,
        }),
      );
    }
  });

  it('measures the exact escaped JSON representation of the complete project', () => {
    const payload = {
      id: 'i'.repeat(AGENT_IDENTIFIER_MAX_BYTES),
      name: 'n'.repeat(AGENT_PROJECT_NAME_MAX_BYTES),
      description: 'd'.repeat(AGENT_PROJECT_DESCRIPTION_MAX_BYTES),
      rootPath: 'r'.repeat(AGENT_PROJECT_ROOT_MAX_BYTES),
      preferredCli: 'codex',
      selectedModel: 'm'.repeat(AGENT_MODEL_MAX_BYTES),
      enableWebpageMcp: true,
      allowCreate: false,
    };
    const baseBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    const escapingBytes = AGENT_PROJECT_UPSERT_MAX_JSON_BYTES - baseBytes;
    expect(escapingBytes).toBeGreaterThan(0);
    expect(escapingBytes).toBeLessThan(
      AGENT_PROJECT_DESCRIPTION_MAX_BYTES,
    );
    payload.description = `${'"'.repeat(escapingBytes)}${'d'.repeat(
      AGENT_PROJECT_DESCRIPTION_MAX_BYTES - escapingBytes,
    )}`;
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBe(
      AGENT_PROJECT_UPSERT_MAX_JSON_BYTES,
    );
    expect(() => validateProjectUpsertPayload(payload)).not.toThrow();

    payload.description = `${payload.description.slice(0, escapingBytes)}"${payload.description.slice(
      escapingBytes + 1,
    )}`;
    expect(() => validateProjectUpsertPayload(payload)).toThrow(
      expect.objectContaining({
        code: 'AGENT_PAYLOAD_TOO_LARGE',
        field: 'project',
        actualBytes: AGENT_PROJECT_UPSERT_MAX_JSON_BYTES + 1,
        maximumBytes: AGENT_PROJECT_UPSERT_MAX_JSON_BYTES,
      }),
    );
  });

  it('rejects wrong types, unknown keys, and unsafe source locations', () => {
    expect(() =>
      validateProjectUpsertPayload({ name: 42, rootPath: '/workspace' }),
    ).toThrow(
      expect.objectContaining({
        code: 'AGENT_PAYLOAD_INVALID',
        field: 'name',
      }),
    );
    expect(() =>
      validateProjectUpsertPayload(
        JSON.parse('{"name":"p","rootPath":"/w","__proto__":true}'),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'AGENT_PAYLOAD_INVALID',
        field: 'project.keys',
      }),
    );

    expect(() =>
      validateProjectOpenFilePayload(
        'f'.repeat(AGENT_PROJECT_ROOT_MAX_BYTES),
        AGENT_PROJECT_LOCATION_MAX,
        0,
      ),
    ).not.toThrow();
    for (const [field, line, column] of [
      ['line', -1, undefined],
      ['line', 1.5, undefined],
      ['line', AGENT_PROJECT_LOCATION_MAX + 1, undefined],
      ['column', undefined, '1'],
    ] as const) {
      expect(() =>
        validateProjectOpenFilePayload('/file.ts', line, column),
      ).toThrow(
        expect.objectContaining({
          code: 'AGENT_PAYLOAD_INVALID',
          field,
        }),
      );
    }
  });
});

describe('project RPC and service side-effect boundaries', () => {
  it('rejects an oversized upsert before creating a directory or database', async () => {
    const runtime = await createTestRuntime('project-upsert-limit');
    const projectRoot = path.join(runtime.workspaceBase, 'must-not-exist');

    const response = await runtime.dispatchAgentRpc(
      {
        operation: 'agent.projects.upsert',
        body: {
          name: 'n'.repeat(AGENT_PROJECT_NAME_MAX_BYTES + 1),
          rootPath: projectRoot,
          allowCreate: true,
        },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(413);
    expect(response.json).toMatchObject({
      code: 'AGENT_PAYLOAD_TOO_LARGE',
      field: 'name',
      actualBytes: AGENT_PROJECT_NAME_MAX_BYTES + 1,
      maximumBytes: AGENT_PROJECT_NAME_MAX_BYTES,
    });
    const unknownKeyResponse = await runtime.dispatchAgentRpc(
      {
        operation: 'agent.projects.upsert',
        body: {
          name: 'project',
          rootPath: projectRoot,
          allowCreate: true,
          unexpected: true,
        },
      },
      createRpcDeps(),
    );
    expect(unknownKeyResponse.statusCode).toBe(400);
    expect(unknownKeyResponse.json).toMatchObject({
      code: 'AGENT_PAYLOAD_INVALID',
      field: 'project.keys',
    });
    await expect(fs.access(projectRoot)).rejects.toThrow();
    await expect(fs.access(runtime.dbFile)).rejects.toThrow();
  });

  it('enforces the same upsert and resume-id limits inside the service', async () => {
    const runtime = await createTestRuntime('project-service-limit');
    const projectRoot = path.join(runtime.workspaceBase, 'must-not-exist');

    await expect(
      runtime.projectService.upsertProject({
        name: 'n'.repeat(AGENT_PROJECT_NAME_MAX_BYTES + 1),
        rootPath: projectRoot,
        allowCreate: true,
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_PAYLOAD_TOO_LARGE',
      field: 'name',
    });
    await expect(
      runtime.projectService.updateProjectClaudeSessionId(
        'project',
        's'.repeat(AGENT_IDENTIFIER_MAX_BYTES + 1),
      ),
    ).rejects.toMatchObject({
      code: 'AGENT_PAYLOAD_TOO_LARGE',
      field: 'activeClaudeSessionId',
    });
    await expect(fs.access(projectRoot)).rejects.toThrow();
    await expect(fs.access(runtime.dbFile)).rejects.toThrow();
  });

  it('rejects path helper payloads before filesystem or path work', async () => {
    const runtime = await createTestRuntime('project-path-limit');
    const oversizedPath = `${path.join(runtime.workspaceBase, 'no-create')}/${'x'.repeat(
      AGENT_PROJECT_ROOT_MAX_BYTES,
    )}`;

    const [validateResponse, createResponse, defaultResponse] =
      await Promise.all([
        runtime.dispatchAgentRpc(
          {
            operation: 'agent.projects.validatePath',
            body: { rootPath: 42 },
          },
          createRpcDeps(),
        ),
        runtime.dispatchAgentRpc(
          {
            operation: 'agent.projects.createDirectory',
            body: { absolutePath: oversizedPath },
          },
          createRpcDeps(),
        ),
        runtime.dispatchAgentRpc(
          {
            operation: 'agent.projects.defaultRoot',
            body: {
              projectName: 'n'.repeat(AGENT_PROJECT_NAME_MAX_BYTES + 1),
            },
          },
          createRpcDeps(),
        ),
      ]);

    expect(validateResponse.statusCode).toBe(400);
    expect(validateResponse.json).toMatchObject({
      code: 'AGENT_PAYLOAD_INVALID',
      field: 'rootPath',
    });
    expect(createResponse.statusCode).toBe(413);
    expect(createResponse.json).toMatchObject({
      code: 'AGENT_PAYLOAD_TOO_LARGE',
      field: 'absolutePath',
    });
    expect(defaultResponse.statusCode).toBe(413);
    expect(defaultResponse.json).toMatchObject({
      code: 'AGENT_PAYLOAD_TOO_LARGE',
      field: 'projectName',
    });
    await expect(
      fs.access(path.join(runtime.workspaceBase, 'no-create')),
    ).rejects.toThrow();
    await expect(fs.access(runtime.dbFile)).rejects.toThrow();
  });

  it('bounds every non-attachment projectId before database access', async () => {
    const runtime = await createTestRuntime('project-id-limit');
    const projectId = 'p'.repeat(AGENT_IDENTIFIER_MAX_BYTES + 1);
    const requests = [
      { operation: 'agent.projects.delete', params: { projectId } },
      { operation: 'agent.projects.sessions.list', params: { projectId } },
      {
        operation: 'agent.projects.sessions.create',
        params: { projectId },
        body: { engineName: 'codex' },
      },
      { operation: 'agent.projects.claudeInfo', params: { projectId } },
      {
        operation: 'agent.projects.open',
        params: { projectId },
        body: { target: 'vscode' },
      },
      {
        operation: 'agent.projects.openFile',
        params: { projectId },
        body: { filePath: 'src/index.ts' },
      },
      { operation: 'agent.chat.messages.list', params: { projectId } },
      {
        operation: 'agent.chat.messages.create',
        params: { projectId },
        body: { content: 'message' },
      },
      { operation: 'agent.chat.messages.delete', params: { projectId } },
    ];

    for (const request of requests) {
      const response = await runtime.dispatchAgentRpc(
        request,
        createRpcDeps(),
      );
      expect(response.statusCode).toBe(413);
      expect(response.json).toMatchObject({
        code: 'AGENT_PAYLOAD_TOO_LARGE',
        field: 'projectId',
        actualBytes: AGENT_IDENTIFIER_MAX_BYTES + 1,
        maximumBytes: AGENT_IDENTIFIER_MAX_BYTES,
      });
    }
    await expect(fs.access(runtime.dbFile)).rejects.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects invalid file locations before lookup or process spawn', async () => {
    const runtime = await createTestRuntime('project-open-file-limit');
    const projectRoot = path.join(runtime.workspaceBase, 'project');
    const project = await runtime.projectService.upsertProject({
      name: 'Open file project',
      rootPath: projectRoot,
      allowCreate: true,
    });
    spawnMock.mockClear();

    const invalidLine = await runtime.dispatchAgentRpc(
      {
        operation: 'agent.projects.openFile',
        params: { projectId: project.id },
        body: { filePath: 'src/index.ts', line: -1 },
      },
      createRpcDeps(),
    );
    const oversizedFile = await runtime.dispatchAgentRpc(
      {
        operation: 'agent.projects.openFile',
        params: { projectId: project.id },
        body: {
          filePath: 'f'.repeat(AGENT_PROJECT_ROOT_MAX_BYTES + 1),
        },
      },
      createRpcDeps(),
    );

    expect(invalidLine.statusCode).toBe(400);
    expect(invalidLine.json).toMatchObject({
      code: 'AGENT_PAYLOAD_INVALID',
      field: 'line',
    });
    expect(oversizedFile.statusCode).toBe(413);
    expect(oversizedFile.json).toMatchObject({
      code: 'AGENT_PAYLOAD_TOO_LARGE',
      field: 'filePath',
    });
    const directResult = await runtime.openProject.openFileInVSCode(
      projectRoot,
      'f'.repeat(AGENT_PROJECT_ROOT_MAX_BYTES + 1),
    );
    expect(directResult).toMatchObject({
      success: false,
      error: expect.stringContaining('filePath is too large'),
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps ordinary project creation compatible', async () => {
    const runtime = await createTestRuntime('project-valid');
    const projectRoot = path.join(runtime.workspaceBase, 'project');
    const response = await runtime.dispatchAgentRpc(
      {
        operation: 'agent.projects.upsert',
        body: {
          name: 'Valid project',
          description: 'bounded',
          rootPath: projectRoot,
          preferredCli: 'codex',
          selectedModel: 'gpt-5',
          allowCreate: true,
        },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      project: {
        name: 'Valid project',
        description: 'bounded',
        rootPath: projectRoot,
        preferredCli: 'codex',
        selectedModel: 'gpt-5',
      },
    });
    expect((await fs.stat(projectRoot)).isDirectory()).toBe(true);

    const projectId = (response.json as { project: { id: string } }).project.id;
    const exactResumeId = 's'.repeat(AGENT_IDENTIFIER_MAX_BYTES);
    await runtime.projectService.updateProjectClaudeSessionId(
      projectId,
      exactResumeId,
    );
    expect(await runtime.projectService.getProject(projectId)).toMatchObject({
      activeClaudeSessionId: exactResumeId,
    });
    await expect(
      runtime.projectService.updateProjectClaudeSessionId(
        projectId,
        `${exactResumeId}s`,
      ),
    ).rejects.toMatchObject({ field: 'activeClaudeSessionId' });
    expect(await runtime.projectService.getProject(projectId)).toMatchObject({
      activeClaudeSessionId: exactResumeId,
    });
  });
});
