import type { StepScript } from '../types';
import { expandTemplatesDeep, applyAssign } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { resolveNodeTabId } from './tab-context';
import { executePageScript } from '@/utils/page-script-executor';

export const scriptNode: NodeRuntime<StepScript> = {
  run: async (ctx: ExecCtx, step: StepScript) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    if (s.when === 'after') return { deferAfterScript: s } as ExecResult;
    const world = s.world || 'ISOLATED';
    const code = String(s.code || '');
    if (!code.trim()) return {} as ExecResult;
    const tabId = await resolveNodeTabId(ctx);
    const result = await executePageScript({
      tabId,
      frameId: ctx.frameId,
      code,
      mode: 'raw',
      world: world === 'MAIN' ? 'MAIN' : 'ISOLATED',
      owner: 'legacy-workflow-script',
    });
    if (s.saveAs) ctx.vars[s.saveAs] = result;
    if (s.assign && typeof s.assign === 'object') applyAssign(ctx.vars, result, s.assign);
    return {} as ExecResult;
  },
};
