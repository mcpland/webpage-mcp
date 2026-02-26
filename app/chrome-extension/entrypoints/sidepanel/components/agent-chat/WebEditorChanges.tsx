import { useEffect, useMemo, useState } from 'react';
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
import type { WebEditorTxStateReturn } from '../../composables';
import ElementChip from './ElementChip';
import SelectionChip from './SelectionChip';

type WebEditorChangesProps = {
  txState: WebEditorTxStateReturn;
};

interface HighlightResponse {
  success: boolean;
  error?: string;
  response?: { success: boolean; error?: string };
}

function getSelectionTagName(sel: SelectedElementSummary | null): string {
  if (!sel) return '';
  if (sel.tagName) return sel.tagName.toLowerCase();
  const label = (sel.label || '').trim();
  const match = label.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  return match?.[1]?.toLowerCase() || 'element';
}

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

export default function WebEditorChanges({ txState: tx }: WebEditorChangesProps) {
  const [viewMode, setViewMode] = useState<'include' | 'exclude'>('include');
  const [scrollResizeTrigger, setScrollResizeTrigger] = useState(0);

  const hasElements = tx.allElements.value.length > 0;
  const includedCount = tx.applicableElements.value.length;
  const excludedCount = tx.excludedElements.value.length;
  const showSection = tx.hasContent.value;
  const showSelectionChip = tx.hasSelection.value && !tx.isSelectionInEdits.value;
  const visibleElements = viewMode === 'exclude' ? tx.excludedElements.value : tx.applicableElements.value;
  const excludedKeySet = useMemo(() => new Set(tx.excludedKeys.value), [tx.excludedKeys.value]);
  const selectedKey = tx.selectedElement.value?.elementKey ?? null;

  useEffect(() => {
    if (viewMode === 'include' && includedCount === 0 && excludedCount > 0) {
      setViewMode('exclude');
    } else if (viewMode === 'exclude' && excludedCount === 0 && includedCount > 0) {
      setViewMode('include');
    }
  }, [viewMode, includedCount, excludedCount]);

  useEffect(() => {
    let raf: number | null = null;

    const handleScrollOrResize = (): void => {
      if (raf !== null) {
        cancelAnimationFrame(raf);
      }
      raf = requestAnimationFrame(() => {
        setScrollResizeTrigger((prev) => prev + 1);
        raf = null;
      });
    };

    window.addEventListener('scroll', handleScrollOrResize, { passive: true, capture: true });
    window.addEventListener('resize', handleScrollOrResize, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
      if (raf !== null) {
        cancelAnimationFrame(raf);
      }
    };
  }, []);

  const headerLabel = hasElements ? 'Web Edits' : 'Selected';

  const summaryText = useMemo(() => {
    const sel = tx.selectedElement.value;
    const selTag = getSelectionTagName(sel);

    if (!hasElements && sel) {
      return selTag;
    }

    if (sel && !tx.isSelectionInEdits.value) {
      const parts = [`${selTag} selected`];
      if (includedCount > 0 || excludedCount > 0) {
        parts.push(`${includedCount} edit${includedCount !== 1 ? 's' : ''}`);
      }
      return parts.join(' | ');
    }

    if (excludedCount > 0) {
      return `${includedCount} included | ${excludedCount} excluded`;
    }

    return `${includedCount} element${includedCount !== 1 ? 's' : ''}`;
  }, [tx.selectedElement.value, tx.isSelectionInEdits.value, hasElements, includedCount, excludedCount]);

  const emptyStateText =
    viewMode === 'exclude'
      ? 'No excluded elements.'
      : excludedCount > 0
        ? 'All changes are excluded.'
        : 'No changes yet.';

  function isExcluded(key: WebEditorElementKey): boolean {
    return excludedKeySet.has(key);
  }

  function isSelectedElement(key: WebEditorElementKey): boolean {
    return selectedKey === key;
  }

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

      if (!result?.success) return false;
      if (result.response && !result.response.success) return false;
      return true;
    } catch {
      return false;
    }
  }

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

  async function ensureMarkerInjected(tabId: number): Promise<void> {
    try {
      if (await isMarkerInjected(tabId)) return;

      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['inject-scripts/element-marker.js'],
        world: 'ISOLATED',
      });
    } catch {
      return;
    }
  }

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

  async function handleRevert(elementKey: WebEditorElementKey): Promise<void> {
    const tabId = tx.tabId.value;
    if (!tabId) {
      console.warn('[WebEditorChanges] Cannot revert: no active tab');
      return;
    }

    try {
      const payload: WebEditorRevertElementPayload = { tabId, elementKey };
      const result = (await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_REVERT_ELEMENT,
        payload,
      })) as WebEditorRevertElementResponse | undefined;

      if (!result?.success) {
        console.warn('[WebEditorChanges] Revert failed:', result?.error ?? 'Unknown error');
      }
    } catch (error) {
      console.error('[WebEditorChanges] Revert error:', error);
    }
  }

  async function handleHoverStart(element: ElementChangeSummary): Promise<void> {
    try {
      if (typeof chrome === 'undefined') return;

      const success = await highlightViaWebEditor(element, 'hover');
      if (success) return;

      await highlightViaElementMarker(element);
    } catch {
      return;
    }
  }

  async function handleHoverEnd(element: ElementChangeSummary): Promise<void> {
    try {
      if (typeof chrome === 'undefined') return;
      await highlightViaWebEditor(element, 'clear');
    } catch {
      return;
    }
  }

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
      return;
    }
  }

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
      return;
    }
  }

  if (!showSection) {
    return null;
  }

  return (
    <div className="mb-2">
      <div className="flex items-center justify-between px-1 mb-1.5 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-[11px] font-bold uppercase tracking-wider flex-shrink-0"
            style={{ color: 'var(--ac-text-subtle)', fontFamily: 'var(--ac-font-mono)' }}
          >
            {headerLabel}
          </span>
          <span className="text-[10px] truncate" style={{ color: 'var(--ac-text-subtle)', fontFamily: 'var(--ac-font-mono)' }}>
            {summaryText}
          </span>
        </div>

        {hasElements ? (
          <div
            className="flex items-center gap-0.5 p-0.5 flex-shrink-0"
            style={{
              backgroundColor: 'var(--ac-surface)',
              border: 'var(--ac-border-width) solid var(--ac-border)',
              borderRadius: 'var(--ac-radius-button)',
            }}
          >
            <button
              type="button"
              className="px-2 py-0.5 text-[10px] transition-colors cursor-pointer"
              style={{
                fontFamily: 'var(--ac-font-mono)',
                borderRadius: 'var(--ac-radius-button)',
                backgroundColor: viewMode === 'include' ? 'var(--ac-hover-bg)' : 'transparent',
                color: viewMode === 'include' ? 'var(--ac-text)' : 'var(--ac-text-subtle)',
              }}
              aria-pressed={viewMode === 'include'}
              onClick={() => setViewMode('include')}
            >
              Include ({includedCount})
            </button>
            <button
              type="button"
              className="px-2 py-0.5 text-[10px] transition-colors cursor-pointer"
              style={{
                fontFamily: 'var(--ac-font-mono)',
                borderRadius: 'var(--ac-radius-button)',
                backgroundColor: viewMode === 'exclude' ? 'var(--ac-hover-bg)' : 'transparent',
                color: viewMode === 'exclude' ? 'var(--ac-text)' : 'var(--ac-text-subtle)',
              }}
              aria-pressed={viewMode === 'exclude'}
              onClick={() => setViewMode('exclude')}
            >
              Exclude ({excludedCount})
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex gap-1.5 overflow-x-auto ac-scroll-hidden px-1 pb-1">
        {showSelectionChip && tx.selectedElement.value ? (
          <SelectionChip
            selected={tx.selectedElement.value}
            onHoverStart={handleSelectionHoverStart}
            onHoverEnd={handleSelectionHoverEnd}
          />
        ) : null}

        {visibleElements.map((element) => (
          <ElementChip
            key={element.elementKey}
            element={element}
            excluded={isExcluded(element.elementKey)}
            selected={isSelectedElement(element.elementKey)}
            scrollResizeTrigger={scrollResizeTrigger}
            onToggleExclude={(elementKey) => tx.toggleExclude(elementKey)}
            onRevert={handleRevert}
            onHoverStart={handleHoverStart}
            onHoverEnd={handleHoverEnd}
          />
        ))}

        {visibleElements.length === 0 && !showSelectionChip ? (
          <div className="px-2 py-1 text-[11px] italic" style={{ color: 'var(--ac-text-subtle)' }}>
            {emptyStateText}
          </div>
        ) : null}
      </div>
    </div>
  );
}
