import { describe, expect, it, vi } from 'vitest';
import type { AgentProject, AgentSession } from 'webpage-mcp-shared';
import {
  AGENT_SELECTED_PROJECT_STORAGE_KEY,
  AGENT_SELECTED_SESSION_STORAGE_KEY,
  loadAgentSelection,
  persistAgentSelection,
  type AgentSelectionStorage,
} from '@/utils/agent-selection';

function project(id: string): AgentProject {
  return {
    id,
    name: id,
    rootPath: `/workspace/${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function session(id: string, projectId: string): AgentSession {
  return {
    id,
    projectId,
    engineName: 'codex',
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function storageWith(values: Record<string, unknown>) {
  const writes: Record<string, unknown>[] = [];
  const storage: AgentSelectionStorage = {
    get: vi.fn(async () => ({ ...values })),
    set: vi.fn(async (next) => {
      writes.push({ ...next });
      Object.assign(values, next);
    }),
  };
  return { storage, writes };
}

describe('Agent selection reconciliation', () => {
  it('keeps a valid project/session pair and persists it atomically', async () => {
    const firstProject = project('project-1');
    const firstSession = session('session-1', firstProject.id);
    const { storage, writes } = storageWith({
      [AGENT_SELECTED_PROJECT_STORAGE_KEY]: firstProject.id,
      [AGENT_SELECTED_SESSION_STORAGE_KEY]: firstSession.id,
    });

    const result = await loadAgentSelection({
      storage,
      listProjects: async () => [firstProject],
      listSessions: async () => [firstSession],
      getSession: async () => firstSession,
    });

    expect(result).toMatchObject({
      selectedProjectId: firstProject.id,
      selectedSessionId: firstSession.id,
    });
    expect(writes).toEqual([
      {
        [AGENT_SELECTED_PROJECT_STORAGE_KEY]: firstProject.id,
        [AGENT_SELECTED_SESSION_STORAGE_KEY]: firstSession.id,
      },
    ]);
  });

  it('recovers a stale project key from the authoritative stored session', async () => {
    const firstProject = project('project-1');
    const firstSession = session('session-1', firstProject.id);
    const { storage } = storageWith({
      [AGENT_SELECTED_PROJECT_STORAGE_KEY]: 'deleted-project',
      [AGENT_SELECTED_SESSION_STORAGE_KEY]: firstSession.id,
    });

    const result = await loadAgentSelection({
      storage,
      listProjects: async () => [firstProject, project('project-2')],
      listSessions: async (projectId) => (projectId === firstProject.id ? [firstSession] : []),
      getSession: async () => firstSession,
    });

    expect(result?.selectedProjectId).toBe(firstProject.id);
    expect(result?.selectedSessionId).toBe(firstSession.id);
  });

  it('clears a mismatched session instead of pairing it with another project', async () => {
    const firstProject = project('project-1');
    const sessions = [session('session-a', firstProject.id), session('session-b', firstProject.id)];
    const { storage } = storageWith({
      [AGENT_SELECTED_PROJECT_STORAGE_KEY]: firstProject.id,
      [AGENT_SELECTED_SESSION_STORAGE_KEY]: 'session-from-another-project',
    });

    const result = await loadAgentSelection({
      storage,
      listProjects: async () => [firstProject],
      listSessions: async () => sessions,
      getSession: async () => session('session-from-another-project', 'project-2'),
    });

    expect(result?.selectedProjectId).toBe(firstProject.id);
    expect(result?.selectedSessionId).toBe('');
  });

  it('auto-selects only unique project and session choices', async () => {
    const onlyProject = project('only-project');
    const onlySession = session('only-session', onlyProject.id);
    const { storage } = storageWith({});

    const result = await loadAgentSelection({
      storage,
      listProjects: async () => [onlyProject],
      listSessions: async () => [onlySession],
      getSession: async () => null,
    });

    expect(result?.selectedProjectId).toBe(onlyProject.id);
    expect(result?.selectedSessionId).toBe(onlySession.id);
  });

  it('does not guess when multiple projects have no valid selection', async () => {
    const { storage } = storageWith({});

    const result = await loadAgentSelection({
      storage,
      listProjects: async () => [project('project-1'), project('project-2')],
      listSessions: vi.fn(async () => []),
      getSession: async () => null,
    });

    expect(result?.selectedProjectId).toBe('');
    expect(result?.selectedSessionId).toBe('');
  });

  it('does not persist a superseded asynchronous load', async () => {
    const { storage, writes } = storageWith({});

    const result = await loadAgentSelection({
      storage,
      listProjects: async () => [project('project-1')],
      listSessions: async () => [],
      getSession: async () => null,
      isCurrent: () => false,
    });

    expect(result).toBeNull();
    expect(writes).toEqual([]);
  });

  it('rejects an impossible session-only selection', async () => {
    const { storage } = storageWith({});
    await expect(persistAgentSelection('', 'session-1', storage)).rejects.toThrow(
      'requires a selected project',
    );
  });
});
