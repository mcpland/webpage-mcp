import { describe, expect, it } from "vitest";
import {
  EXPRESSION_LIMITS,
  evalExpression,
} from "@/entrypoints/background/record-replay/engine/utils/expression";
import { ifNode } from "@/entrypoints/background/record-replay/nodes/conditional";

describe("record/replay expression evaluation", () => {
  it("evaluates bounded vars and workflow aliases without dynamic code", () => {
    const vars = { count: 3, nested: { ready: true }, label: "ok" };

    expect(
      evalExpression("vars.count * 2 >= 6 && vars.nested.ready", { vars }),
    ).toBe(true);
    expect(evalExpression('workflow.label === "ok"', { vars })).toBe(true);
    expect(evalExpression("vars.count !== 3", { vars })).toBe(false);
  });

  it("fails closed for global access, calls, unsafe paths, and malformed tokens", () => {
    const vars = { count: 3 };

    expect(evalExpression("globalThis.fetch", { vars })).toBe(false);
    expect(evalExpression("vars.count.toString()", { vars })).toBe(false);
    expect(evalExpression("vars.__proto__.polluted", { vars })).toBe(false);
    expect(evalExpression("vars.count ? true : false", { vars })).toBe(false);
    expect(evalExpression('"unterminated', { vars })).toBe(false);
  });

  it("fails closed when expression resource limits are exceeded", () => {
    const oversized = `vars.value${" ".repeat(EXPRESSION_LIMITS.maxChars)}`;
    const deeplyNested = `${"(".repeat(EXPRESSION_LIMITS.maxNesting + 1)}true${")".repeat(
      EXPRESSION_LIMITS.maxNesting + 1,
    )}`;
    const tooManyTokens = Array.from(
      { length: EXPRESSION_LIMITS.maxTokens + 1 },
      () => "true",
    ).join(" || ");

    expect(evalExpression(oversized, { vars: { value: true } })).toBe(false);
    expect(evalExpression(deeplyNested, { vars: {} })).toBe(false);
    expect(evalExpression(tooManyTokens, { vars: {} })).toBe(false);
  });

  it("routes legacy branches through the safe evaluator", async () => {
    const context = { vars: { total: 5 }, logger: () => undefined };
    const result = await ifNode.run(context, {
      id: "condition-1",
      type: "if",
      branches: [
        { id: "no", label: "small", expr: "vars.total < 3" },
        { id: "yes", label: "large", expr: "workflow.total >= 5" },
      ],
    } as never);

    expect(result).toEqual({ nextLabel: "large" });
  });
});
