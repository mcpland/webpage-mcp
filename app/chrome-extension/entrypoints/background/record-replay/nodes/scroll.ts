import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepScroll } from '../types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { resolveNodeTabId } from './tab-context';

export const scrollNode: NodeRuntime<StepScroll> = {
  run: async (ctx, step: StepScroll) => {
    const s = expandTemplatesDeep(step as StepScroll, ctx.vars);
    const tabId = await resolveNodeTabId(ctx);
    const top = s.offset?.y ?? undefined;
    const left = s.offset?.x ?? undefined;
    const selectorFromTarget = (s as any).target?.candidates?.find(
      (c: any) => c.type === 'css' || c.type === 'attr',
    )?.value;
    let code = '';
    if (s.mode === 'offset' && !(s as any).target) {
      const t = top != null ? Number(top) : 'undefined';
      const l = left != null ? Number(left) : 'undefined';
      code = `try { window.scrollTo({ top: ${t}, left: ${l}, behavior: 'instant' }); } catch (e) {}`;
    } else if (s.mode === 'element' && selectorFromTarget) {
      code = `(() => { try { const el = document.querySelector(${JSON.stringify(selectorFromTarget)}); if (el) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); } catch (e) {} })();`;
    } else if (s.mode === 'container' && selectorFromTarget) {
      const t = top != null ? Number(top) : 'undefined';
      const l = left != null ? Number(left) : 'undefined';
      code = `(() => { try { const el = document.querySelector(${JSON.stringify(selectorFromTarget)}); if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: ${t}, left: ${l}, behavior: 'instant' }); } catch (e) {} })();`;
    } else {
      const direction = top != null && Number(top) < 0 ? 'up' : 'down';
      const amount = 3;
      const res = await handleCallTool({
        name: TOOL_NAMES.BROWSER.COMPUTER,
        args: { action: 'scroll', scrollDirection: direction, scrollAmount: amount, tabId },
      });
      if ((res as any).isError) throw new Error('scroll failed');
      return {} as ExecResult;
    }
    if (code) {
      const res = await handleCallTool({
        name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
        args: { type: 'MAIN', jsScript: code, tabId },
      });
      if ((res as any).isError) throw new Error('scroll failed');
    }
    return {} as ExecResult;
  },
};
