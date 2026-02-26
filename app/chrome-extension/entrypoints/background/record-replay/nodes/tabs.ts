import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepOpenTab, StepSwitchTab, StepCloseTab } from '../types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const openTabNode: NodeRuntime<StepOpenTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    if (s.newWindow) await chrome.windows.create({ url: s.url || undefined, focused: true });
    else await chrome.tabs.create({ url: s.url || undefined, active: true });
    return {} as ExecResult;
  },
};

export const switchTabNode: NodeRuntime<StepSwitchTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    let targetTabId: number | undefined = s.tabId;
    if (!targetTabId) {
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find(
        (t) =>
          (s.urlContains && (t.url || '').includes(String(s.urlContains))) ||
          (s.titleContains && (t.title || '').includes(String(s.titleContains))),
      );
      targetTabId = (hit && hit.id) as number | undefined;
    }
    if (!targetTabId) throw new Error('switchTab: no matching tab');
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.SWITCH_TAB,
      args: { tabId: targetTabId },
    });
    if ((res as any).isError) throw new Error('switchTab failed');
    return {} as ExecResult;
  },
};

export const closeTabNode: NodeRuntime<StepCloseTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const args: any = {};
    if (Array.isArray(s.tabIds) && s.tabIds.length) args.tabIds = s.tabIds;
    if (s.url) args.url = s.url;
    const res = await handleCallTool({ name: TOOL_NAMES.BROWSER.CLOSE_TABS, args });
    if ((res as any).isError) throw new Error('closeTab failed');
    return {} as ExecResult;
  },
};
