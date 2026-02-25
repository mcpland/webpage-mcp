/**
 * Drag Action Handler
 *
 * Performs a left-click drag from a start target to an end target.
 *
 * Features:
 * - Locates start/end via shared SelectorLocator (ref + candidates)
 * - Executes via chrome_computer with action="left_click_drag" (CDP-based)
 * - Uses optional `path` endpoints as a fallback for coordinates
 * - Validates element visibility before drag
 */

import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { failed, invalid, ok } from '../registry';
import type { ActionHandler, ElementTarget, Point, VariableStore } from '../types';
import {
  ensureElementVisible,
  logSelectorFallback,
  selectorLocator,
  toSelectorTarget,
} from './common';

interface Coordinates {
  x: number;
  y: number;
}

/** Check if target has valid selector specification */
function hasTargetSpec(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as { ref?: unknown; candidates?: unknown };
  const hasRef = typeof t.ref === 'string' && t.ref.trim().length > 0;
  const hasCandidates = Array.isArray(t.candidates) && t.candidates.length > 0;
  return hasRef || hasCandidates;
}

/** Check if value is a finite number */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Extract start/end coordinates from path array */
function getPathEndpoints(
  path: ReadonlyArray<Point> | undefined,
): { startCoordinates: Coordinates; endCoordinates: Coordinates } | null {
  if (!Array.isArray(path) || path.length < 2) return null;

  const first = path[0];
  const last = path[path.length - 1];

  if (!first || !last) return null;
  if (!isFiniteNumber(first.x) || !isFiniteNumber(first.y)) return null;
  if (!isFiniteNumber(last.x) || !isFiniteNumber(last.y)) return null;

  return {
    startCoordinates: { x: first.x, y: first.y },
    endCoordinates: { x: last.x, y: last.y },
  };
}

/** Extract error text from tool result */
function extractToolError(result: unknown, fallback: string): string {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return content?.find((c) => typeof c?.text === 'string')?.text || fallback;
}

/** Locate target and verify visibility */
async function locateTarget(
  tabId: number,
  frameId: number | undefined,
  target: ElementTarget | undefined,
  vars: VariableStore,
  role: 'start' | 'end',
): Promise<
  | { ok: true; ref?: string; firstCandidateType?: string; resolvedBy?: string }
  | { ok: false; error: string; code: 'TARGET_NOT_FOUND' | 'ELEMENT_NOT_VISIBLE' }
> {
  if (!target || !hasTargetSpec(target)) {
    return { ok: true };
  }

  const { selectorTarget, firstCandidateType } = toSelectorTarget(target, vars);

  const located = await selectorLocator.locate(tabId, selectorTarget, {
    frameId,
    preferRef: false,
  });

  const locatedFrameId = located?.frameId ?? frameId;
  const ref = located?.ref ?? selectorTarget.ref;
  const resolvedBy = located?.resolvedBy || (located?.ref ? 'ref' : '');

  // Verify visibility for freshly located refs
  if (located?.ref) {
    const visible = await ensureElementVisible(tabId, located.ref, locatedFrameId);
    if (!visible) {
      return {
        ok: false,
        error: `Drag ${role} element is not visible`,
        code: 'ELEMENT_NOT_VISIBLE',
      };
    }
  }

  return { ok: true, ref, firstCandidateType, resolvedBy };
}

export const dragHandler: ActionHandler<'drag'> = {
  type: 'drag',

  validate: (action) => {
    const pathEndpoints = getPathEndpoints(action.params.path);

    // If path is present, it must be well-formed
    if (action.params.path !== undefined && action.params.path.length > 0 && !pathEndpoints) {
      return invalid('path must contain at least two points with finite x/y coordinates');
    }

    const hasStart = hasTargetSpec(action.params.start);
    const hasEnd = hasTargetSpec(action.params.end);
    const hasPath = !!pathEndpoints;

    // Must have either target spec or path coordinates
    if (!hasStart && !hasPath) {
      return invalid('Drag start must include a non-empty ref or selector candidates');
    }
    if (!hasEnd && !hasPath) {
      return invalid('Drag end must include a non-empty ref or selector candidates');
    }

    return ok();
  },

  describe: (action) => {
    const startRef = (action.params.start as { ref?: unknown })?.ref;
    const endRef = (action.params.end as { ref?: unknown })?.ref;

    const s = typeof startRef === 'string' && startRef.trim() ? startRef.trim() : '';
    const e = typeof endRef === 'string' && endRef.trim() ? endRef.trim() : '';

    if (s && e) {
      const truncS = s.length > 15 ? s.slice(0, 15) + '...' : s;
      const truncE = e.length > 15 ? e.slice(0, 15) + '...' : e;
      return `Drag ${truncS} → ${truncE}`;
    }
    if (s) return `Drag from ${s.length > 20 ? s.slice(0, 20) + '...' : s}`;
    if (e) return `Drag to ${e.length > 20 ? e.slice(0, 20) + '...' : e}`;

    const pathEndpoints = getPathEndpoints(action.params.path);
    if (pathEndpoints) {
      const { startCoordinates, endCoordinates } = pathEndpoints;
      return `Drag (${startCoordinates.x},${startCoordinates.y}) → (${endCoordinates.x},${endCoordinates.y})`;
    }

    return 'Drag';
  },

  run: async (ctx, action) => {
    const tabId = ctx.tabId;
    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found for drag action');
    }

    // Ensure element refs are fresh before locating
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });

    // Get path coordinates as fallback
    const pathEndpoints = getPathEndpoints(action.params.path);
    const startCoordinates = pathEndpoints?.startCoordinates;
    const endCoordinates = pathEndpoints?.endCoordinates;

    // Locate start target
    const startResult = await locateTarget(
      tabId,
      ctx.frameId,
      action.params.start,
      ctx.vars,
      'start',
    );
    if (!startResult.ok) {
      return failed(startResult.code, startResult.error);
    }

    // Locate end target
    const endResult = await locateTarget(tabId, ctx.frameId, action.params.end, ctx.vars, 'end');
    if (!endResult.ok) {
      return failed(endResult.code, endResult.error);
    }

    // Validate we have at least one way to identify start and end
    if (!startResult.ref && !startCoordinates) {
      return failed('TARGET_NOT_FOUND', 'Could not resolve drag start (ref or path coordinates)');
    }
    if (!endResult.ref && !endCoordinates) {
      return failed('TARGET_NOT_FOUND', 'Could not resolve drag end (ref or path coordinates)');
    }

    // Execute drag via chrome_computer tool
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.COMPUTER,
      args: {
        action: 'left_click_drag',
        tabId,
        startRef: startResult.ref,
        ref: endResult.ref,
        startCoordinates,
        coordinates: endCoordinates,
      },
    });

    if ((res as { isError?: boolean })?.isError) {
      return failed('UNKNOWN', extractToolError(res, 'Drag action failed'));
    }

    // Log selector fallback after successful execution
    const startFallbackUsed =
      startResult.resolvedBy &&
      startResult.firstCandidateType &&
      startResult.resolvedBy !== 'ref' &&
      startResult.resolvedBy !== startResult.firstCandidateType;

    if (startFallbackUsed) {
      logSelectorFallback(
        ctx,
        action.id,
        `start:${String(startResult.firstCandidateType)}`,
        `start:${String(startResult.resolvedBy)}`,
      );
    }

    const endFallbackUsed =
      endResult.resolvedBy &&
      endResult.firstCandidateType &&
      endResult.resolvedBy !== 'ref' &&
      endResult.resolvedBy !== endResult.firstCandidateType;

    if (endFallbackUsed) {
      logSelectorFallback(
        ctx,
        action.id,
        `end:${String(endResult.firstCandidateType)}`,
        `end:${String(endResult.resolvedBy)}`,
      );
    }

    return { status: 'success' };
  },
};
