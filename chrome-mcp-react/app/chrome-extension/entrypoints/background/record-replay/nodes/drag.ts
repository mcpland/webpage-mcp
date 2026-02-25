import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepDrag } from '../types';
import { locateElement } from '../selector-engine';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const dragNode: NodeRuntime<StepDrag> = {
  run: async (_ctx, step: StepDrag) => {
    const s = step as StepDrag;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    let startRef: string | undefined;
    let endRef: string | undefined;
    try {
      if (typeof tabId === 'number') {
        const locatedStart = await locateElement(tabId, (s as any).start);
        const locatedEnd = await locateElement(tabId, (s as any).end);
        startRef = (locatedStart as any)?.ref || (s as any).start.ref;
        endRef = (locatedEnd as any)?.ref || (s as any).end.ref;
      }
    } catch {}
    let startCoordinates: { x: number; y: number } | undefined;
    let endCoordinates: { x: number; y: number } | undefined;
    if ((!startRef || !endRef) && Array.isArray((s as any).path) && (s as any).path.length >= 2) {
      startCoordinates = { x: Number((s as any).path[0].x), y: Number((s as any).path[0].y) };
      const last = (s as any).path[(s as any).path.length - 1];
      endCoordinates = { x: Number(last.x), y: Number(last.y) };
    }
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.COMPUTER,
      args: {
        action: 'left_click_drag',
        startRef,
        ref: endRef,
        startCoordinates,
        coordinates: endCoordinates,
      },
    });
    if ((res as any).isError) throw new Error('drag failed');
    return {} as ExecResult;
  },
};
