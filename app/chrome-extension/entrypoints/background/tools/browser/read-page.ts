import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';
import { listMarkersForUrl } from '@/entrypoints/background/element-marker/element-marker-storage';
import {
  boundInteractiveElements,
  truncateInteractiveString,
  utf8ByteLengthBounded,
} from './interactive-elements-limits';
import { qualifyPageContentRefs, resolveRefTarget } from './target-resolution';

const READ_PAGE_LIMITS = {
  refIdBytes: 128,
  pageContentBytes: 384 * 1024,
  refMapCount: 256,
  frames: 32,
} as const;

interface ReadPageFrameInfo {
  frameId: number;
  parentFrameId: number;
  url: string | null;
}

/** Other frames of the tab, so callers can read an iframe explicitly. */
async function listOtherFrames(
  tabId: number,
  targetFrameId: number,
): Promise<ReadPageFrameInfo[]> {
  try {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
    return frames
      .filter((frame) => frame.frameId !== targetFrameId)
      .slice(0, READ_PAGE_LIMITS.frames)
      .map((frame) => ({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: /^https?:\/\//i.test(frame.url || '') ? frame.url : null,
      }));
  } catch {
    return [];
  }
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

interface ReadPageStats {
  processed: number;
  included: number;
  durationMs: number;
}

interface ReadPageParams {
  filter?: 'interactive'; // when omitted, return all visible elements
  depth?: number; // maximum DOM depth to traverse (0 = root only)
  refId?: string; // focus on subtree rooted at this refId
  frameId?: number; // read this frame instead of the top frame
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  background?: boolean; // when true, do not activate tab or focus window
}

function hasDisallowedPublicPageScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== 'http' && protocol !== 'https';
}

class ReadPageTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.READ_PAGE;

  // Execute read page
  async execute(args: ReadPageParams): Promise<ToolResult> {
    const { filter, depth, refId } = args || {};

    if (filter !== undefined && filter !== 'interactive') {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: filter must be "interactive" when provided`,
      );
    }

    // Validate refId parameter
    const focusRefId = typeof refId === 'string' ? refId.trim() : '';
    if (refId !== undefined && !focusRefId) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: refId must be a non-empty string`,
      );
    }
    if (
      focusRefId.length > READ_PAGE_LIMITS.refIdBytes ||
      utf8ByteLengthBounded(focusRefId, READ_PAGE_LIMITS.refIdBytes) >
        READ_PAGE_LIMITS.refIdBytes
    ) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: refId exceeds the ${READ_PAGE_LIMITS.refIdBytes}-byte UTF-8 limit`,
      );
    }

    // Resolve the frame to read: an explicit frameId or the frame encoded in a
    // frame-qualified refId ("f<frameId>:ref_<n>"). Defaults to the top frame.
    const explicitFrameId = args?.frameId;
    if (
      explicitFrameId !== undefined &&
      (!Number.isSafeInteger(explicitFrameId) || explicitFrameId < 0)
    ) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: frameId must be a non-negative integer`,
      );
    }
    let focusRef = '';
    let targetFrameId = explicitFrameId ?? 0;
    if (focusRefId) {
      try {
        const resolvedRef = resolveRefTarget(focusRefId, explicitFrameId);
        focusRef = resolvedRef?.ref || '';
        targetFrameId = resolvedRef?.frameId ?? targetFrameId;
      } catch (error) {
        return createErrorResponse(
          `${ERROR_MESSAGES.INVALID_PARAMETERS}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Validate depth parameter
    const requestedDepth = depth === undefined ? undefined : Number(depth);
    if (
      requestedDepth !== undefined &&
      (!Number.isInteger(requestedDepth) || requestedDepth < 0)
    ) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: depth must be a non-negative integer`,
      );
    }

    // Track if user explicitly controlled the output (skip sparse heuristics)
    const userControlled = requestedDepth !== undefined || !!focusRefId;

    try {
      // Tip text returned to callers to guide next action
      const standardTips =
        "If the specific element you need is missing from the returned data, use the 'screenshot' tool to capture the current viewport and confirm the element's on-screen coordinates. Also note: 'markedElements' are user-marked elements and have the highest priority when choosing targets.";

      const explicit = await this.tryGetTab(args?.tabId);
      let tab =
        explicit || (await this.getActiveTabOrThrowInWindow(args?.windowId));
      if (!tab.id)
        return createErrorResponse(
          ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID',
        );
      if (hasDisallowedPublicPageScheme(String(tab.url || ''))) {
        return createErrorResponse(
          'Only http:// and https:// pages are supported by chrome_read_page',
        );
      }
      if (args?.background !== true) {
        tab = await this.activateTabIfNeeded(tab);
      }
      const targetTabId = tab.id;
      if (!targetTabId) {
        return createErrorResponse(
          ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID',
        );
      }

      // Load any user-marked elements for this URL (priority hints)
      const currentUrl = String(tab.url || '');
      const userMarkers = currentUrl ? await listMarkersForUrl(currentUrl) : [];

      // Only the target frame builds a tree. Broadcasting to every frame made
      // whichever frame answered first (usually a small iframe) win, and its
      // frame-local refs then collided with the top frame's refs.
      await this.injectAccessibilityHelper(targetTabId, targetFrameId);

      // Ask content script to generate accessibility tree
      const resp = await this.sendMessageToTab(
        targetTabId,
        {
          action: TOOL_MESSAGE_TYPES.GENERATE_ACCESSIBILITY_TREE,
          filter: filter || null,
          depth: requestedDepth,
          refId: focusRef || undefined,
        },
        targetFrameId,
      );

      // Evaluate tree result and decide whether to fallback
      const treeOk = resp && resp.success === true;
      const rawPageContent: string = qualifyPageContentRefs(
        resp && typeof resp.pageContent === 'string' ? resp.pageContent : '',
        targetFrameId,
      );
      const pageContent = truncateInteractiveString(
        rawPageContent,
        READ_PAGE_LIMITS.pageContentBytes,
      );
      const treeTruncated =
        resp?.truncated === true || pageContent.length < rawPageContent.length;

      // Extract stats from response
      const stats: ReadPageStats | null =
        treeOk && resp?.stats
          ? {
              processed: finiteNonNegative(resp.stats.processed),
              included: finiteNonNegative(resp.stats.included),
              durationMs: finiteNonNegative(resp.stats.durationMs),
            }
          : null;

      const lines = pageContent
        ? pageContent.split('\n').filter((l: string) => l.trim().length > 0)
            .length
        : 0;
      const refCount = Array.isArray(resp?.refMap)
        ? Math.min(resp.refMap.length, READ_PAGE_LIMITS.refMapCount)
        : 0;

      // Skip sparse heuristics when user explicitly controls output
      const isSparse = !userControlled && lines < 10 && refCount < 3;

      // Build user-marked elements for inclusion
      const markedElements = userMarkers.map((m) => ({
        name: m.name,
        selector: m.selector,
        selectorType: m.selectorType || 'css',
        urlMatch: { type: m.matchType, origin: m.origin, path: m.path },
        source: 'marker',
        priority: 'highest',
      }));

      // Helper to convert elements array to pageContent format
      const formatElementsAsPageContent = (elements: any[]): string => {
        const out: string[] = [];
        for (const e of elements || []) {
          const type =
            typeof e?.type === 'string' && e.type ? e.type : 'element';
          const rawText = typeof e?.text === 'string' ? e.text.trim() : '';
          const text =
            rawText.length > 0
              ? ` "${rawText.replace(/\s+/g, ' ').slice(0, 100).replace(/"/g, '\\"')}"`
              : '';
          const selector =
            typeof e?.selector === 'string' && e.selector
              ? ` selector="${e.selector}"`
              : '';
          const coords =
            e?.coordinates &&
            Number.isFinite(e.coordinates.x) &&
            Number.isFinite(e.coordinates.y)
              ? ` (x=${Math.round(e.coordinates.x)},y=${Math.round(e.coordinates.y)})`
              : '';
          out.push(`- ${type}${text}${selector}${coords}`);
          if (out.length >= 150) break;
        }
        return out.join('\n');
      };

      // Unified base payload structure - consistent keys for stable contract
      const basePayload: Record<string, any> = {
        success: true,
        filter: filter || 'all',
        pageContent,
        truncated: treeTruncated,
        tips: standardTips,
        viewport: treeOk
          ? {
              width: finiteNonNegative(resp?.viewport?.width),
              height: finiteNonNegative(resp?.viewport?.height),
              dpr: finiteNonNegative(resp?.viewport?.dpr),
            }
          : { width: null, height: null, dpr: null },
        stats: stats || { processed: 0, included: 0, durationMs: 0 },
        refMapCount: refCount,
        sparse: treeOk ? isSparse : false,
        depth: requestedDepth ?? null,
        focus: focusRefId ? { refId: focusRefId, found: treeOk } : null,
        markedElements,
        elements: [],
        count: 0,
        fallbackUsed: false,
        fallbackSource: null,
        reason: null,
      };
      // Iframe contents are not inlined. Report the other frames so a caller
      // can read one explicitly; its refs come back frame-qualified.
      if (targetFrameId !== 0) basePayload.frameId = targetFrameId;
      const otherFrames = await listOtherFrames(targetTabId, targetFrameId);
      if (otherFrames.length > 0) basePayload.frames = otherFrames;

      // Normal path: return tree
      if (treeOk && !isSparse) {
        return {
          content: [{ type: 'text', text: JSON.stringify(basePayload) }],
          isError: false,
        };
      }

      // When refId is explicitly provided, do not fallback (refs are frame-local and may expire)
      if (focusRefId) {
        return createErrorResponse(
          resp?.error || `refId "${focusRefId}" not found or expired`,
        );
      }

      // When user explicitly controls depth, do not override with fallback heuristics
      if (requestedDepth !== undefined) {
        return createErrorResponse(
          resp?.error || 'Failed to generate accessibility tree',
        );
      }

      // Fallback path: try get_interactive_elements once
      try {
        await this.injectContentScript(
          targetTabId,
          ['inject-scripts/interactive-elements-helper.js'],
          false,
          'ISOLATED',
          false,
          [targetFrameId],
        );
        const fallback = await this.sendMessageToTab(
          targetTabId,
          {
            action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
            includeCoordinates: true,
          },
          targetFrameId,
        );

        if (fallback && fallback.success && Array.isArray(fallback.elements)) {
          const boundedFallback = boundInteractiveElements(fallback.elements, 150);
          const limited = boundedFallback.elements;
          // Merge user markers at the front, de-duplicated by selector
          const markerEls = userMarkers.map((m) => ({
            type: 'marker',
            selector: m.selector,
            text: m.name,
            selectorType: m.selectorType || 'css',
            isInteractive: true,
            source: 'marker',
            priority: 'highest',
          }));
          const seen = new Set(markerEls.map((e) => e.selector));
          const merged = [
            ...markerEls,
            ...limited.filter((e: any) => !seen.has(e.selector)),
          ];

          basePayload.fallbackUsed = true;
          basePayload.fallbackSource = 'get_interactive_elements';
          basePayload.reason = treeOk
            ? 'sparse_tree'
            : resp?.error || 'tree_failed';
          basePayload.elements = merged;
          basePayload.count = limited.length;
          basePayload.truncated =
            fallback.truncated === true || boundedFallback.truncated;
          if (!basePayload.pageContent) {
            basePayload.pageContent = formatElementsAsPageContent(merged);
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(basePayload) }],
            isError: false,
          };
        }
      } catch (fallbackErr) {
        console.warn('read_page fallback failed:', fallbackErr);
      }

      // A small page legitimately produces a small tree. The fallback can only
      // add detail, so its failure must not turn a valid tree into an error.
      if (treeOk) {
        basePayload.reason = 'sparse_tree';
        return {
          content: [{ type: 'text', text: JSON.stringify(basePayload) }],
          isError: false,
        };
      }

      return createErrorResponse(
        resp?.error || 'Failed to generate accessibility tree and fallback failed',
      );
    } catch (error) {
      console.error('Error in read page tool:', error);
      return createErrorResponse(
        `Error generating accessibility tree: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const readPageTool = new ReadPageTool();
