import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepKey } from '../types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const keyNode: NodeRuntime<StepKey> = {
  run: async (ctx, step: StepKey) => {
    const s = expandTemplatesDeep(step as StepKey, ctx.vars) as StepKey;
    const args: { keys: string; frameId?: number; selector?: string } = { keys: s.keys };

    // Support target selector for focusing before key input
    if (s.target && s.target.candidates?.length) {
      const selector = s.target.candidates[0]?.value;
      if (selector) {
        args.selector = selector;
      }
    }

    if (typeof ctx.frameId === 'number') {
      args.frameId = ctx.frameId;
    }

    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.KEYBOARD,
      args,
    });
    if ((res as any).isError) throw new Error('key failed');
    return {} as ExecResult;
  },
};
