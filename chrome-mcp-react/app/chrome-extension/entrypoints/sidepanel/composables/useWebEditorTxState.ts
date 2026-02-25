/**
 * Composable for managing Web Editor TX (Transaction) state in Sidepanel.
 *
 * Responsibilities:
 * - Listen to WEB_EDITOR_TX_CHANGED messages from background
 * - Persist and recover state from chrome.storage.session
 * - Manage excluded element keys for selective Apply
 * - Provide reactive state for AgentChat chips UI
 *
 * Architecture:
 * - The composable should be initialized ONCE at the AgentChat.vue level
 * - It is then provided via Vue's provide/inject to child components
 * - This prevents duplicate event listener registration
 */
import { computed, onMounted, onUnmounted, ref, type InjectionKey } from 'vue';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type {
  ElementChangeSummary,
  SelectedElementSummary,
  WebEditorElementKey,
  WebEditorSelectionChangedPayload,
  WebEditorTxChangedPayload,
  WebEditorTxChangeAction,
} from '@/common/web-editor-types';

// =============================================================================
// Constants
// =============================================================================

const WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX = 'web-editor-v2-tx-changed-';
const WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX = 'web-editor-v2-excluded-keys-';
const WEB_EDITOR_SELECTION_SESSION_KEY_PREFIX = 'web-editor-v2-selection-';

const VALID_TX_ACTIONS = new Set<WebEditorTxChangeAction>([
  'push',
  'merge',
  'undo',
  'redo',
  'clear',
  'rollback',
]);

// =============================================================================
// Internal Helpers
// =============================================================================

function isValidTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function buildTxSessionKey(tabId: number): string {
  return `${WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX}${tabId}`;
}

function buildExcludedKeysSessionKey(tabId: number): string {
  return `${WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX}${tabId}`;
}

function buildSelectionSessionKey(tabId: number): string {
  return `${WEB_EDITOR_SELECTION_SESSION_KEY_PREFIX}${tabId}`;
}

/**
 * Normalize and validate selection changed payload from storage or message.
 * Returns null if the payload is invalid.
 */
function normalizeSelectionPayload(raw: unknown): WebEditorSelectionChangedPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const tabId = Number(obj.tabId);
  if (!Number.isFinite(tabId) || tabId <= 0) return null;

  // Selected can be null (deselection) or an object
  const selectedRaw = obj.selected;
  let selected: SelectedElementSummary | null = null;

  if (selectedRaw && typeof selectedRaw === 'object') {
    const sel = selectedRaw as Record<string, unknown>;
    const elementKey = typeof sel.elementKey === 'string' ? sel.elementKey.trim() : '';
    if (!elementKey) return null; // Invalid selection

    selected = {
      elementKey,
      locator: sel.locator as SelectedElementSummary['locator'],
      label: typeof sel.label === 'string' ? sel.label : '',
      fullLabel: typeof sel.fullLabel === 'string' ? sel.fullLabel : '',
      tagName: typeof sel.tagName === 'string' ? sel.tagName : '',
      updatedAt: typeof sel.updatedAt === 'number' ? sel.updatedAt : Date.now(),
    };
  }

  return {
    tabId,
    selected,
    pageUrl: typeof obj.pageUrl === 'string' ? obj.pageUrl : undefined,
  };
}

/**
 * Normalize and validate TX changed payload from storage or message.
 * Returns null if the payload is invalid.
 */
function normalizeTxChangedPayload(raw: unknown): WebEditorTxChangedPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const tabId = Number(obj.tabId);
  if (!Number.isFinite(tabId) || tabId <= 0) return null;

  const actionRaw = typeof obj.action === 'string' ? obj.action : '';
  if (!VALID_TX_ACTIONS.has(actionRaw as WebEditorTxChangeAction)) return null;
  const action = actionRaw as WebEditorTxChangeAction;

  // Filter elements to ensure minimal validity (elementKey must be a non-empty string)
  const rawElements = Array.isArray(obj.elements) ? obj.elements : [];
  const elements = rawElements.filter(
    (e): e is ElementChangeSummary =>
      e &&
      typeof e === 'object' &&
      typeof (e as any).elementKey === 'string' &&
      (e as any).elementKey,
  );

  const undoCountRaw = Number(obj.undoCount);
  const redoCountRaw = Number(obj.redoCount);
  const undoCount = Number.isFinite(undoCountRaw) && undoCountRaw >= 0 ? undoCountRaw : 0;
  const redoCount = Number.isFinite(redoCountRaw) && redoCountRaw >= 0 ? redoCountRaw : 0;

  const hasApplicableChanges = Boolean(obj.hasApplicableChanges);
  const pageUrl = typeof obj.pageUrl === 'string' ? obj.pageUrl : undefined;

  return {
    tabId,
    action,
    elements,
    undoCount,
    redoCount,
    hasApplicableChanges,
    pageUrl,
  };
}

/**
 * Normalize and deduplicate excluded keys array from storage.
 * Filters out invalid entries and removes duplicates.
 */
function normalizeExcludedKeys(raw: unknown): WebEditorElementKey[] {
  if (!Array.isArray(raw)) return [];

  const result: WebEditorElementKey[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const key = String(item ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }

  return result;
}

/**
 * Persist excluded keys to session storage (per-tab).
 * Best-effort: silently ignores failures.
 */
async function persistExcludedKeys(
  tabId: number,
  keys: readonly WebEditorElementKey[],
): Promise<void> {
  if (!isValidTabId(tabId)) return;

  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.session?.set) return;
    const storageKey = buildExcludedKeysSessionKey(tabId);
    await chrome.storage.session.set({ [storageKey]: [...keys] });
  } catch (error) {
    console.error('[useWebEditorTxState] Failed to persist excluded keys:', error);
  }
}

/**
 * Default implementation for getting active tab ID.
 */
async function getActiveTabIdDefault(): Promise<number | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) return null;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    return typeof tabId === 'number' ? tabId : null;
  } catch {
    return null;
  }
}

/**
 * Get current window ID for filtering tab activation events.
 * This prevents processing tab switches from other Chrome windows.
 */
async function getCurrentWindowId(): Promise<number | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome.windows?.getCurrent) return null;
    const win = await chrome.windows.getCurrent();
    return typeof win?.id === 'number' ? win.id : null;
  } catch {
    return null;
  }
}

// =============================================================================
// Public API
// =============================================================================

export interface UseWebEditorTxStateOptions {
  /**
   * Optional override for resolving the "current tab" in sidepanel.
   * Defaults to chrome.tabs.query({ active: true, currentWindow: true }).
   */
  getActiveTabId?: () => Promise<number | null>;
  /**
   * If provided, skips querying the active tab on mount.
   */
  initialTabId?: number | null;
}

export function useWebEditorTxState(options: UseWebEditorTxStateOptions = {}) {
  // ==========================================================================
  // State
  // ==========================================================================

  /** Current tab ID being tracked */
  const tabId = ref<number | null>(
    isValidTabId(options.initialTabId) ? options.initialTabId : null,
  );

  /** Current TX state from web-editor */
  const txState = ref<WebEditorTxChangedPayload | null>(null);

  /** Currently selected element (for context, may not have edits) */
  const selectedElement = ref<SelectedElementSummary | null>(null);

  /** Page URL from selection (may differ from txState.pageUrl if selection is newer) */
  const selectionPageUrl = ref<string | null>(null);

  /** Excluded element keys (user-deselected elements) */
  const excludedKeys = ref<WebEditorElementKey[]>([]);

  // ==========================================================================
  // Computed
  // ==========================================================================

  /** All elements from TX state */
  const allElements = computed<ElementChangeSummary[]>(() => txState.value?.elements ?? []);

  /** Set of excluded keys for O(1) lookup */
  const excludedKeySet = computed(() => new Set(excludedKeys.value));

  /** Elements that will be applied (not excluded) */
  const applicableElements = computed<ElementChangeSummary[]>(() => {
    const set = excludedKeySet.value;
    return allElements.value.filter((e) => !set.has(e.elementKey));
  });

  /** Elements that are excluded by user */
  const excludedElements = computed<ElementChangeSummary[]>(() => {
    const set = excludedKeySet.value;
    return allElements.value.filter((e) => set.has(e.elementKey));
  });

  /** Whether there are applicable changes to send to Agent */
  const hasChanges = computed<boolean>(() => applicableElements.value.length > 0);

  /** Whether there is a selected element */
  const hasSelection = computed<boolean>(() => selectedElement.value !== null);

  /**
   * Whether the selected element is also in the edits list.
   * Used to decide if we need a separate "selection-only" chip.
   */
  const isSelectionInEdits = computed<boolean>(() => {
    const sel = selectedElement.value;
    if (!sel) return false;
    return allElements.value.some((e) => e.elementKey === sel.elementKey);
  });

  /** Whether to show the web editor section (has edits OR has selection) */
  const hasContent = computed<boolean>(
    () => hasChanges.value || hasSelection.value || allElements.value.length > 0,
  );

  // ==========================================================================
  // Actions
  // ==========================================================================

  /**
   * Toggle an element's excluded state.
   * Automatically persists to session storage.
   */
  function toggleExclude(elementKey: WebEditorElementKey): void {
    const key = String(elementKey ?? '').trim();
    if (!key) return;

    const current = excludedKeys.value;
    const idx = current.indexOf(key);
    if (idx >= 0) {
      // Remove from excluded list
      excludedKeys.value = [...current.slice(0, idx), ...current.slice(idx + 1)];
    } else {
      // Add to excluded list
      excludedKeys.value = [...current, key];
    }

    // Persist to session storage
    if (isValidTabId(tabId.value)) {
      void persistExcludedKeys(tabId.value, excludedKeys.value);
    }
  }

  /**
   * Clear all excluded elements.
   * Automatically persists to session storage.
   */
  function clearExcluded(): void {
    excludedKeys.value = [];

    // Persist to session storage
    if (isValidTabId(tabId.value)) {
      void persistExcludedKeys(tabId.value, excludedKeys.value);
    }
  }

  /**
   * Remove excluded keys that no longer exist in the current TX state.
   * This prevents stale keys when elements are undone/cleared.
   */
  function pruneStaleExcludedKeys(elements: readonly ElementChangeSummary[] | null): void {
    if (!elements || !isValidTabId(tabId.value)) return;

    const validKeys = new Set(elements.map((e) => e.elementKey));
    const prunedKeys = excludedKeys.value.filter((k) => validKeys.has(k));

    // Only update if there are stale keys to remove
    if (prunedKeys.length === excludedKeys.value.length) return;

    excludedKeys.value = prunedKeys;
    void persistExcludedKeys(tabId.value, prunedKeys);
  }

  /** Sequence counter to prevent stale async updates */
  let refreshSeq = 0;

  /**
   * Refresh TX state from session storage for a specific tab.
   * Also restores excluded keys from storage.
   * On tab change, immediately clears state to prevent cross-tab pollution.
   */
  async function refreshFromStorage(targetTabId: number): Promise<void> {
    if (!isValidTabId(targetTabId)) {
      tabId.value = null;
      txState.value = null;
      excludedKeys.value = [];
      selectedElement.value = null;
      selectionPageUrl.value = null;
      return;
    }

    // On tab change, immediately clear state to prevent UI showing stale data
    const isTabChange = tabId.value !== targetTabId;
    if (isTabChange) {
      txState.value = null;
      excludedKeys.value = [];
      selectedElement.value = null;
      selectionPageUrl.value = null;
    }
    tabId.value = targetTabId;

    const seq = ++refreshSeq;
    const txKey = buildTxSessionKey(targetTabId);
    const excludedKey = buildExcludedKeysSessionKey(targetTabId);
    const selectionKey = buildSelectionSessionKey(targetTabId);

    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.session?.get) {
        txState.value = null;
        excludedKeys.value = [];
        selectedElement.value = null;
        selectionPageUrl.value = null;
        return;
      }

      // Fetch TX state, excluded keys, and selection in one call
      const result = (await chrome.storage.session.get([
        txKey,
        excludedKey,
        selectionKey,
      ])) as Record<string, unknown>;

      // Check for stale async response
      if (seq !== refreshSeq) return;

      // Update TX state
      const nextTxState = normalizeTxChangedPayload(result?.[txKey]);
      txState.value = nextTxState;

      // Restore excluded keys from storage
      excludedKeys.value = normalizeExcludedKeys(result?.[excludedKey]);

      // Restore selection from storage
      const nextSelection = normalizeSelectionPayload(result?.[selectionKey]);
      selectedElement.value = nextSelection?.selected ?? null;
      selectionPageUrl.value = nextSelection?.pageUrl ?? null;

      // Prune stale excluded keys based on current elements
      pruneStaleExcludedKeys(nextTxState?.elements ?? null);
    } catch (error) {
      console.error('[useWebEditorTxState] Failed to refresh from session storage:', error);
      // On error, ensure clean state to prevent showing stale data
      txState.value = null;
      excludedKeys.value = [];
      selectedElement.value = null;
      selectionPageUrl.value = null;
    }
  }

  // ==========================================================================
  // Message Listeners
  // ==========================================================================

  /**
   * Handle runtime messages from background.
   */
  const onRuntimeMessage = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    _sendResponse: (response?: unknown) => void,
  ): void => {
    const msg =
      message && typeof message === 'object' ? (message as Record<string, unknown>) : null;
    if (!msg) return;

    // Handle TX changed messages
    if (msg.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED) {
      const next = normalizeTxChangedPayload(msg.payload);
      if (!next) return;

      // Only process messages for the current tab
      if (!isValidTabId(tabId.value)) return;
      if (next.tabId !== tabId.value) return;

      txState.value = next;

      // Prune excluded keys that no longer exist (e.g., after undo/clear)
      pruneStaleExcludedKeys(next.elements);
      return;
    }

    // Handle selection changed messages
    if (msg.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED) {
      const next = normalizeSelectionPayload(msg.payload);
      if (!next) return;

      // Only process messages for the current tab
      if (!isValidTabId(tabId.value)) return;
      if (next.tabId !== tabId.value) return;

      selectedElement.value = next.selected;
      // Store pageUrl from selection for context building
      selectionPageUrl.value = next.pageUrl ?? null;
      return;
    }
  };

  /**
   * Handle session storage changes (fallback for cold start).
   * Only handles TX state changes; excluded keys are managed explicitly.
   */
  const onSessionChanged = (changes: { [key: string]: chrome.storage.StorageChange }): void => {
    if (!isValidTabId(tabId.value)) return;
    const txKey = buildTxSessionKey(tabId.value);

    const change = changes?.[txKey];
    if (!change) return;

    if (change.newValue === undefined) {
      txState.value = null;
      // Clear excluded keys when TX state is cleared
      pruneStaleExcludedKeys([]);
      return;
    }

    const next = normalizeTxChangedPayload(change.newValue);
    txState.value = next;

    // Prune stale excluded keys
    pruneStaleExcludedKeys(next?.elements ?? []);
  };

  /** Cleanup function for storage listener */
  let removeStorageListener: (() => void) | null = null;

  /** Cleanup function for tab activated listener */
  let removeTabActivatedListener: (() => void) | null = null;

  /** Cached window ID to filter tab activation events from other windows */
  let currentWindowId: number | null = null;

  /**
   * Handle tab activation events.
   * Updates tabId and loads TX state when user switches to a different tab.
   *
   * Note: currentWindowId filtering is best-effort. If getCurrentWindowId() fails,
   * events from all windows will be processed (acceptable fallback behavior).
   */
  const onTabActivated = (activeInfo: chrome.tabs.TabActiveInfo): void => {
    try {
      // Ignore events from other windows (best-effort filter)
      if (currentWindowId !== null && activeInfo.windowId !== currentWindowId) return;

      const nextTabId = activeInfo.tabId;
      if (!isValidTabId(nextTabId)) return;

      // Skip if already tracking this tab
      if (nextTabId === tabId.value) return;

      // Load TX state for the newly activated tab
      void refreshFromStorage(nextTabId);
    } catch (error) {
      console.error('[useWebEditorTxState] Failed to handle tab activation:', error);
    }
  };

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  onMounted(async () => {
    // Register runtime message listener
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
        chrome.runtime.onMessage.addListener(onRuntimeMessage);
      }
    } catch (error) {
      console.error('Failed to register WebEditor TX runtime listener:', error);
    }

    // Register session storage listener
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session?.onChanged?.addListener) {
        // Prefer session-specific listener if available
        chrome.storage.session.onChanged.addListener(onSessionChanged);
        removeStorageListener = () => {
          try {
            chrome.storage.session.onChanged.removeListener(onSessionChanged);
          } catch {}
        };
      } else if (typeof chrome !== 'undefined' && chrome.storage?.onChanged?.addListener) {
        // Fallback to generic storage listener with area filter
        const onChanged = (
          changes: { [key: string]: chrome.storage.StorageChange },
          areaName: chrome.storage.AreaName,
        ) => {
          if (areaName !== 'session') return;
          onSessionChanged(changes);
        };

        chrome.storage.onChanged.addListener(onChanged);
        removeStorageListener = () => {
          try {
            chrome.storage.onChanged.removeListener(onChanged);
          } catch {}
        };
      }
    } catch (error) {
      console.error('Failed to register WebEditor TX storage listener:', error);
    }

    // Cache current window ID for filtering tab activation events
    currentWindowId = await getCurrentWindowId();

    // Register tab activation listener to track tab switches
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs?.onActivated?.addListener) {
        chrome.tabs.onActivated.addListener(onTabActivated);
        removeTabActivatedListener = () => {
          try {
            chrome.tabs.onActivated.removeListener(onTabActivated);
          } catch {}
        };
      }
    } catch (error) {
      console.error('[useWebEditorTxState] Failed to register tab activation listener:', error);
    }

    // Initialize tab ID if not provided
    const getActiveTabId = options.getActiveTabId ?? getActiveTabIdDefault;

    if (!isValidTabId(tabId.value)) {
      const active = await getActiveTabId().catch(() => null);
      if (isValidTabId(active)) {
        tabId.value = active;
      }
    }

    // Load initial state from storage
    if (isValidTabId(tabId.value)) {
      await refreshFromStorage(tabId.value);
    }
  });

  onUnmounted(() => {
    // Clean up runtime message listener
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.removeListener) {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      }
    } catch {}

    // Clean up storage listener
    removeStorageListener?.();
    removeStorageListener = null;

    // Clean up tab activation listener
    removeTabActivatedListener?.();
    removeTabActivatedListener = null;
  });

  // ==========================================================================
  // Return
  // ==========================================================================

  return {
    // State
    tabId,
    txState,
    excludedKeys,
    selectedElement,
    selectionPageUrl,

    // UI State (computed)
    allElements,
    hasChanges,
    hasSelection,
    isSelectionInEdits,
    hasContent,
    applicableElements,
    excludedElements,

    // Actions
    toggleExclude,
    clearExcluded,
    refreshFromStorage,
  };
}

// =============================================================================
// Type Exports & Injection Key
// =============================================================================

/**
 * Return type of useWebEditorTxState composable.
 * Used for type-safe provide/inject.
 */
export type WebEditorTxStateReturn = ReturnType<typeof useWebEditorTxState>;

/**
 * Injection key for providing WebEditorTxState to child components.
 * Use this with Vue's provide/inject pattern to avoid duplicate listener registration.
 *
 * @example
 * // In AgentChat.vue (parent)
 * const webEditorTx = useWebEditorTxState();
 * provide(WEB_EDITOR_TX_STATE_INJECTION_KEY, webEditorTx);
 *
 * // In WebEditorChanges.vue (child)
 * const tx = inject(WEB_EDITOR_TX_STATE_INJECTION_KEY);
 */
export const WEB_EDITOR_TX_STATE_INJECTION_KEY: InjectionKey<WebEditorTxStateReturn> =
  Symbol('web-editor-tx-state');
