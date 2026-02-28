import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { Step } from '../types';
import { locateElement } from '../selector-engine';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { resolveNodeTabId } from './tab-context';

export const clickNode: NodeRuntime<any> = {
  validate: (step) => {
    const ok = !!(step as any).target?.candidates?.length;
    return ok ? { ok } : { ok, errors: ['Missing target selector candidate'] };
  },
  run: async (ctx: ExecCtx, step: Step) => {
    const tabId = await resolveNodeTabId(ctx);
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const located = await locateElement(tabId, s.target, ctx.frameId);
    const frameId = (located as any)?.frameId ?? ctx.frameId;
    const first = s.target?.candidates?.[0]?.type;
    const resolvedBy = (located as any)?.resolvedBy || ((located as any)?.ref ? 'ref' : '');
    const fallbackUsed = resolvedBy && first && resolvedBy !== 'ref' && resolvedBy !== first;
    if ((located as any)?.ref) {
      const resolved: any = (await chrome.tabs.sendMessage(
        tabId,
        { action: 'resolveRef', ref: (located as any).ref } as any,
        { frameId } as any,
      )) as any;
      const rect = resolved?.rect;
      if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error('element not visible');
    }
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.CLICK,
      args: {
        ref: (located as any)?.ref || (step as any).target?.ref,
        selector: !(located as any)?.ref
          ? s.target?.candidates?.find((c: any) => c.type === 'css' || c.type === 'attr')?.value
          : undefined,
        waitForNavigation: false,
        timeout: Math.max(1000, Math.min(s.timeoutMs || 10000, 30000)),
        frameId,
        tabId,
      },
    });
    if ((res as any).isError) throw new Error('click failed');
    if (fallbackUsed)
      ctx.logger({
        stepId: step.id,
        status: 'success',
        message: `Selector fallback used (${String(first)} -> ${String(resolvedBy)})`,
        fallbackUsed: true,
        fallbackFrom: String(first),
        fallbackTo: String(resolvedBy),
      } as any);
    return {} as ExecResult;
  },
};

export const dblclickNode: NodeRuntime<any> = {
  validate: clickNode.validate,
  run: async (ctx: ExecCtx, step: Step) => {
    const tabId = await resolveNodeTabId(ctx);
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const located = await locateElement(tabId, s.target, ctx.frameId);
    const frameId = (located as any)?.frameId ?? ctx.frameId;
    const first = s.target?.candidates?.[0]?.type;
    const resolvedBy = (located as any)?.resolvedBy || ((located as any)?.ref ? 'ref' : '');
    const fallbackUsed = resolvedBy && first && resolvedBy !== 'ref' && resolvedBy !== first;
    if ((located as any)?.ref) {
      const resolved: any = (await chrome.tabs.sendMessage(
        tabId,
        { action: 'resolveRef', ref: (located as any).ref } as any,
        { frameId } as any,
      )) as any;
      const rect = resolved?.rect;
      if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error('element not visible');
    }
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.CLICK,
      args: {
        ref: (located as any)?.ref || (step as any).target?.ref,
        selector: !(located as any)?.ref
          ? s.target?.candidates?.find((c: any) => c.type === 'css' || c.type === 'attr')?.value
          : undefined,
        waitForNavigation: false,
        timeout: Math.max(1000, Math.min(s.timeoutMs || 10000, 30000)),
        frameId,
        double: true,
        tabId,
      },
    });
    if ((res as any).isError) throw new Error('dblclick failed');
    if (fallbackUsed)
      ctx.logger({
        stepId: step.id,
        status: 'success',
        message: `Selector fallback used (${String(first)} -> ${String(resolvedBy)})`,
        fallbackUsed: true,
        fallbackFrom: String(first),
        fallbackTo: String(resolvedBy),
      } as any);
    return {} as ExecResult;
  },
};
