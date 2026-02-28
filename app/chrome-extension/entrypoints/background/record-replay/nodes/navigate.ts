import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { Step } from '../types';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { resolveNodeTabId } from './tab-context';

export const navigateNode: NodeRuntime<any> = {
  validate: (step) => {
    const ok = !!(step as any).url;
    return ok ? { ok } : { ok, errors: ['Missing URL'] };
  },
  run: async (ctx: ExecCtx, step: Step) => {
    const url = (step as any).url;
    const tabId = await resolveNodeTabId(ctx);
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url, tabId },
    });
    if ((res as any).isError) throw new Error('navigate failed');
    return {} as ExecResult;
  },
};
