import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { expandTemplatesDeep } from '../rr-utils';
import type { Step } from '../types';
import { locateElement } from '../selector-engine';
import {
  boundedLoopElementIterations,
  collectLoopElementPaths,
  LOOP_ELEMENTS_RESOURCE_LIMITS,
} from './loop-elements-resources';
import { resolveNodeTabId } from './tab-context';

function extractToolText(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = content?.find((item) => item?.type === 'text' && typeof item.text === 'string')
    ?.text;
  return typeof text === 'string' && text.trim() ? text : undefined;
}

export const handleDownloadNode: NodeRuntime<any> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const tabId = await resolveNodeTabId(ctx);
    const args: any = {
      filenameContains: s.filenameContains || undefined,
      timeoutMs: Math.max(1000, Math.min(Number(s.timeoutMs ?? 60000), 300000)),
      waitForComplete: s.waitForComplete !== false,
      tabId,
    };
    const res = await handleCallTool({ name: TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD, args });
    const text = (res as any)?.content?.find((c: any) => c.type === 'text')?.text;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (s.saveAs && payload && payload.download) ctx.vars[s.saveAs] = payload.download;
    } catch {}
    return {} as ExecResult;
  },
};

export const screenshotNode: NodeRuntime<any> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const tabId = await resolveNodeTabId(ctx);
    const background =
      typeof s.background === 'boolean' ? s.background : ctx.execution?.backgroundTabs === true;
    const args: any = { name: 'workflow', storeBase64: true, tabId, background };
    if (s.fullPage) args.fullPage = true;
    if (s.selector && typeof s.selector === 'string' && s.selector.trim())
      args.selector = s.selector;
    const res = await handleCallTool({ name: TOOL_NAMES.BROWSER.SCREENSHOT, args });
    const text = extractToolText(res);
    if ((res as { isError?: boolean })?.isError) {
      throw new Error(text || 'screenshot failed');
    }
    if (!s.saveAs) {
      return {} as ExecResult;
    }
    if (!text) {
      throw new Error('screenshot tool returned an empty response');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('screenshot tool returned invalid JSON');
    }
    const base64Data = (payload as { base64Data?: unknown })?.base64Data;
    if (typeof base64Data !== 'string' || !base64Data) {
      throw new Error('screenshot tool returned empty base64Data');
    }
    ctx.vars[s.saveAs] = base64Data;
    return {} as ExecResult;
  },
};

export const triggerEventNode: NodeRuntime<any> = {
  validate: (step) => {
    const s: any = step;
    const ok = !!s?.target?.candidates?.length && typeof s?.event === 'string' && s.event;
    return ok ? { ok } : { ok, errors: ['Missing target selector or event type'] };
  },
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const tabId = await resolveNodeTabId(ctx);
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });
    const located = await locateElement(tabId, s.target, ctx.frameId);
    const cssSelector = !(located as any)?.ref
      ? s.target.candidates?.find((c: any) => c.type === 'css' || c.type === 'attr')?.value
      : undefined;
    let sel = cssSelector as string | undefined;
    if (!sel && (located as any)?.ref) {
      try {
        const resolved: any = (await chrome.tabs.sendMessage(
          tabId,
          { action: 'resolveRef', ref: (located as any).ref } as any,
          { frameId: ctx.frameId } as any,
        )) as any;
        sel = resolved?.selector;
      } catch {}
    }
    if (!sel) throw new Error('triggerEvent: selector not resolved');
    const world: any = 'MAIN';
    const ev = String(s.event || '').trim();
    const bubbles = s.bubbles !== false;
    const cancelable = s.cancelable === true;
    await chrome.scripting.executeScript({
      target: {
        tabId,
        frameIds: typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined,
      } as any,
      world,
      func: (selector: string, type: string, bubbles: boolean, cancelable: boolean) => {
        try {
          const el = document.querySelector(selector);
          if (!el) return false;
          const e = new Event(type, { bubbles, cancelable });
          (el as any).dispatchEvent(e);
          return true;
        } catch (e) {
          return false;
        }
      },
      args: [sel, ev, !!bubbles, !!cancelable],
    } as any);
    return {} as ExecResult;
  },
};

export const setAttributeNode: NodeRuntime<any> = {
  validate: (step) => {
    const s: any = step;
    const ok = !!s?.target?.candidates?.length && typeof s?.name === 'string' && s.name;
    return ok ? { ok } : { ok, errors: ['The target selector and attribute name need to be provided'] };
  },
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const tabId = await resolveNodeTabId(ctx);
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });
    const located = await locateElement(tabId, s.target, ctx.frameId);
    const frameId = (located as any)?.frameId ?? ctx.frameId;
    const cssSelector = !(located as any)?.ref
      ? s.target.candidates?.find((c: any) => c.type === 'css' || c.type === 'attr')?.value
      : undefined;
    let sel = cssSelector as string | undefined;
    if (!sel && (located as any)?.ref) {
      try {
        const resolved: any = (await chrome.tabs.sendMessage(
          tabId,
          { action: 'resolveRef', ref: (located as any).ref } as any,
          { frameId } as any,
        )) as any;
        sel = resolved?.selector;
      } catch {}
    }
    if (!sel) throw new Error('setAttribute: selector not resolved');
    const world: any = 'MAIN';
    const name = String(s.name || '');
    const value = s.value;
    const remove = s.remove === true;
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: typeof frameId === 'number' ? [frameId] : undefined } as any,
      world,
      func: (selector: string, name: string, value: any, remove: boolean) => {
        try {
          const el = document.querySelector(selector) as any;
          if (!el) return false;
          if (remove) el.removeAttribute(name);
          else el.setAttribute(name, String(value ?? ''));
          return true;
        } catch {
          return false;
        }
      },
      args: [sel, name, value, remove],
    } as any);
    return {} as ExecResult;
  },
};

export const switchFrameNode: NodeRuntime<any> = {
  run: async (ctx, step) => {
    const s: any = step;
    const tabId = await resolveNodeTabId(ctx);
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!Array.isArray(frames) || frames.length === 0) {
      ctx.frameId = undefined;
      return {} as ExecResult;
    }
    let target: any | undefined;
    const idx = Number(s?.frame?.index ?? NaN);
    if (Number.isFinite(idx)) {
      const list = frames.filter((f) => f.frameId !== 0);
      target = list[Math.max(0, Math.min(list.length - 1, idx))];
    }
    const urlContains = String(s?.frame?.urlContains || '').trim();
    if (!target && urlContains)
      target = frames.find((f) => typeof f.url === 'string' && f.url.includes(urlContains));
    if (!target) ctx.frameId = undefined;
    else ctx.frameId = target.frameId;
    try {
      await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });
    } catch {}
    ctx.logger({
      stepId: (step as any).id,
      status: 'success',
      message: `frameId=${String(ctx.frameId ?? 'top')}`,
    } as any);
    return {} as ExecResult;
  },
};

export const loopElementsNode: NodeRuntime<any> = {
  validate: (step) => {
    const s: any = step;
    const ok =
      typeof s?.selector === 'string' &&
      s.selector &&
      typeof s?.subflowId === 'string' &&
      s.subflowId;
    return ok ? { ok } : { ok, errors: ['Need to provide selector and subflowId'] };
  },
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const tabId = await resolveNodeTabId(ctx);
    const world: any = 'MAIN';
    const selector = String(s.selector || '');
    if (!selector || selector.length > LOOP_ELEMENTS_RESOURCE_LIMITS.maxSelectorLength) {
      throw new Error('loopElements: selector is empty or exceeds the resource limit');
    }
    const maxIterations = boundedLoopElementIterations(s.maxIterations);
    const res = await chrome.scripting.executeScript({
      target: {
        tabId,
        frameIds: typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined,
      } as any,
      world,
      func: collectLoopElementPaths,
      args: [selector, maxIterations, LOOP_ELEMENTS_RESOURCE_LIMITS],
    } as any);
    const arr: string[] = (res && Array.isArray(res[0]?.result) ? res[0].result : []) as any;
    const listVar = String(s.saveAs || 'elements');
    const itemVar = String(s.itemVar || 'item');
    ctx.vars[listVar] = arr;
    return {
      control: { kind: 'foreach', listVar, itemVar, subflowId: String(s.subflowId) },
    } as any;
  },
};
