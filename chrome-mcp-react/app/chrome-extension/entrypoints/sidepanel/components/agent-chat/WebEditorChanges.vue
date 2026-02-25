<template>
  <Transition name="changes-slide">
    <div v-if="showSection" class="mb-2">
      <!-- Header Row -->
      <div class="flex items-center justify-between px-1 mb-1.5 gap-2">
        <!-- Left: Label + Summary -->
        <div class="flex items-center gap-2 min-w-0">
          <span
            class="text-[11px] font-bold uppercase tracking-wider flex-shrink-0"
            :style="headerLabelStyle"
          >
            {{ headerLabel }}
          </span>
          <span class="text-[10px] truncate" :style="headerMetaStyle">
            {{ summaryText }}
          </span>
        </div>

        <!-- Right: View Toggle (only show when there are edits) -->
        <div
          v-if="hasElements"
          class="flex items-center gap-0.5 p-0.5 flex-shrink-0"
          :style="toggleGroupStyle"
        >
          <button
            type="button"
            class="px-2 py-0.5 text-[10px] transition-colors cursor-pointer"
            :style="includeButtonStyle"
            :aria-pressed="viewMode === 'include'"
            @click="viewMode = 'include'"
          >
            Include ({{ includedCount }})
          </button>
          <button
            type="button"
            class="px-2 py-0.5 text-[10px] transition-colors cursor-pointer"
            :style="excludeButtonStyle"
            :aria-pressed="viewMode === 'exclude'"
            @click="viewMode = 'exclude'"
          >
            Exclude ({{ excludedCount }})
          </button>
        </div>
      </div>

      <!-- Chips Container -->
      <div class="flex gap-1.5 overflow-x-auto ac-scroll-hidden px-1 pb-1">
        <!-- Selection-only chip (when selected element is not in edits) -->
        <SelectionChip
          v-if="showSelectionChip"
          :selected="tx.selectedElement.value!"
          @hover:start="handleSelectionHoverStart"
          @hover:end="handleSelectionHoverEnd"
        />

        <!-- Edit chips -->
        <ElementChip
          v-for="element in visibleElements"
          :key="element.elementKey"
          :element="element"
          :excluded="isExcluded(element.elementKey)"
          :selected="isSelectedElement(element.elementKey)"
          @toggle:exclude="handleToggleExclude"
          @revert="handleRevert"
          @hover:start="handleHoverStart"
          @hover:end="handleHoverEnd"
        />

        <!-- Empty State (only when no edits and no selection) -->
        <div
          v-if="visibleElements.length === 0 && !showSelectionChip"
          class="px-2 py-1 text-[11px] italic"
          :style="emptyStateStyle"
        >
          {{ emptyStateText }}
        </div>
      </div>
    </div>
  </Transition>
</template>

<script lang="ts" setup>
import { computed, ref, watch, provide, inject, onMounted, onUnmounted, type Ref } from 'vue';
import { WEB_EDITOR_TX_STATE_INJECTION_KEY, type WebEditorTxStateReturn } from '../../composables';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type {
  ElementChangeSummary,
  ElementLocator,
  SelectedElementSummary,
  WebEditorElementKey,
  WebEditorHighlightElementPayload,
  WebEditorRevertElementPayload,
  WebEditorRevertElementResponse,
} from '@/common/web-editor-types';
import ElementChip from './ElementChip.vue';
import SelectionChip from './SelectionChip.vue';

// =============================================================================
// Inject TX State from Parent (AgentChat.vue)
// =============================================================================

/**
 * Inject the WebEditorTxState from AgentChat.vue parent.
 * This pattern prevents duplicate listener registration that would occur
 * if each component called useWebEditorTxState() independently.
 *
 * We use a helper function to ensure TypeScript understands tx is non-null after the check.
 */
function injectTxStateOrThrow(): WebEditorTxStateReturn {
  const injected = inject<WebEditorTxStateReturn>(WEB_EDITOR_TX_STATE_INJECTION_KEY);
  if (!injected) {
    throw new Error(
      '[WebEditorChanges] WebEditorTxState must be provided by parent component. ' +
        'Ensure AgentChat.vue calls useWebEditorTxState() and provides it via WEB_EDITOR_TX_STATE_INJECTION_KEY.',
    );
  }
  return injected;
}

const tx = injectTxStateOrThrow();

// =============================================================================
// Local State
// =============================================================================

/** Current view mode: show included or excluded elements */
const viewMode = ref<'include' | 'exclude'>('include');

/**
 * Scroll/resize trigger - incremented when scroll or resize events occur.
 * Provided to ElementChip children for tooltip position updates.
 */
const scrollResizeTrigger = ref(0);
provide<Ref<number>>('scrollResizeTrigger', scrollResizeTrigger);

// =============================================================================
// Computed: Counts & Elements
// =============================================================================

const hasElements = computed(() => tx.allElements.value.length > 0);
const includedCount = computed(() => tx.applicableElements.value.length);
const excludedCount = computed(() => tx.excludedElements.value.length);

/** Whether to show the section (has edits OR has selection) */
const showSection = computed(() => tx.hasContent.value);

/** Show selection-only chip when there's a selection that's not in edits */
const showSelectionChip = computed(() => tx.hasSelection.value && !tx.isSelectionInEdits.value);

/** Elements visible based on current view mode */
const visibleElements = computed(() =>
  viewMode.value === 'exclude' ? tx.excludedElements.value : tx.applicableElements.value,
);

/** Excluded keys as a Set for O(1) lookup */
const excludedKeySet = computed(() => new Set(tx.excludedKeys.value));

/** Selected element key for highlighting in edit chips */
const selectedKey = computed(() => tx.selectedElement.value?.elementKey ?? null);

// =============================================================================
// Computed: UI Text
// =============================================================================

/** Header label - changes based on whether we have edits or just selection */
const headerLabel = computed(() => {
  if (hasElements.value) {
    return 'Web Edits';
  }
  return 'Selected';
});

/**
 * Extract tagName from selection for compact display.
 */
function getSelectionTagName(sel: typeof tx.selectedElement.value): string {
  if (!sel) return '';
  if (sel.tagName) return sel.tagName.toLowerCase();
  const label = (sel.label || '').trim();
  const match = label.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  return match?.[1]?.toLowerCase() || 'element';
}

const summaryText = computed(() => {
  const sel = tx.selectedElement.value;
  const inc = includedCount.value;
  const exc = excludedCount.value;
  const selTag = getSelectionTagName(sel);

  // Selection-only mode
  if (!hasElements.value && sel) {
    return selTag;
  }

  // Edits mode with selection
  if (sel && !tx.isSelectionInEdits.value) {
    const parts = [`${selTag} selected`];
    if (inc > 0 || exc > 0) {
      parts.push(`${inc} edit${inc !== 1 ? 's' : ''}`);
    }
    return parts.join(' · ');
  }

  // Edits only
  if (exc > 0) {
    return `${inc} included · ${exc} excluded`;
  }
  return `${inc} element${inc !== 1 ? 's' : ''}`;
});

const emptyStateText = computed(() => {
  if (viewMode.value === 'exclude') {
    return 'No excluded elements.';
  }
  if (excludedCount.value > 0) {
    return 'All changes are excluded.';
  }
  return 'No changes yet.';
});

// =============================================================================
// Computed: Styles
// =============================================================================

const headerLabelStyle = computed(() => ({
  color: 'var(--ac-text-subtle)',
  fontFamily: 'var(--ac-font-mono)',
}));

const headerMetaStyle = computed(() => ({
  color: 'var(--ac-text-subtle)',
  fontFamily: 'var(--ac-font-mono)',
}));

const toggleGroupStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface)',
  border: 'var(--ac-border-width) solid var(--ac-border)',
  borderRadius: 'var(--ac-radius-button)',
}));

const includeButtonStyle = computed(() => ({
  fontFamily: 'var(--ac-font-mono)',
  borderRadius: 'var(--ac-radius-button)',
  backgroundColor: viewMode.value === 'include' ? 'var(--ac-hover-bg)' : 'transparent',
  color: viewMode.value === 'include' ? 'var(--ac-text)' : 'var(--ac-text-subtle)',
}));

const excludeButtonStyle = computed(() => ({
  fontFamily: 'var(--ac-font-mono)',
  borderRadius: 'var(--ac-radius-button)',
  backgroundColor: viewMode.value === 'exclude' ? 'var(--ac-hover-bg)' : 'transparent',
  color: viewMode.value === 'exclude' ? 'var(--ac-text)' : 'var(--ac-text-subtle)',
}));

const emptyStateStyle = computed(() => ({
  color: 'var(--ac-text-subtle)',
}));

// =============================================================================
// Watchers
// =============================================================================

/**
 * Auto-switch view mode when current view becomes empty.
 * - If viewing included but all are excluded, switch to exclude view
 * - If viewing excluded but none are excluded, switch to include view
 */
watch([includedCount, excludedCount], ([inc, exc]) => {
  if (viewMode.value === 'include' && inc === 0 && exc > 0) {
    viewMode.value = 'exclude';
  } else if (viewMode.value === 'exclude' && exc === 0 && inc > 0) {
    viewMode.value = 'include';
  }
});

// =============================================================================
// Helpers
// =============================================================================

function isExcluded(key: WebEditorElementKey): boolean {
  return excludedKeySet.value.has(key);
}

function isSelectedElement(key: WebEditorElementKey): boolean {
  return selectedKey.value === key;
}

/**
 * Extract the best selector for element highlighting.
 * Handles frame chain for cross-frame elements.
 */
function extractHighlightSelector(locator: ElementLocator): string | null {
  const selectors = locator.selectors;
  if (!selectors || selectors.length === 0) return null;

  const primary = selectors.find((s) => typeof s === 'string' && s.trim())?.trim();
  if (!primary) return null;

  const frameChain = (locator.frameChain ?? []).map((s) => String(s ?? '').trim()).filter(Boolean);

  if (frameChain.length > 0) {
    return `${frameChain.join(' |> ')} |> ${primary}`;
  }

  return primary;
}

// =============================================================================
// Highlight Logic
// =============================================================================

/** Response shape from highlight request */
interface HighlightResponse {
  success: boolean;
  error?: string;
  response?: { success: boolean; error?: string };
}

/**
 * Send highlight request via web-editor channel.
 * Returns true only if the highlight was actually successful (element found and highlighted).
 */
async function highlightViaWebEditor(
  element: ElementChangeSummary,
  mode: WebEditorHighlightElementPayload['mode'],
): Promise<boolean> {
  const tabId = tx.tabId.value;
  if (!tabId) return false;

  try {
    const payload: WebEditorHighlightElementPayload = {
      tabId,
      elementKey: element.elementKey,
      locator: element.locator,
      mode,
    };

    const result = (await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_HIGHLIGHT_ELEMENT,
      payload,
    })) as HighlightResponse | undefined;

    // Check both background success and content script success
    if (!result?.success) return false;
    if (result.response && !result.response.success) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Check if element-marker script is already injected.
 */
async function isMarkerInjected(tabId: number): Promise<boolean> {
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { action: 'element_marker_ping' }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
    ]);
    return (response as Record<string, unknown>)?.status === 'pong';
  } catch {
    return false;
  }
}

/**
 * Inject element-marker script if not already present.
 */
async function ensureMarkerInjected(tabId: number): Promise<void> {
  try {
    if (await isMarkerInjected(tabId)) return;

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['inject-scripts/element-marker.js'],
      world: 'ISOLATED',
    });
  } catch {
    // Tab might not support content scripts
  }
}

/**
 * Fallback: Highlight element via element-marker script.
 */
async function highlightViaElementMarker(element: ElementChangeSummary): Promise<void> {
  const tabId = tx.tabId.value;
  if (!tabId) return;

  const selector = extractHighlightSelector(element.locator);
  if (!selector) return;

  await ensureMarkerInjected(tabId);

  await chrome.tabs.sendMessage(tabId, {
    action: 'element_marker_highlight',
    selector,
    selectorType: 'css',
    listMode: false,
  });
}

// =============================================================================
// Event Handlers
// =============================================================================

function handleToggleExclude(elementKey: WebEditorElementKey): void {
  tx.toggleExclude(elementKey);
}

/**
 * Revert element to its original state (Phase 2 - Selective Undo).
 * Sends request to background, which relays to content script.
 */
async function handleRevert(elementKey: WebEditorElementKey): Promise<void> {
  const tabId = tx.tabId.value;
  if (!tabId) {
    console.warn('[WebEditorChanges] Cannot revert: no active tab');
    return;
  }

  try {
    const payload: WebEditorRevertElementPayload = {
      tabId,
      elementKey,
    };

    const result = (await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_REVERT_ELEMENT,
      payload,
    })) as WebEditorRevertElementResponse | undefined;

    if (!result?.success) {
      console.warn('[WebEditorChanges] Revert failed:', result?.error ?? 'Unknown error');
    }
    // Note: The TX state will auto-update via the WEB_EDITOR_TX_CHANGED broadcast
    // triggered by the compensating transaction in the content script.
  } catch (err) {
    console.error('[WebEditorChanges] Revert error:', err);
  }
}

async function handleHoverStart(element: ElementChangeSummary): Promise<void> {
  try {
    if (typeof chrome === 'undefined') return;

    // Try web-editor channel first
    const success = await highlightViaWebEditor(element, 'hover');
    if (success) return;

    // Fallback to element-marker
    await highlightViaElementMarker(element);
  } catch {
    // Silently ignore - tab might not support content scripts
  }
}

async function handleHoverEnd(element: ElementChangeSummary): Promise<void> {
  try {
    if (typeof chrome === 'undefined') return;
    await highlightViaWebEditor(element, 'clear');
  } catch {
    // Silently ignore
  }
}

/**
 * Handle hover start for selection-only chip.
 */
async function handleSelectionHoverStart(selected: SelectedElementSummary): Promise<void> {
  try {
    if (typeof chrome === 'undefined') return;

    const tabId = tx.tabId.value;
    if (!tabId) return;

    const payload: WebEditorHighlightElementPayload = {
      tabId,
      elementKey: selected.elementKey,
      locator: selected.locator,
      mode: 'hover',
    };

    await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_HIGHLIGHT_ELEMENT,
      payload,
    });
  } catch {
    // Silently ignore
  }
}

/**
 * Handle hover end for selection-only chip.
 */
async function handleSelectionHoverEnd(selected: SelectedElementSummary): Promise<void> {
  try {
    if (typeof chrome === 'undefined') return;

    const tabId = tx.tabId.value;
    if (!tabId) return;

    const payload: WebEditorHighlightElementPayload = {
      tabId,
      elementKey: selected.elementKey,
      locator: selected.locator,
      mode: 'clear',
    };

    await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_HIGHLIGHT_ELEMENT,
      payload,
    });
  } catch {
    // Silently ignore
  }
}

// =============================================================================
// Lifecycle - Global scroll/resize handlers (centralized for performance)
// =============================================================================

let scrollResizeRAF: number | null = null;

function handleScrollOrResize(): void {
  if (scrollResizeRAF !== null) {
    cancelAnimationFrame(scrollResizeRAF);
  }
  scrollResizeRAF = requestAnimationFrame(() => {
    scrollResizeTrigger.value++;
    scrollResizeRAF = null;
  });
}

onMounted(() => {
  window.addEventListener('scroll', handleScrollOrResize, { passive: true, capture: true });
  window.addEventListener('resize', handleScrollOrResize, { passive: true });
});

onUnmounted(() => {
  window.removeEventListener('scroll', handleScrollOrResize, true);
  window.removeEventListener('resize', handleScrollOrResize);
  if (scrollResizeRAF !== null) {
    cancelAnimationFrame(scrollResizeRAF);
  }
});
</script>

<style scoped>
.changes-slide-enter-active,
.changes-slide-leave-active {
  transition: all 0.2s ease;
}

.changes-slide-enter-from,
.changes-slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.changes-slide-enter-to,
.changes-slide-leave-from {
  opacity: 1;
  transform: translateY(0);
}
</style>
