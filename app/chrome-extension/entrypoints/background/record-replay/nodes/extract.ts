import type { StepExtract } from '../types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const extractNode: NodeRuntime<StepExtract> = {
  run: async (ctx: ExecCtx, step: StepExtract) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Active tab not found');
    let value: any = null;
    if (s.js && String(s.js).trim()) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (code: string) => {
          try {
            return (0, eval)(code);
          } catch (e) {
            return null;
          }
        },
        args: [String(s.js)],
      } as any);
      value = result;
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
