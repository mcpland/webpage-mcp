/**
 * Composable for user-facing input preferences in AgentChat.
 * Preferences are persisted in chrome.storage.local.
 */
import { ref, type Ref } from 'vue';

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_FAKE_CARET = 'agent-chat-fake-caret-enabled';

// =============================================================================
// Types
// =============================================================================

export interface UseAgentInputPreferences {
  /** Whether the fake caret + comet trail is enabled (opt-in). Default: false */
  fakeCaretEnabled: Ref<boolean>;
  /** Whether preferences have been loaded from storage */
  ready: Ref<boolean>;
  /** Load preferences from chrome.storage.local (call on mount) */
  init: () => Promise<void>;
  /** Persist and update fake caret preference */
  setFakeCaretEnabled: (enabled: boolean) => Promise<void>;
}

// =============================================================================
// Composable
// =============================================================================

/**
 * Composable for managing user input preferences.
 *
 * Features:
 * - Fake caret toggle (opt-in, default off)
 * - Persistence via chrome.storage.local
 * - Graceful fallback when storage is unavailable
 */
export function useAgentInputPreferences(): UseAgentInputPreferences {
  const fakeCaretEnabled = ref(false);
  const ready = ref(false);

  /**
   * Load preferences from chrome.storage.local.
   * Should be called during component mount.
   */
  async function init(): Promise<void> {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        ready.value = true;
        return;
      }

      const result = await chrome.storage.local.get(STORAGE_KEY_FAKE_CARET);
      const stored = result[STORAGE_KEY_FAKE_CARET];

      if (typeof stored === 'boolean') {
        fakeCaretEnabled.value = stored;
      }
    } catch (error) {
      console.error('[useAgentInputPreferences] Failed to load preferences:', error);
    } finally {
      ready.value = true;
    }
  }

  /**
   * Update and persist the fake caret preference.
   */
  async function setFakeCaretEnabled(enabled: boolean): Promise<void> {
    fakeCaretEnabled.value = enabled;

    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
      await chrome.storage.local.set({ [STORAGE_KEY_FAKE_CARET]: enabled });
    } catch (error) {
      console.error('[useAgentInputPreferences] Failed to save fake caret preference:', error);
    }
  }

  return {
    fakeCaretEnabled,
    ready,
    init,
    setFakeCaretEnabled,
  };
}
