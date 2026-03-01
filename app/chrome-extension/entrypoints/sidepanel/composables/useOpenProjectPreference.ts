/**
 * Composable for managing user preference for opening project directory.
 * Stores the default target (vscode/terminal) in chrome.storage.local.
 */
import { ref, type Ref } from '@/entrypoints/shared/reactivity';
import type { OpenProjectTarget, OpenProjectResponse } from 'webpage-mcp-shared';
import { requestAgentRpcJson } from '@/utils/agent-rpc';

// Storage key for default open target
const STORAGE_KEY = 'agent-open-project-default';

export interface UseOpenProjectPreferenceOptions {
  ensureServer: () => Promise<boolean>;
}

export interface UseOpenProjectPreference {
  /** Current default target (null if not set) */
  defaultTarget: Ref<OpenProjectTarget | null>;
  /** Loading state */
  loading: Ref<boolean>;
  /** Load default target from storage */
  loadDefaultTarget: () => Promise<void>;
  /** Save default target to storage */
  saveDefaultTarget: (target: OpenProjectTarget) => Promise<void>;
  /** Open project by session ID */
  openBySession: (sessionId: string, target: OpenProjectTarget) => Promise<OpenProjectResponse>;
  /** Open project by project ID */
  openByProject: (projectId: string, target: OpenProjectTarget) => Promise<OpenProjectResponse>;
}

export function useOpenProjectPreference(
  options: UseOpenProjectPreferenceOptions,
): UseOpenProjectPreference {
  const defaultTarget = ref<OpenProjectTarget | null>(null);
  const loading = ref(false);

  /**
   * Load default target from chrome.storage.local.
   */
  async function loadDefaultTarget(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const stored = result[STORAGE_KEY];
      if (stored === 'vscode' || stored === 'terminal') {
        defaultTarget.value = stored;
      }
    } catch (error) {
      console.error('[OpenProjectPreference] Failed to load default target:', error);
    }
  }

  /**
   * Save default target to chrome.storage.local.
   */
  async function saveDefaultTarget(target: OpenProjectTarget): Promise<void> {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: target });
      defaultTarget.value = target;
    } catch (error) {
      console.error('[OpenProjectPreference] Failed to save default target:', error);
    }
  }

  /**
   * Open project directory by session ID.
   */
  async function openBySession(
    sessionId: string,
    target: OpenProjectTarget,
  ): Promise<OpenProjectResponse> {
    const ready = await options.ensureServer();
    if (!ready) {
      return { success: false, error: 'Server not connected' };
    }

    loading.value = true;
    try {
      return await requestAgentRpcJson<OpenProjectResponse>({
        operation: 'agent.sessions.open',
        params: { sessionId },
        body: { target },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    } finally {
      loading.value = false;
    }
  }

  /**
   * Open project directory by project ID.
   */
  async function openByProject(
    projectId: string,
    target: OpenProjectTarget,
  ): Promise<OpenProjectResponse> {
    const ready = await options.ensureServer();
    if (!ready) {
      return { success: false, error: 'Server not connected' };
    }

    loading.value = true;
    try {
      return await requestAgentRpcJson<OpenProjectResponse>({
        operation: 'agent.projects.open',
        params: { projectId },
        body: { target },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    } finally {
      loading.value = false;
    }
  }

  return {
    defaultTarget,
    loading,
    loadDefaultTarget,
    saveDefaultTarget,
    openBySession,
    openByProject,
  };
}
