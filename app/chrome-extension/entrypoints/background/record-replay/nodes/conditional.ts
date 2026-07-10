import type { Step } from "../types";
import { evalExpression } from "../engine/utils/expression";
import type { ExecCtx, ExecResult, NodeRuntime } from "./types";

export const ifNode: NodeRuntime<any> = {
  validate: (step) => {
    const s = step as any;
    const hasBranches = Array.isArray(s.branches) && s.branches.length > 0;
    const ok = hasBranches || !!s.condition;
    return ok ? { ok } : { ok, errors: ["Missing condition or branch"] };
  },
  run: async (ctx: ExecCtx, step: Step) => {
    const s: any = step;
    if (Array.isArray(s.branches) && s.branches.length > 0) {
      const evalExpr = (expr: string): boolean => {
        const code = String(expr || "").trim();
        if (!code) return false;
        return !!evalExpression(code, { vars: ctx.vars });
      };
      for (const br of s.branches) {
        if (br?.expr && evalExpr(String(br.expr)))
          return {
            nextLabel: String(br.label || `case:${br.id || "match"}`),
          } as ExecResult;
      }
      if ("else" in s)
        return { nextLabel: String(s.else || "default") } as ExecResult;
      return { nextLabel: "default" } as ExecResult;
    }
    // legacy condition: { var/equals | expression }
    try {
      let result = false;
      const cond = s.condition;
      if (
        cond &&
        typeof cond.expression === "string" &&
        cond.expression.trim()
      ) {
        result = !!evalExpression(cond.expression, { vars: ctx.vars });
      } else if (cond && typeof cond.var === "string") {
        const v = ctx.vars[cond.var];
        if ("equals" in cond) result = String(v) === String(cond.equals);
        else result = !!v;
      }
      return { nextLabel: result ? "true" : "false" } as ExecResult;
    } catch {
      return { nextLabel: "false" } as ExecResult;
    }
  },
};
