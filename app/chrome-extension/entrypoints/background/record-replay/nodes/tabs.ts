import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import {
  enforcesPublicPageRestrictions,
  isAllowedPublicFlowOpenUrl,
  isAllowedPublicFlowTabUrl,
  PUBLIC_FLOW_OPEN_URL_ERROR,
  PUBLIC_FLOW_SWITCH_TAB_ERROR,
} from '../public-pages';
import type { StepOpenTab, StepSwitchTab, StepCloseTab } from '../types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

function shouldUseBackgroundTabs(ctx: ExecCtx, actionBackground: unknown): boolean {
  return typeof actionBackground === 'boolean'
    ? actionBackground
    : ctx.execution?.backgroundTabs === true;
}

export const openTabNode: NodeRuntime<StepOpenTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const nextUrl = typeof s.url === 'string' ? s.url.trim() : '';
    const background = shouldUseBackgroundTabs(ctx, s.background);
    if (
      enforcesPublicPageRestrictions(ctx.execution) &&
      !isAllowedPublicFlowOpenUrl(nextUrl)
    ) {
      throw new Error(PUBLIC_FLOW_OPEN_URL_ERROR);
    }
    if (s.newWindow) {
      const createdWindow = await chrome.windows.create({
        url: s.url || undefined,
        focused: !background,
      });
      const firstTabId = createdWindow.tabs?.[0]?.id;
      if (typeof firstTabId === 'number') {
        ctx.tabId = firstTabId;
      }
    } else {
      const createdTab = await chrome.tabs.create({ url: s.url || undefined, active: !background });
      if (typeof createdTab.id === 'number') {
        ctx.tabId = createdTab.id;
      }
    }
    return {} as ExecResult;
  },
};

export const switchTabNode: NodeRuntime<StepSwitchTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    let targetTabId: number | undefined = s.tabId;
    let targetTab: chrome.tabs.Tab | undefined;
    if (!targetTabId) {
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find(
        (t) =>
          (s.urlContains && (t.url || '').includes(String(s.urlContains))) ||
          (s.titleContains && (t.title || '').includes(String(s.titleContains))),
      );
      targetTab = hit;
      targetTabId = (hit && hit.id) as number | undefined;
    } else {
      targetTab = await chrome.tabs.get(targetTabId).catch(() => undefined);
    }
    if (!targetTabId) throw new Error('switchTab: no matching tab');
    if (
      enforcesPublicPageRestrictions(ctx.execution) &&
      !isAllowedPublicFlowTabUrl(targetTab?.url)
    ) {
      throw new Error(PUBLIC_FLOW_SWITCH_TAB_ERROR);
    }
    const background = shouldUseBackgroundTabs(ctx, s.background);
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.SWITCH_TAB,
      args: { tabId: targetTabId, background },
    });
    if ((res as any).isError) throw new Error('switchTab failed');
    ctx.tabId = targetTabId;
    return {} as ExecResult;
  },
};

export const closeTabNode: NodeRuntime<StepCloseTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const args: any = {};
    if (Array.isArray(s.tabIds) && s.tabIds.length) args.tabIds = s.tabIds;
    if (s.url) args.url = s.url;
    if (!args.tabIds && !args.url && typeof ctx.tabId === 'number') args.tabId = ctx.tabId;
    const res = await handleCallTool({ name: TOOL_NAMES.BROWSER.CLOSE_TABS, args });
    if ((res as any).isError) throw new Error('closeTab failed');
    if (
      typeof ctx.tabId === 'number' &&
      Array.isArray(args.tabIds) &&
      args.tabIds.includes(ctx.tabId)
    ) {
      ctx.tabId = undefined;
    } else if (typeof args.tabId === 'number' && args.tabId === ctx.tabId) {
      ctx.tabId = undefined;
    }
    return {} as ExecResult;
  },
};
