import type { AgentProject, AgentSession } from 'webpage-mcp-shared';

export const AGENT_SELECTED_PROJECT_STORAGE_KEY = 'agent-selected-project-id';
export const AGENT_SELECTED_SESSION_STORAGE_KEY = 'agent-selected-session-id';

export interface AgentSelectionStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export interface AgentSelectionSnapshot {
  projects: AgentProject[];
  sessions: AgentSession[];
  selectedProjectId: string;
  selectedSessionId: string;
}

export interface LoadAgentSelectionDependencies {
  storage?: AgentSelectionStorage;
  listProjects(): Promise<AgentProject[]>;
  listSessions(projectId: string): Promise<AgentSession[]>;
  getSession(sessionId: string): Promise<AgentSession | null>;
  /** Prevent a superseded async load from persisting stale selection state. */
  isCurrent?: () => boolean;
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getDefaultStorage(): AgentSelectionStorage {
  return chrome.storage.local as AgentSelectionStorage;
}

export async function persistAgentSelection(
  selectedProjectId: string,
  selectedSessionId: string,
  storage: AgentSelectionStorage = getDefaultStorage(),
): Promise<void> {
  const projectId = normalizeId(selectedProjectId);
  const sessionId = normalizeId(selectedSessionId);
  if (sessionId && !projectId) {
    throw new Error('A selected Agent session requires a selected project');
  }

  // Keep both keys in one storage operation so readers never observe a new
  // session paired with an old project.
  await storage.set({
    [AGENT_SELECTED_PROJECT_STORAGE_KEY]: projectId,
    [AGENT_SELECTED_SESSION_STORAGE_KEY]: sessionId,
  });
}

export async function loadAgentSelection(
  dependencies: LoadAgentSelectionDependencies,
): Promise<AgentSelectionSnapshot | null> {
  const storage = dependencies.storage ?? getDefaultStorage();
  const [stored, projects] = await Promise.all([
    storage.get([AGENT_SELECTED_PROJECT_STORAGE_KEY, AGENT_SELECTED_SESSION_STORAGE_KEY]),
    dependencies.listProjects(),
  ]);

  const storedProjectId = normalizeId(stored[AGENT_SELECTED_PROJECT_STORAGE_KEY]);
  const storedSessionId = normalizeId(stored[AGENT_SELECTED_SESSION_STORAGE_KEY]);
  let selectedProject = projects.find((project) => project.id === storedProjectId) ?? null;
  let recoveredSession: AgentSession | null = null;

  if (!selectedProject && storedSessionId) {
    try {
      recoveredSession = await dependencies.getSession(storedSessionId);
      if (recoveredSession) {
        selectedProject =
          projects.find((project) => project.id === recoveredSession?.projectId) ?? null;
      }
    } catch {
      recoveredSession = null;
    }
  }

  if (!selectedProject && projects.length === 1) {
    selectedProject = projects[0];
  }

  const sessions = selectedProject ? await dependencies.listSessions(selectedProject.id) : [];
  let selectedSession = selectedProject
    ? (sessions.find((session) => session.id === storedSessionId) ?? null)
    : null;

  if (
    !selectedSession &&
    recoveredSession?.projectId === selectedProject?.id &&
    sessions.some((session) => session.id === recoveredSession?.id)
  ) {
    selectedSession = recoveredSession;
  }
  if (!selectedSession && sessions.length === 1) {
    selectedSession = sessions[0];
  }

  if (dependencies.isCurrent && !dependencies.isCurrent()) {
    return null;
  }

  const selectedProjectId = selectedProject?.id ?? '';
  const selectedSessionId = selectedSession?.id ?? '';
  await persistAgentSelection(selectedProjectId, selectedSessionId, storage);

  return {
    projects,
    sessions,
    selectedProjectId,
    selectedSessionId,
  };
}
