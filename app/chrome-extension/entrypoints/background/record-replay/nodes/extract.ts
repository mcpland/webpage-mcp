import type { StepExtract } from '../types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { resolveNodeTabId } from './tab-context';
import { executePageScript } from '@/utils/page-script-executor';

export const extractNode: NodeRuntime<StepExtract> = {
  run: async (ctx: ExecCtx, step: StepExtract) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const tabId = await resolveNodeTabId(ctx);
    let value: any = null;
    if (s.js && String(s.js).trim()) {
      value = await executePageScript({
        tabId,
        frameId: ctx.frameId,
        code: String(s.js),
        mode: 'raw',
        world: 'ISOLATED',
        owner: 'legacy-workflow-extract',
      });
    } else if (s.selector) {
      const attr = String(s.attr || 'text');
      const sel = String(s.selector);
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector: string, attr: string) => {
          try {
            const el = document.querySelector(selector) as any;
            if (!el) return null;
            if (attr === 'text' || attr === 'textContent') return (el.textContent || '').trim();
            return el.getAttribute ? el.getAttribute(attr) : null;
          } catch {
            return null;
          }
        },
        args: [sel, attr],
      } as any);
      value = result;
    }
    if (s.saveAs) ctx.vars[s.saveAs] = value;
    return {} as ExecResult;
  },
};
