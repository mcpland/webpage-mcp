import type { Step } from '../types';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const ifNode: NodeRuntime<any> = {
  validate: (step) => {
    const s = step as any;
    const hasBranches = Array.isArray(s.branches) && s.branches.length > 0;
    const ok = hasBranches || !!s.condition;
    return ok ? { ok } : { ok, errors: ['缺少条件或分支'] };
  },
  run: async (ctx: ExecCtx, step: Step) => {
    const s: any = step;
    if (Array.isArray(s.branches) && s.branches.length > 0) {
      const evalExpr = (expr: string): boolean => {
        const code = String(expr || '').trim();
        if (!code) return false;
        try {
          const fn = new Function(
            'vars',
            'workflow',
            `try { return !!(${code}); } catch (e) { return false; }`,
          );
          return !!fn(ctx.vars, ctx.vars);
        } catch {
          return false;
        }
      };
      for (const br of s.branches) {
        if (br?.expr && evalExpr(String(br.expr)))
          return { nextLabel: String(br.label || `case:${br.id || 'match'}`) } as ExecResult;
      }
      if ('else' in s) return { nextLabel: String(s.else || 'default') } as ExecResult;
      return { nextLabel: 'default' } as ExecResult;
    }
    // legacy condition: { var/equals | expression }
    try {
      let result = false;
      const cond = s.condition;
      if (cond && typeof cond.expression === 'string' && cond.expression.trim()) {
        const fn = new Function(
          'vars',
          `try { return !!(${cond.expression}); } catch (e) { return false; }`,
        );
        result = !!fn(ctx.vars);
      } else if (cond && typeof cond.var === 'string') {
        const v = ctx.vars[cond.var];
        if ('equals' in cond) result = String(v) === String(cond.equals);
        else result = !!v;
      }
      return { nextLabel: result ? 'true' : 'false' } as ExecResult;
    } catch {
      return { nextLabel: 'false' } as ExecResult;
    }
  },
};
