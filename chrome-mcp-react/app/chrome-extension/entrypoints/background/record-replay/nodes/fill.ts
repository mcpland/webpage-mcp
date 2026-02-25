import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepFill } from '../types';
import { locateElement } from '../selector-engine';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const fillNode: NodeRuntime<StepFill> = {
  validate: (step) => {
    const ok = !!(step as any).target?.candidates?.length && 'value' in (step as any);
    return ok ? { ok } : { ok, errors: ['缺少目标选择器候选或输入值'] };
  },
  run: async (ctx: ExecCtx, step: StepFill) => {
    const s: any = step;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const firstTab = tabs && tabs[0];
    const tabId = firstTab && typeof firstTab.id === 'number' ? firstTab.id : undefined;
    if (!tabId) throw new Error('Active tab not found');
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
    const located = await locateElement(tabId, s.target, ctx.frameId);
    const frameId = (located as any)?.frameId ?? ctx.frameId;
    const first = s.target?.candidates?.[0]?.type;
    const resolvedBy = (located as any)?.resolvedBy || ((located as any)?.ref ? 'ref' : '');
    const fallbackUsed = resolvedBy && first && resolvedBy !== 'ref' && resolvedBy !== first;
    const interpolate = (v: any) =>
      typeof v === 'string'
        ? v.replace(/\{([^}]+)\}/g, (_m, k) => (ctx.vars[k] ?? '').toString())
        : v;
    const value = interpolate(s.value);
    if ((located as any)?.ref) {
      const resolved: any = (await chrome.tabs.sendMessage(
        tabId,
        { action: 'resolveRef', ref: (located as any).ref } as any,
        { frameId } as any,
      )) as any;
      const rect = resolved?.rect;
      if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error('element not visible');
    }
    const cssSelector = !(located as any)?.ref
      ? s.target.candidates?.find((c: any) => c.type === 'css' || c.type === 'attr')?.value
      : undefined;
    if (cssSelector) {
      try {
        const attr: any = (await chrome.tabs.sendMessage(
          tabId,
          { action: 'getAttributeForSelector', selector: cssSelector, name: 'type' } as any,
          { frameId } as any,
        )) as any;
        const typeName = (attr && attr.value ? String(attr.value) : '').toLowerCase();
        if (typeName === 'file') {
          const uploadRes = await handleCallTool({
            name: TOOL_NAMES.BROWSER.FILE_UPLOAD,
            args: { selector: cssSelector, filePath: String(value ?? '') },
          });
          if ((uploadRes as any).isError) throw new Error('file upload failed');
          if (fallbackUsed)
            ctx.logger({
              stepId: (step as any).id,
              status: 'success',
              message: `Selector fallback used (${String(first)} -> ${String(resolvedBy)})`,
              fallbackUsed: true,
              fallbackFrom: String(first),
              fallbackTo: String(resolvedBy),
            } as any);
          return {} as ExecResult;
        }
      } catch {}
    }
    try {
      if (cssSelector)
        await handleCallTool({
          name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
          args: {
            type: 'MAIN',
            jsScript: `try{var el=document.querySelector(${JSON.stringify(cssSelector)});if(el){el.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'});} }catch(e){}`,
          },
        });
    } catch {}
    try {
      if ((located as any)?.ref)
        await chrome.tabs.sendMessage(
          tabId,
          { action: 'focusByRef', ref: (located as any).ref } as any,
          { frameId } as any,
        );
      else if (cssSelector)
        await handleCallTool({
          name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
          args: {
            type: 'MAIN',
            jsScript: `try{var el=document.querySelector(${JSON.stringify(cssSelector)});if(el&&el.focus){el.focus();}}catch(e){}`,
          },
        });
    } catch {}
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.FILL,
      args: {
        ref: (located as any)?.ref || (s as any).target?.ref,
        selector: cssSelector,
        value,
        frameId,
      },
    });
    if ((res as any).isError) throw new Error('fill failed');
    if (fallbackUsed)
      ctx.logger({
        stepId: (step as any).id,
        status: 'success',
        message: `Selector fallback used (${String(first)} -> ${String(resolvedBy)})`,
        fallbackUsed: true,
        fallbackFrom: String(first),
        fallbackTo: String(resolvedBy),
      } as any);
    return {} as ExecResult;
  },
};
