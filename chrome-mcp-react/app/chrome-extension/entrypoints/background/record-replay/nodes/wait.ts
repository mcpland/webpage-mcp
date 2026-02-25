import type { StepWait } from '../types';
import { waitForNetworkIdle, waitForNavigation } from '../rr-utils';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const waitNode: NodeRuntime<StepWait> = {
  validate: (step) => {
    const ok = !!(step as any).condition;
    return ok ? { ok } : { ok, errors: ['缺少等待条件'] };
  },
  run: async (ctx: ExecCtx, step: StepWait) => {
    const s = expandTemplatesDeep(step as StepWait, ctx.vars);
    const cond = (s as StepWait).condition as
      | { selector: string; visible?: boolean }
      | { text: string; appear?: boolean }
      | { navigation: true }
      | { networkIdle: true }
      | { sleep: number };
    if ('text' in cond) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs?.[0]?.id;
      if (typeof tabId !== 'number') throw new Error('Active tab not found');
      const frameIds = typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined;
      await chrome.scripting.executeScript({
        target: { tabId, frameIds },
        files: ['inject-scripts/wait-helper.js'],
        world: 'ISOLATED',
      } as any);
      const resp: any = (await chrome.tabs.sendMessage(
        tabId,
        {
          action: 'waitForText',
          text: cond.text,
          appear: (cond as any).appear !== false,
          timeout: Math.max(0, Math.min((s as any).timeoutMs || 10000, 120000)),
        } as any,
        { frameId: ctx.frameId } as any,
      )) as any;
      if (!resp || resp.success !== true) throw new Error('wait text failed');
    } else if ('networkIdle' in cond) {
      const total = Math.min(Math.max(1000, (s as any).timeoutMs || 5000), 120000);
      const idle = Math.min(1500, Math.max(500, Math.floor(total / 3)));
      await waitForNetworkIdle(total, idle);
    } else if ('navigation' in cond) {
      await waitForNavigation((s as any).timeoutMs);
    } else if ('sleep' in cond) {
      const ms = Math.max(0, Number(cond.sleep ?? 0));
      await new Promise((r) => setTimeout(r, ms));
    } else if ('selector' in cond) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs?.[0]?.id;
      if (typeof tabId !== 'number') throw new Error('Active tab not found');
      const frameIds = typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined;
      await chrome.scripting.executeScript({
        target: { tabId, frameIds },
        files: ['inject-scripts/wait-helper.js'],
        world: 'ISOLATED',
      } as any);
      const resp: any = (await chrome.tabs.sendMessage(
        tabId,
        {
          action: 'waitForSelector',
          selector: (cond as any).selector,
          visible: (cond as any).visible !== false,
          timeout: Math.max(0, Math.min((s as any).timeoutMs || 10000, 120000)),
        } as any,
        { frameId: ctx.frameId } as any,
      )) as any;
      if (!resp || resp.success !== true) throw new Error('wait selector failed');
    }
    return {} as ExecResult;
  },
};
