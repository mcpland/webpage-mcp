/**
 * Composable for managing Agent Sessions.
 * Sessions represent independent conversations within a project.
 * Each session has its own engine configuration, chat history, and resume state.
 */
import { ref, computed } from '@/entrypoints/shared/reactivity';
import { agentFetch } from '@/utils/agent-rpc';
import type {
  AgentSession,
  AgentCliPreference,
  CreateAgentSessionInput,
  UpdateAgentSessionInput,
  AgentStoredMessage,
  AgentManagementInfo,
} from 'webpage-mcp-shared';

type AgentSessionPreviewMeta = {
  displayText?: string;
  clientMeta?: {
    kind?: 'web_editor_apply_batch' | 'web_editor_apply_single';
    pageUrl?: string;
    elementCount?: number;
    elementLabels?: string[];
  };
  fullContent?: string;
};

type AgentSessionWithPreviewMeta = AgentSession & {
  previewMeta?: AgentSessionPreviewMeta;
};

const STORAGE_KEY_SELECTED_SESSION = 'agent-selected-session-id';

export interface UseAgentSessionsOptions {
  ensureServer: () => Promise<boolean>;
  onSessionChanged?: (sessionId: string) => void;
  onHistoryLoaded?: (messages: AgentStoredMessage[]) => void;
}

export function useAgentSessions(options: UseAgentSessionsOptions) {
  // State
  const sessions = ref<AgentSessionWithPreviewMeta[]>([]);
  const allSessions = ref<AgentSessionWithPreviewMeta[]>([]); // All sessions across all projects
  const selectedSessionId = ref<string>('');
  const isLoadingSessions = ref(false);
  const isLoadingAllSessions = ref(false);
  const isCreatingSession = ref(false);
  const sessionError = ref<string | null>(null);

  // Computed
  const selectedSession = computed(() => {
    return sessions.value.find((s) => s.id === selectedSessionId.value) || null;
  });

  const hasSessions = computed(() => sessions.value.length > 0);

  // Load selected session from storage
  async function loadSelectedSessionId(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_SELECTED_SESSION);
      if (result[STORAGE_KEY_SELECTED_SESSION]) {
        selectedSessionId.value = result[STORAGE_KEY_SELECTED_SESSION];
      }
    } catch (error) {
      console.error('Failed to load selected session ID:', error);
    }
  }

  // Save selected session to storage
  async function saveSelectedSessionId(): Promise<void> {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY_SELECTED_SESSION]: selectedSessionId.value,
      });
    } catch (error) {
      console.error('Failed to save selected session ID:', error);
    }
  }

  // Track pending session fetch with nonce to prevent A→B→A race conditions
  let fetchSessionsNonce = 0;

  /**
   * Fetch sessions for a project with race-condition protection.
   * Uses a nonce to handle A→B→A scenarios.
   */
  async function fetchSessions(projectId: string): Promise<void> {
    if (!projectId) return;

    // Increment nonce - any subsequent fetch will invalidate this one
    const myNonce = ++fetchSessionsNonce;

    const isStillValid = (): boolean => {
      return myNonce === fetchSessionsNonce;
    };

    isLoadingSessions.value = true;
    sessionError.value = null;

    try {
      const url = `/agent/projects/${encodeURIComponent(projectId)}/sessions`;
      const response = await agentFetch(url);

      if (!isStillValid()) return;

      if (response.ok) {
        const data = await response.json();

        if (!isStillValid()) return;

        sessions.value = data.sessions || [];

        // If we have sessions but no selection, select the most recent one
        if (sessions.value.length > 0 && !selectedSessionId.value) {
          selectedSessionId.value = sessions.value[0].id;
          await saveSelectedSessionId();
        }
      } else {
        const text = await response.text().catch(() => '');
        sessionError.value = text || `HTTP ${response.status}`;
      }
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
      sessionError.value = error instanceof Error ? error.message : 'Failed to fetch sessions';
    } finally {
      isLoadingSessions.value = false;
    }
  }

  // Track pending all sessions fetch with nonce
  let fetchAllSessionsNonce = 0;

  /**
   * Fetch all sessions across all projects.
   * Used for the global sessions list view.
   */
  async function fetchAllSessions(): Promise<void> {
    const myNonce = ++fetchAllSessionsNonce;

    const isStillValid = (): boolean => {
      return myNonce === fetchAllSessionsNonce;
    };

    isLoadingAllSessions.value = true;
    sessionError.value = null;

    try {
      const url = '/agent/sessions';
      const response = await agentFetch(url);

      if (!isStillValid()) return;

      if (response.ok) {
        const data = await response.json();

        if (!isStillValid()) return;

        allSessions.value = data.sessions || [];
      } else {
        const text = await response.text().catch(() => '');
        sessionError.value = text || `HTTP ${response.status}`;
      }
    } catch (error) {
      console.error('Failed to fetch all sessions:', error);
      sessionError.value = error instanceof Error ? error.message : 'Failed to fetch sessions';
    } finally {
      isLoadingAllSessions.value = false;
    }
  }

  // Track pending create session with nonce to prevent cross-project pollution
  let createSessionNonce = 0;

  /**
   * Create a new session with race-condition protection.
   * Uses a nonce to prevent cross-project state pollution when user switches
   * projects during session creation.
   */
  async function createSession(
    projectId: string,
    input: CreateAgentSessionInput,
  ): Promise<AgentSession | null> {
    const ready = await options.ensureServer();
    if (!ready) {
      sessionError.value = 'Server not available';
      return null;
    }

    // Increment nonce - any subsequent create will invalidate this one
    const myNonce = ++createSessionNonce;

    isCreatingSession.value = true;
    sessionError.value = null;

    try {
      const url = `/agent/projects/${encodeURIComponent(projectId)}/sessions`;
      const response = await agentFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      // Guard: check if this is still the expected create operation
      if (myNonce !== createSessionNonce) {
        // A newer create was initiated - discard this result
        return null;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `HTTP ${response.status}`);
      }

      const data = await response.json();

      // Re-check after json parsing
      if (myNonce !== createSessionNonce) {
        return null;
      }

      const session = data.session as AgentSession | undefined;

      if (session?.id) {
        // Add to local list and select it
        sessions.value = [session, ...sessions.value];
        // Also add to allSessions (at front, as it's the newest)
        allSessions.value = [session, ...allSessions.value.filter((s) => s.id !== session.id)];
        selectedSessionId.value = session.id;
        await saveSelectedSessionId();
        options.onSessionChanged?.(session.id);
        return session;
      }

      sessionError.value = 'Session created but response is invalid';
      return null;
    } catch (error) {
      // Guard: only handle error if still valid
      if (myNonce !== createSessionNonce) {
        return null;
      }
      console.error('Failed to create session:', error);
      sessionError.value = error instanceof Error ? error.message : 'Failed to create session';
      return null;
    } finally {
      isCreatingSession.value = false;
    }
  }

  // Get a session by ID
  async function getSession(sessionId: string): Promise<AgentSession | null> {
    if (!sessionId) return null;

    try {
      const url = `/agent/sessions/${encodeURIComponent(sessionId)}`;
      const response = await agentFetch(url);
      if (response.ok) {
        const data = await response.json();
        return data.session || null;
      }
      return null;
    } catch (error) {
      console.error('Failed to get session:', error);
      return null;
    }
  }

  // Update a session
  async function updateSession(
    sessionId: string,
    updates: UpdateAgentSessionInput,
  ): Promise<AgentSession | null> {
    if (!sessionId) return null;

    try {
      const url = `/agent/sessions/${encodeURIComponent(sessionId)}`;
      const response = await agentFetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const session = data.session as AgentSession | undefined;

      if (session?.id) {
        // Update local list
        const index = sessions.value.findIndex((s) => s.id === session.id);
        if (index !== -1) {
          sessions.value[index] = session;
        }
        // Also update allSessions (in-place to preserve order)
        const allIndex = allSessions.value.findIndex((s) => s.id === session.id);
        if (allIndex !== -1) {
          allSessions.value[allIndex] = session;
        }
        return session;
      }

      return null;
    } catch (error) {
      console.error('Failed to update session:', error);
      sessionError.value = error instanceof Error ? error.message : 'Failed to update session';
      return null;
    }
  }

  // Delete a session
  async function deleteSession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;

    try {
      const url = `/agent/sessions/${encodeURIComponent(sessionId)}`;
      const response = await agentFetch(url, { method: 'DELETE' });

      if (response.ok || response.status === 204) {
        // Remove from local list
        sessions.value = sessions.value.filter((s) => s.id !== sessionId);
        // Also remove from allSessions
        allSessions.value = allSessions.value.filter((s) => s.id !== sessionId);

        // If deleted session was selected, select another one
        if (selectedSessionId.value === sessionId) {
          selectedSessionId.value = sessions.value[0]?.id || '';
          await saveSelectedSessionId();
          if (selectedSessionId.value) {
            options.onSessionChanged?.(selectedSessionId.value);
          }
        }
        return true;
      }

      return false;
    } catch (error) {
      console.error('Failed to delete session:', error);
      return false;
    }
  }

  // Select a session
  async function selectSession(sessionId: string): Promise<void> {
    if (selectedSessionId.value === sessionId) return;

    selectedSessionId.value = sessionId;
    await saveSelectedSessionId();
    options.onSessionChanged?.(sessionId);
  }

  // Create a default session for a project if none exist
  async function ensureDefaultSession(
    projectId: string,
    engineName: AgentCliPreference = 'claude',
  ): Promise<AgentSession | null> {
    await fetchSessions(projectId);

    // If sessions exist, select the first one if none selected
    if (sessions.value.length > 0) {
      if (
        !selectedSessionId.value ||
        !sessions.value.find((s) => s.id === selectedSessionId.value)
      ) {
        await selectSession(sessions.value[0].id);
      }
      return selectedSession.value;
    }

    // Create default session
    return createSession(projectId, {
      engineName,
      name: 'Default Session',
    });
  }

  // Rename a session
  async function renameSession(sessionId: string, name: string): Promise<boolean> {
    const result = await updateSession(sessionId, { name });
    return result !== null;
  }

  // Reset a session conversation (delete messages + clear engineSessionId)
  async function resetConversation(sessionId: string): Promise<{
    deletedMessages: number;
    clearedEngineSessionId: boolean;
    session: AgentSession | null;
  } | null> {
    const ready = await options.ensureServer();
    if (!ready || !sessionId) {
      sessionError.value = 'Server not available';
      return null;
    }

    sessionError.value = null;

    try {
      const url = `/agent/sessions/${encodeURIComponent(sessionId)}/reset`;
      const response = await agentFetch(url, { method: 'POST' });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const session = data.session as AgentSession | null;

      // Update local session state
      if (session?.id) {
        const index = sessions.value.findIndex((s) => s.id === session.id);
        if (index !== -1) {
          sessions.value[index] = session;
        }
      }

      return {
        deletedMessages: typeof data.deletedMessages === 'number' ? data.deletedMessages : 0,
        clearedEngineSessionId: data.clearedEngineSessionId === true,
        session,
      };
    } catch (error) {
      console.error('Failed to reset conversation:', error);
      sessionError.value = error instanceof Error ? error.message : 'Failed to reset conversation';
      return null;
    }
  }

  // Fetch Claude SDK management info for a session
  async function fetchClaudeInfo(sessionId: string): Promise<{
    managementInfo: AgentManagementInfo | null;
    sessionId: string;
    engineName: string;
  } | null> {
    if (!sessionId) return null;

    try {
      const url = `/agent/sessions/${encodeURIComponent(sessionId)}/claude-info`;
      const response = await agentFetch(url);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `HTTP ${response.status}`);
      }

      const data = await response.json();
      return {
        managementInfo: data.managementInfo ?? null,
        sessionId: data.sessionId ?? sessionId,
        engineName: data.engineName ?? '',
      };
    } catch (error) {
      console.error('Failed to fetch Claude info:', error);
      return null;
    }
  }

  // Clear sessions when project changes
  function clearSessions(): void {
    sessions.value = [];
    selectedSessionId.value = '';
  }

  /**
   * Update session preview and updatedAt locally (without server call).
   * Used when sending a message to update the display immediately.
   * Always updates updatedAt so the session moves to the top of the list.
   * @param sessionId - The session to update
   * @param preview - The preview text (user's raw input)
   * @param previewMeta - Optional structured metadata for special rendering (e.g., web editor apply chip)
   */
  function updateSessionPreview(
    sessionId: string,
    preview: string,
    previewMeta?: AgentSessionWithPreviewMeta['previewMeta'],
  ): void {
    // Truncate to 50 chars with ellipsis
    const maxLen = 50;
    const trimmed = preview.trim().replace(/\s+/g, ' ');
    const truncated = trimmed.length > maxLen ? trimmed.slice(0, maxLen - 1) + '…' : trimmed;

    // Always update updatedAt to move session to top of list
    const now = new Date().toISOString();

    // Update in current project sessions
    const index = sessions.value.findIndex((s) => s.id === sessionId);
    if (index !== -1) {
      sessions.value[index] = {
        ...sessions.value[index],
        // Only update preview if not already set
        preview: sessions.value[index].preview || truncated,
        previewMeta: sessions.value[index].previewMeta || previewMeta,
        // Always update timestamp so session moves to top
        updatedAt: now,
      };
    }

    // Also update in allSessions for global list view
    const allIndex = allSessions.value.findIndex((s) => s.id === sessionId);
    if (allIndex !== -1) {
      allSessions.value[allIndex] = {
        ...allSessions.value[allIndex],
        preview: allSessions.value[allIndex].preview || truncated,
        previewMeta: allSessions.value[allIndex].previewMeta || previewMeta,
        updatedAt: now,
      };
    }
  }

  return {
    // State
    sessions,
    allSessions,
    selectedSessionId,
    isLoadingSessions,
    isLoadingAllSessions,
    isCreatingSession,
    sessionError,

    // Computed
    selectedSession,
    hasSessions,

    // Methods
    loadSelectedSessionId,
    saveSelectedSessionId,
    fetchSessions,
    fetchAllSessions,
    createSession,
    getSession,
    updateSession,
    deleteSession,
    selectSession,
    ensureDefaultSession,
    renameSession,
    resetConversation,
    fetchClaudeInfo,
    clearSessions,
    updateSessionPreview,
  };
}
