import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepHttp } from '../types';
import { applyAssign, expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { resolveNodeTabId } from './tab-context';

export const httpNode: NodeRuntime<StepHttp> = {
  run: async (ctx: ExecCtx, step: StepHttp) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const tabId = await resolveNodeTabId(ctx);
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
      args: {
        url: s.url,
        method: s.method || 'GET',
        headers: s.headers || {},
        body: s.body,
        formData: s.formData,
        tabId,
      },
    });
    const text = (res as any)?.content?.find((c: any) => c.type === 'text')?.text;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (s.saveAs && payload !== undefined) ctx.vars[s.saveAs] = payload;
      if (s.assign && payload !== undefined) applyAssign(ctx.vars, payload, s.assign);
    } catch {}
    return {} as ExecResult;
  },
};
