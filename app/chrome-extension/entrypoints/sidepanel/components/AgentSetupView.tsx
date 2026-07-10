import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentCliPreference,
  AgentEngineInfo,
  AgentProject,
  AgentSession,
  CodexSandboxMode,
  CreateAgentSessionInput,
  UpdateAgentSessionInput,
} from 'webpage-mcp-shared';
import { requestAgentRpcCollection, requestAgentRpcJson } from '@/utils/agent-rpc';
import {
  loadAgentSelection,
  persistAgentSelection,
  type AgentSelectionSnapshot,
} from '@/utils/agent-selection';
import { getMessage } from '@/utils/i18n';
import './AgentSetupView.css';

type ClaudePermissionMode = 'default' | 'acceptEdits' | 'dontAsk' | 'plan' | 'bypassPermissions';

interface PathValidationResult {
  valid: boolean;
  absolute: string;
  exists: boolean;
  needsCreation: boolean;
  error?: string;
}

const EMPTY_SNAPSHOT: AgentSelectionSnapshot = {
  projects: [],
  sessions: [],
  selectedProjectId: '',
  selectedSessionId: '',
};

function pathName(rootPath: string): string {
  const parts = rootPath
    .trim()
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/);
  return parts[parts.length - 1] || 'Project';
}

function isDangerousSession(session: AgentSession): boolean {
  if (session.engineName === 'claude') {
    return session.permissionMode === 'bypassPermissions';
  }
  return session.optionsConfig?.codexConfig?.sandboxMode === 'danger-full-access';
}

function buildPermissionSettings(
  engineName: AgentCliPreference,
  permissionMode: ClaudePermissionMode,
  sandboxMode: CodexSandboxMode,
  dangerConfirmed: boolean,
): Pick<
  CreateAgentSessionInput,
  'permissionMode' | 'allowDangerouslySkipPermissions' | 'optionsConfig'
> {
  if (engineName === 'claude') {
    return {
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions' && dangerConfirmed,
    };
  }

  return {
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    optionsConfig: {
      codexConfig: {
        sandboxMode,
        dangerouslyAllowFullAccess: sandboxMode === 'danger-full-access' && dangerConfirmed,
      },
    },
  };
}

export default function AgentSetupView() {
  const t = (key: string, fallback: string, substitutions?: string[]): string =>
    getMessage(key, substitutions, fallback);
  const [snapshot, setSnapshot] = useState<AgentSelectionSnapshot>(EMPTY_SNAPSHOT);
  const [engines, setEngines] = useState<AgentEngineInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectRoot, setProjectRoot] = useState('');
  const [showSessionForm, setShowSessionForm] = useState(false);
  const [sessionName, setSessionName] = useState('');
  const [engineName, setEngineName] = useState<AgentCliPreference>('claude');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState<ClaudePermissionMode>('acceptEdits');
  const [sandboxMode, setSandboxMode] = useState<CodexSandboxMode>('workspace-write');
  const [dangerConfirmed, setDangerConfirmed] = useState(false);
  const [editingSession, setEditingSession] = useState(false);
  const loadNonce = useRef(0);

  const selectedProject = useMemo(
    () => snapshot.projects.find((project) => project.id === snapshot.selectedProjectId) ?? null,
    [snapshot.projects, snapshot.selectedProjectId],
  );
  const selectedSession = useMemo(
    () => snapshot.sessions.find((session) => session.id === snapshot.selectedSessionId) ?? null,
    [snapshot.sessions, snapshot.selectedSessionId],
  );
  const selectedModeIsDangerous =
    engineName === 'claude'
      ? permissionMode === 'bypassPermissions'
      : sandboxMode === 'danger-full-access';

  async function listProjects(): Promise<AgentProject[]> {
    return requestAgentRpcCollection<AgentProject>(
      { operation: 'agent.projects.list' },
      'projects',
    );
  }

  async function listSessions(projectId: string): Promise<AgentSession[]> {
    return requestAgentRpcCollection<AgentSession>(
      { operation: 'agent.projects.sessions.list', params: { projectId } },
      'sessions',
    );
  }

  async function getSession(sessionId: string): Promise<AgentSession | null> {
    try {
      const response = await requestAgentRpcJson<{ session?: AgentSession }>({
        operation: 'agent.sessions.get',
        params: { sessionId },
      });
      return response.session ?? null;
    } catch {
      return null;
    }
  }

  async function refreshSelection(): Promise<void> {
    const nonce = ++loadNonce.current;
    setLoading(true);
    setError(null);
    try {
      const requestedSessionId = new URLSearchParams(window.location.search).get('sessionId');
      if (requestedSessionId) {
        const requestedSession = await getSession(requestedSessionId);
        if (requestedSession && nonce === loadNonce.current) {
          await persistAgentSelection(requestedSession.projectId, requestedSession.id);
        }
      }

      const [selection, engineResponse] = await Promise.all([
        loadAgentSelection({
          listProjects,
          listSessions,
          getSession,
          isCurrent: () => nonce === loadNonce.current,
        }),
        requestAgentRpcJson<{ engines?: AgentEngineInfo[] }>({
          operation: 'agent.engines.list',
        }),
      ]);
      if (nonce !== loadNonce.current || !selection) return;
      setSnapshot(selection);
      const availableEngines = engineResponse.engines ?? [];
      setEngines(availableEngines);
      if (!availableEngines.some((engine) => engine.name === engineName)) {
        const first = availableEngines[0]?.name;
        if (first === 'claude' || first === 'codex') setEngineName(first);
      }
    } catch (refreshError) {
      if (nonce === loadNonce.current) {
        setError(
          refreshError instanceof Error ? refreshError.message : 'Failed to load Agent setup',
        );
      }
    } finally {
      if (nonce === loadNonce.current) setLoading(false);
    }
  }

  useEffect(() => {
    void refreshSelection();
    return () => {
      loadNonce.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!selectedSession) return;
    setEngineName(selectedSession.engineName);
    setModel(selectedSession.model ?? '');
    setPermissionMode(
      selectedSession.engineName === 'claude'
        ? (selectedSession.permissionMode as ClaudePermissionMode)
        : 'acceptEdits',
    );
    setSandboxMode(selectedSession.optionsConfig?.codexConfig?.sandboxMode ?? 'workspace-write');
    setDangerConfirmed(false);
  }, [selectedSession?.id]);

  async function selectProject(projectId: string): Promise<void> {
    const nonce = ++loadNonce.current;
    setBusy(true);
    setError(null);
    try {
      const sessions = await listSessions(projectId);
      if (nonce !== loadNonce.current) return;
      const selectedSessionId =
        projectId === snapshot.selectedProjectId &&
        sessions.some((session) => session.id === snapshot.selectedSessionId)
          ? snapshot.selectedSessionId
          : sessions.length === 1
            ? sessions[0].id
            : '';
      await persistAgentSelection(projectId, selectedSessionId);
      if (nonce !== loadNonce.current) return;
      setSnapshot((current) => ({
        ...current,
        sessions,
        selectedProjectId: projectId,
        selectedSessionId,
      }));
      setEditingSession(false);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : 'Failed to select project');
    } finally {
      if (nonce === loadNonce.current) setBusy(false);
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    if (!session || session.projectId !== snapshot.selectedProjectId) return;
    setError(null);
    try {
      await persistAgentSelection(session.projectId, session.id);
      setSnapshot((current) => ({ ...current, selectedSessionId: session.id }));
      setShowSessionForm(false);
      setEditingSession(false);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : 'Failed to select session');
    }
  }

  async function pickProjectDirectory(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await requestAgentRpcJson<{
        success?: boolean;
        path?: string;
        cancelled?: boolean;
        error?: string;
      }>({ operation: 'agent.projects.pickDirectory' });
      if (result.path) {
        setProjectRoot(result.path);
        if (!projectName.trim()) setProjectName(pathName(result.path));
      } else if (!result.cancelled && result.error) {
        setError(result.error);
      }
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : 'Failed to pick directory');
    } finally {
      setBusy(false);
    }
  }

  async function createProject(): Promise<void> {
    const name = projectName.trim();
    const rootPath = projectRoot.trim();
    if (!name || !rootPath) return;
    setBusy(true);
    setError(null);
    try {
      const validation = await requestAgentRpcJson<PathValidationResult>({
        operation: 'agent.projects.validatePath',
        body: { rootPath },
      });
      if (!validation.valid) throw new Error(validation.error || 'Invalid project path');
      const normalized = validation.absolute.replace(/[\\/]+$/, '').toLowerCase();
      const existing = snapshot.projects.find(
        (project) => project.rootPath.replace(/[\\/]+$/, '').toLowerCase() === normalized,
      );
      if (existing) {
        await selectProject(existing.id);
        setShowProjectForm(false);
        return;
      }
      let allowCreate = false;
      if (validation.needsCreation) {
        allowCreate = window.confirm(
          t('agentProjectsConfirmCreateDir', 'The directory "$ARG1$" does not exist. Create it?', [
            validation.absolute,
          ]),
        );
        if (!allowCreate) return;
      }
      const response = await requestAgentRpcJson<{ project?: AgentProject }>({
        operation: 'agent.projects.upsert',
        body: { name, rootPath: validation.absolute, allowCreate },
      });
      if (!response.project) throw new Error('Project response is invalid');
      await persistAgentSelection(response.project.id, '');
      setProjectName('');
      setProjectRoot('');
      setShowProjectForm(false);
      await refreshSelection();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create project');
    } finally {
      setBusy(false);
    }
  }

  async function createSession(): Promise<void> {
    const projectId = snapshot.selectedProjectId;
    if (!projectId || (selectedModeIsDangerous && !dangerConfirmed)) return;
    setBusy(true);
    setError(null);
    try {
      const input: CreateAgentSessionInput = {
        engineName,
        name: sessionName.trim() || undefined,
        model: model.trim() || undefined,
        ...buildPermissionSettings(engineName, permissionMode, sandboxMode, dangerConfirmed),
      };
      const response = await requestAgentRpcJson<{ session?: AgentSession }>({
        operation: 'agent.projects.sessions.create',
        params: { projectId },
        body: input,
      });
      const session = response.session;
      if (!session || session.projectId !== projectId) {
        throw new Error('Session response is invalid');
      }
      await persistAgentSelection(projectId, session.id);
      setSnapshot((current) => ({
        ...current,
        sessions: [session, ...current.sessions.filter((item) => item.id !== session.id)],
        selectedSessionId: session.id,
      }));
      setSessionName('');
      setModel('');
      setDangerConfirmed(false);
      setShowSessionForm(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create session');
    } finally {
      setBusy(false);
    }
  }

  async function updateSelectedSession(): Promise<void> {
    if (!selectedSession || (selectedModeIsDangerous && !dangerConfirmed)) return;
    setBusy(true);
    setError(null);
    try {
      const permissionSettings = buildPermissionSettings(
        selectedSession.engineName,
        permissionMode,
        sandboxMode,
        dangerConfirmed,
      );
      const updates: UpdateAgentSessionInput = {
        model: model.trim() || null,
        permissionMode: permissionSettings.permissionMode,
        allowDangerouslySkipPermissions: permissionSettings.allowDangerouslySkipPermissions,
        ...(selectedSession.engineName === 'codex'
          ? {
              optionsConfig: {
                ...selectedSession.optionsConfig,
                codexConfig: {
                  ...selectedSession.optionsConfig?.codexConfig,
                  ...permissionSettings.optionsConfig?.codexConfig,
                },
              },
            }
          : {}),
      };
      const response = await requestAgentRpcJson<{ session?: AgentSession }>({
        operation: 'agent.sessions.update',
        params: { sessionId: selectedSession.id },
        body: updates,
      });
      if (!response.session) throw new Error('Session response is invalid');
      setSnapshot((current) => ({
        ...current,
        sessions: current.sessions.map((item) =>
          item.id === response.session?.id ? response.session : item,
        ) as AgentSession[],
      }));
      setDangerConfirmed(false);
      setEditingSession(false);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to update session');
    } finally {
      setBusy(false);
    }
  }

  function renderSecurityFields() {
    return (
      <>
        {engineName === 'claude' ? (
          <label className="agent-setup-field">
            <span>{t('agentSessionPermissionModeLabel', 'Permission Mode')}</span>
            <select
              value={permissionMode}
              onChange={(event) => {
                setPermissionMode(event.currentTarget.value as ClaudePermissionMode);
                setDangerConfirmed(false);
              }}
            >
              <option value="acceptEdits">
                {t('agentSessionPermissionAcceptEdits', 'acceptEdits - Auto-accept file edits')}
              </option>
              <option value="default">
                {t('agentSessionPermissionDefault', 'default - Ask for approval')}
              </option>
              <option value="dontAsk">
                {t('agentSessionPermissionDontAsk', 'dontAsk - No confirmation')}
              </option>
              <option value="plan">
                {t('agentSessionPermissionPlan', 'plan - Plan mode only')}
              </option>
              <option value="bypassPermissions">
                {t('agentSessionPermissionBypass', 'bypassPermissions - Auto-accept all')}
              </option>
            </select>
          </label>
        ) : (
          <label className="agent-setup-field">
            <span>Sandbox</span>
            <select
              value={sandboxMode}
              onChange={(event) => {
                setSandboxMode(event.currentTarget.value as CodexSandboxMode);
                setDangerConfirmed(false);
              }}
            >
              <option value="workspace-write">Workspace write</option>
              <option value="read-only">Read only</option>
              <option value="danger-full-access">Danger: full filesystem access</option>
            </select>
          </label>
        )}
        {selectedModeIsDangerous ? (
          <label className="agent-setup-danger">
            <input
              type="checkbox"
              checked={dangerConfirmed}
              onChange={(event) => setDangerConfirmed(event.currentTarget.checked)}
            />
            <span>
              I understand this mode can run tools without normal workspace or approval safeguards.
            </span>
          </label>
        ) : null}
      </>
    );
  }

  return (
    <main className="agent-setup-view">
      <header className="agent-setup-header">
        <div>
          <h1>{t('sidepanelNavigatorAgentTitle', 'AI Assistant')}</h1>
          <p>Choose the workspace and safe execution session used by Quick Panel and Web Editor.</p>
        </div>
        <button type="button" onClick={() => void refreshSelection()} disabled={loading || busy}>
          Refresh
        </button>
      </header>

      {error ? (
        <div className="agent-setup-error" role="alert">
          {error}
        </div>
      ) : null}
      {loading ? <div className="agent-setup-empty">Loading Agent setup…</div> : null}

      {!loading ? (
        <>
          <section className="agent-setup-card">
            <div className="agent-setup-section-title">
              <div>
                <h2>{t('agentProjectsTitle', 'Projects')}</h2>
                <p>Select the source workspace that Agent tools may access.</p>
              </div>
              <button type="button" onClick={() => setShowProjectForm((value) => !value)}>
                {t('agentProjectsNewButton', '+ New Project')}
              </button>
            </div>
            <div className="agent-setup-list">
              {snapshot.projects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  className={project.id === snapshot.selectedProjectId ? 'selected' : ''}
                  onClick={() => void selectProject(project.id)}
                  disabled={busy}
                >
                  <strong>{project.name}</strong>
                  <span>{project.rootPath}</span>
                </button>
              ))}
              {snapshot.projects.length === 0 ? (
                <div className="agent-setup-empty">
                  No projects yet. Add the workspace you want to edit.
                </div>
              ) : null}
            </div>
            {showProjectForm ? (
              <div className="agent-setup-form">
                <label className="agent-setup-field">
                  <span>Project name</span>
                  <input
                    value={projectName}
                    onChange={(event) => setProjectName(event.currentTarget.value)}
                  />
                </label>
                <label className="agent-setup-field">
                  <span>Workspace directory</span>
                  <div className="agent-setup-inline">
                    <input
                      value={projectRoot}
                      onChange={(event) => setProjectRoot(event.currentTarget.value)}
                    />
                    <button
                      type="button"
                      onClick={() => void pickProjectDirectory()}
                      disabled={busy}
                    >
                      Browse
                    </button>
                  </div>
                </label>
                <button
                  className="primary"
                  type="button"
                  onClick={() => void createProject()}
                  disabled={busy || !projectName.trim() || !projectRoot.trim()}
                >
                  Create project
                </button>
              </div>
            ) : null}
          </section>

          <section className="agent-setup-card">
            <div className="agent-setup-section-title">
              <div>
                <h2>{t('agentSessionsTitle', 'Sessions')}</h2>
                <p>
                  {selectedProject
                    ? `Sessions for ${selectedProject.name}`
                    : 'Select a project first.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingSession(false);
                  setShowSessionForm((value) => !value);
                  const defaultEngine = engines.some((engine) => engine.name === 'claude')
                    ? 'claude'
                    : engines[0]?.name;
                  if (defaultEngine === 'claude' || defaultEngine === 'codex') {
                    setEngineName(defaultEngine);
                  }
                  setPermissionMode('acceptEdits');
                  setSandboxMode('workspace-write');
                  setDangerConfirmed(false);
                }}
                disabled={!selectedProject}
              >
                {t('agentSessionNewButton', '+ New Session')}
              </button>
            </div>
            <div className="agent-setup-list">
              {snapshot.sessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  className={session.id === snapshot.selectedSessionId ? 'selected' : ''}
                  onClick={() => void selectSession(session.id)}
                >
                  <strong>{session.name || t('agentSessionsUnnamed', 'Unnamed Session')}</strong>
                  <span>
                    {session.engineName}
                    {session.model ? ` · ${session.model}` : ''}
                  </span>
                  {isDangerousSession(session) ? (
                    <em>Dangerous permissions — review required</em>
                  ) : null}
                </button>
              ))}
              {selectedProject && snapshot.sessions.length === 0 ? (
                <div className="agent-setup-empty">
                  {t('agentSessionsEmpty', 'No sessions yet')}
                </div>
              ) : null}
            </div>

            {selectedSession && !showSessionForm ? (
              <div className="agent-setup-selected">
                <div>
                  <strong>Active session</strong>
                  <span>{selectedSession.name || selectedSession.id}</span>
                </div>
                <button type="button" onClick={() => setEditingSession((value) => !value)}>
                  {t('agentSessionSettingsTitle', 'Session Settings')}
                </button>
              </div>
            ) : null}

            {showSessionForm || editingSession ? (
              <div className="agent-setup-form">
                {showSessionForm ? (
                  <label className="agent-setup-field">
                    <span>Session name</span>
                    <input
                      value={sessionName}
                      onChange={(event) => setSessionName(event.currentTarget.value)}
                    />
                  </label>
                ) : null}
                <label className="agent-setup-field">
                  <span>{t('agentSessionEngineLabel', 'Engine')}</span>
                  <select
                    value={engineName}
                    disabled={editingSession}
                    onChange={(event) => {
                      setEngineName(event.currentTarget.value as AgentCliPreference);
                      setDangerConfirmed(false);
                    }}
                  >
                    {engines.map((engine) => (
                      <option key={engine.name} value={engine.name}>
                        {engine.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="agent-setup-field">
                  <span>{t('agentSessionModelLabel', 'Model')}</span>
                  <input
                    value={model}
                    onChange={(event) => setModel(event.currentTarget.value)}
                    placeholder={t('agentSessionModelDefaultServer', 'Default (server setting)')}
                  />
                </label>
                {renderSecurityFields()}
                <button
                  className="primary"
                  type="button"
                  onClick={() => void (showSessionForm ? createSession() : updateSelectedSession())}
                  disabled={busy || (selectedModeIsDangerous && !dangerConfirmed)}
                >
                  {showSessionForm ? 'Create and select session' : 'Save safe settings'}
                </button>
              </div>
            ) : null}
          </section>

          <footer className="agent-setup-status">
            {selectedProject && selectedSession
              ? `Ready: ${selectedProject.name} / ${selectedSession.name || selectedSession.id}`
              : 'Setup incomplete: select both a project and a session.'}
          </footer>
        </>
      ) : null}
    </main>
  );
}
