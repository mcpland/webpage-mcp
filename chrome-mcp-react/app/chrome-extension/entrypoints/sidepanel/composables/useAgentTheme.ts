/**
 * Composable for managing AgentChat theme.
 * Handles theme persistence and application.
 */
import { ref, type Ref } from 'vue';

/** Available theme identifiers */
export type AgentThemeId =
  | 'warm-editorial'
  | 'blueprint-architect'
  | 'zen-journal'
  | 'neo-pop'
  | 'dark-console'
  | 'swiss-grid';

/** Storage key for persisting theme preference */
const STORAGE_KEY_THEME = 'agentTheme';

/** Default theme when none is set */
const DEFAULT_THEME: AgentThemeId = 'warm-editorial';

/** Valid theme IDs for validation */
const VALID_THEMES: AgentThemeId[] = [
  'warm-editorial',
  'blueprint-architect',
  'zen-journal',
  'neo-pop',
  'dark-console',
  'swiss-grid',
];

/** Theme display names for UI */
export const THEME_LABELS: Record<AgentThemeId, string> = {
  'warm-editorial': 'Editorial',
  'blueprint-architect': 'Blueprint',
  'zen-journal': 'Zen',
  'neo-pop': 'Neo-Pop',
  'dark-console': 'Console',
  'swiss-grid': 'Swiss',
};

export interface UseAgentTheme {
  /** Current theme ID */
  theme: Ref<AgentThemeId>;
  /** Whether theme has been loaded from storage */
  ready: Ref<boolean>;
  /** Set and persist a new theme */
  setTheme: (id: AgentThemeId) => Promise<void>;
  /** Load theme from storage (call on mount) */
  initTheme: () => Promise<void>;
  /** Apply theme to a DOM element */
  applyTo: (el: HTMLElement) => void;
  /** Get the preloaded theme from document (set by main.ts) */
  getPreloadedTheme: () => AgentThemeId;
}

/**
 * Check if a string is a valid theme ID
 */
function isValidTheme(value: unknown): value is AgentThemeId {
  return typeof value === 'string' && VALID_THEMES.includes(value as AgentThemeId);
}

/**
 * Get theme from document element (preloaded by main.ts)
 */
function getThemeFromDocument(): AgentThemeId {
  const value = document.documentElement.dataset.agentTheme;
  return isValidTheme(value) ? value : DEFAULT_THEME;
}

/**
 * Composable for managing AgentChat theme
 */
export function useAgentTheme(): UseAgentTheme {
  // Initialize with preloaded theme (or default)
  const theme = ref<AgentThemeId>(getThemeFromDocument());
  const ready = ref(false);

  /**
   * Load theme from chrome.storage.local
   */
  async function initTheme(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_THEME);
      const stored = result[STORAGE_KEY_THEME];

      if (isValidTheme(stored)) {
        theme.value = stored;
      } else {
        // Use preloaded or default
        theme.value = getThemeFromDocument();
      }
    } catch (error) {
      console.error('[useAgentTheme] Failed to load theme:', error);
      theme.value = getThemeFromDocument();
    } finally {
      ready.value = true;
    }
  }

  /**
   * Set and persist a new theme
   */
  async function setTheme(id: AgentThemeId): Promise<void> {
    if (!isValidTheme(id)) {
      console.warn('[useAgentTheme] Invalid theme ID:', id);
      return;
    }

    // Update immediately for responsive UI
    theme.value = id;

    // Also update document element for consistency
    document.documentElement.dataset.agentTheme = id;

    // Persist to storage
    try {
      await chrome.storage.local.set({ [STORAGE_KEY_THEME]: id });
    } catch (error) {
      console.error('[useAgentTheme] Failed to save theme:', error);
    }
  }

  /**
   * Apply theme to a DOM element
   */
  function applyTo(el: HTMLElement): void {
    el.dataset.agentTheme = theme.value;
  }

  /**
   * Get the preloaded theme from document
   */
  function getPreloadedTheme(): AgentThemeId {
    return getThemeFromDocument();
  }

  return {
    theme,
    ready,
    setTheme,
    initTheme,
    applyTo,
    getPreloadedTheme,
  };
}

/**
 * Preload theme before Vue mounts (call in main.ts)
 * This prevents theme flashing on page load.
 */
export async function preloadAgentTheme(): Promise<AgentThemeId> {
  let themeId: AgentThemeId = DEFAULT_THEME;

  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_THEME);
    const stored = result[STORAGE_KEY_THEME];

    if (isValidTheme(stored)) {
      themeId = stored;
    }
  } catch (error) {
    console.error('[preloadAgentTheme] Failed to load theme:', error);
  }

  // Set on document element for immediate application
  document.documentElement.dataset.agentTheme = themeId;

  return themeId;
}
