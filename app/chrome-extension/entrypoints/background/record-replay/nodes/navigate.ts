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
    const stepBackground = (step as any).background;
    const background =
      typeof stepBackground === 'boolean' ? stepBackground : ctx.execution?.backgroundTabs === true;
    const tabId = await resolveNodeTabId(ctx);
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      // Workflow nodes drive a specific tab; require in-place semantics so the
      // default new_tab behaviour does not detach the node from its tab.
      args: { url, tabId, background, openMode: 'current_tab' },
    });
    if ((res as any).isError) throw new Error('navigate failed');
    return {} as ExecResult;
  },
};
