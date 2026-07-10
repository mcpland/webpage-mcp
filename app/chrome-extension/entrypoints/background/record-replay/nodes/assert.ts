import { TOOL_NAMES } from "webpage-mcp-shared";
import { handleCallTool } from "@/entrypoints/background/tools";
import type { StepAssert } from "../types";
import { expandTemplatesDeep } from "../rr-utils";
import type { ExecCtx, ExecResult, NodeRuntime } from "./types";
import { resolveNodeTabId } from "./tab-context";
import { testWorkflowRegex } from "../workflow-regex";

export const assertNode: NodeRuntime<StepAssert> = {
  validate: (step) => {
    const s = step as any;
    const ok = !!s.assert;
    if (ok && s.assert && "attribute" in s.assert) {
      const a = s.assert.attribute || {};
      if (!a.selector || !a.name)
        return {
          ok: false,
          errors: ["assert.attribute: selector and name are required"],
        };
    }
    return ok ? { ok } : { ok, errors: ["Missing assertion condition"] };
  },
  run: async (ctx: ExecCtx, step: StepAssert) => {
    const s = expandTemplatesDeep(step as StepAssert, ctx.vars) as any;
    const failStrategy = (s as any).failStrategy || "stop";
    const fail = (msg: string) => {
      if (failStrategy === "warn") {
        ctx.logger({
          stepId: (step as any).id,
          status: "warning",
          message: msg,
        });
        return { alreadyLogged: true } as any;
      }
      throw new Error(msg);
    };
    if ("textPresent" in s.assert) {
      const text = (s.assert as any).textPresent;
      const tabId = await resolveNodeTabId(ctx);
      const res = await handleCallTool({
        name: TOOL_NAMES.BROWSER.COMPUTER,
        args: {
          action: "wait",
          text,
          appear: true,
          timeout: (step as any).timeoutMs || 5000,
          tabId,
        },
      });
      if ((res as any).isError) return fail("assert text failed");
    } else if ("exists" in s.assert || "visible" in s.assert) {
      const selector = (s.assert as any).exists || (s.assert as any).visible;
      const tabId = await resolveNodeTabId(ctx);
      await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });
      const ensured: any = (await chrome.tabs.sendMessage(
        tabId,
        {
          action: "ensureRefForSelector",
          selector,
        } as any,
        { frameId: ctx.frameId } as any,
      )) as any;
      if (!ensured || !ensured.success)
        return fail("assert selector not found");
      if ("visible" in s.assert) {
        const rect = ensured && ensured.center ? ensured.center : null;
        if (!rect) return fail("assert visible failed");
      }
    } else if ("attribute" in s.assert) {
      const { selector, name, equals, matches } =
        (s.assert as any).attribute || {};
      const tabId = await resolveNodeTabId(ctx);
      await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });
      const resp: any = (await chrome.tabs.sendMessage(
        tabId,
        { action: "getAttributeForSelector", selector, name } as any,
        { frameId: ctx.frameId } as any,
      )) as any;
      if (!resp || !resp.success)
        return fail("assert attribute: element not found");
      const actual: string | null = resp.value ?? null;
      if (equals !== undefined && equals !== null) {
        const expected = String(equals);
        if (String(actual) !== String(expected))
          return fail(
            `assert attribute equals failed: ${name} actual=${String(actual)} expected=${String(expected)}`,
          );
      } else if (matches !== undefined && matches !== null) {
        const regexResult = testWorkflowRegex(String(matches), String(actual));
        if (!regexResult.ok) {
          return fail(
            `assert attribute regex rejected (${regexResult.code}): ${regexResult.message}`,
          );
        }
        if (!regexResult.matched) {
          return fail("assert attribute matches failed");
        }
      } else {
        if (actual == null)
          return fail(`assert attribute failed: ${name} missing`);
      }
    }
    return {} as ExecResult;
  },
};
