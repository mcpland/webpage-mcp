import type { StepScript } from '../types';
import { expandTemplatesDeep, applyAssign } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const scriptNode: NodeRuntime<StepScript> = {
  run: async (ctx: ExecCtx, step: StepScript) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    if (s.when === 'after') return { deferAfterScript: s } as ExecResult;
    const world = s.world || 'ISOLATED';
    const code = String(s.code || '');
    if (!code.trim()) return {} as ExecResult;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Active tab not found');
    const frameIds = typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds } as any,
      func: (userCode: string) => {
        try {
          return (0, eval)(userCode);
        } catch {
          return null;
        }
      },
      args: [code],
      world: world as any,
    } as any);
    if (s.saveAs) ctx.vars[s.saveAs] = result;
    if (s.assign && typeof s.assign === 'object') applyAssign(ctx.vars, result, s.assign);
    return {} as ExecResult;
  },
};
