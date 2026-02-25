/**
 * Script Action Handler
 *
 * Executes custom JavaScript in the page context.
 * Supports:
 * - MAIN or ISOLATED world execution
 * - Argument passing with variable resolution
 * - Result capture to variables
 * - Assignment mapping from result paths
 */

import { failed, invalid, ok, tryResolveValue } from '../registry';
import type {
  ActionHandler,
  Assignments,
  BrowserWorld,
  JsonValue,
  Resolvable,
  VariableStore,
} from '../types';

/** Maximum code length to prevent abuse */
const MAX_CODE_LENGTH = 100000;

/**
 * Resolve script arguments
 */
function resolveArgs(
  args: Record<string, Resolvable<JsonValue>> | undefined,
  vars: VariableStore,
): { ok: true; resolved: Record<string, JsonValue> } | { ok: false; error: string } {
  if (!args) return { ok: true, resolved: {} };

  const resolved: Record<string, JsonValue> = {};
  for (const [key, resolvable] of Object.entries(args)) {
    const result = tryResolveValue(resolvable, vars);
    if (!result.ok) {
      return { ok: false, error: `Failed to resolve arg "${key}": ${result.error}` };
    }
    resolved[key] = result.value;
  }

  return { ok: true, resolved };
}

/**
 * Get value from result using dot/bracket path notation
 */
function getValueByPath(obj: unknown, path: string): JsonValue | undefined {
  if (!path || typeof obj !== 'object' || obj === null) {
    return obj as JsonValue;
  }

  // Parse path: supports "data.items[0].name" style
  const segments: Array<string | number> = [];
  const pathRegex = /([^.[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = pathRegex.exec(path)) !== null) {
    if (match[1]) {
      segments.push(match[1]);
    } else if (match[2]) {
      segments.push(parseInt(match[2], 10));
    }
  }

  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }

  return current as JsonValue;
}

/**
 * Apply assignments from result to variables
 */
function applyAssignments(result: JsonValue, assignments: Assignments, vars: VariableStore): void {
  for (const [varName, path] of Object.entries(assignments)) {
    const value = getValueByPath(result, path);
    if (value !== undefined) {
      vars[varName] = value;
    }
  }
}

/**
 * Execute script in page context
 */
async function executeScript(
  tabId: number,
  frameId: number | undefined,
  code: string,
  args: Record<string, JsonValue>,
  world: BrowserWorld,
): Promise<{ ok: true; result: JsonValue } | { ok: false; error: string }> {
  const frameIds = typeof frameId === 'number' ? [frameId] : undefined;

  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, frameIds } as chrome.scripting.InjectionTarget,
      world: world === 'ISOLATED' ? 'ISOLATED' : 'MAIN',
      func: (scriptCode: string, scriptArgs: Record<string, JsonValue>) => {
        try {
          // Create function with args available
          const argNames = Object.keys(scriptArgs);
          const argValues = Object.values(scriptArgs);

          // Wrap code to return result
          const wrappedCode = `
            return (function(${argNames.join(', ')}) {
              ${scriptCode}
            })(${argNames.map((_, i) => `arguments[${i}]`).join(', ')});
          `;

          const fn = new Function(...argNames, wrappedCode);
          const result = fn(...argValues);

          // Handle promises
          if (result instanceof Promise) {
            return result.then(
              (value: unknown) => ({ success: true, result: value }),
              (error: Error) => ({ success: false, error: error?.message || String(error) }),
            );
          }

          return { success: true, result };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      args: [code, args],
    });

    const scriptResult = Array.isArray(injected) ? injected[0]?.result : undefined;

    // Handle async result
    if (scriptResult instanceof Promise) {
      const asyncResult = await scriptResult;
      if (!asyncResult || typeof asyncResult !== 'object') {
        return { ok: false, error: 'Async script returned invalid result' };
      }
      if (!asyncResult.success) {
        return { ok: false, error: asyncResult.error || 'Script failed' };
      }
      return { ok: true, result: asyncResult.result as JsonValue };
    }

    if (!scriptResult || typeof scriptResult !== 'object') {
      return { ok: false, error: 'Script returned invalid result' };
    }

    const typedResult = scriptResult as { success: boolean; result?: unknown; error?: string };
    if (!typedResult.success) {
      return { ok: false, error: typedResult.error || 'Script failed' };
    }

    return { ok: true, result: typedResult.result as JsonValue };
  } catch (e) {
    return {
      ok: false,
      error: `Script execution failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export const scriptHandler: ActionHandler<'script'> = {
  type: 'script',

  validate: (action) => {
    const params = action.params;

    if (!params.code || typeof params.code !== 'string') {
      return invalid('Script action requires a code string');
    }

    if (params.code.length > MAX_CODE_LENGTH) {
      return invalid(`Script code exceeds maximum length of ${MAX_CODE_LENGTH} characters`);
    }

    if (params.world !== undefined && params.world !== 'MAIN' && params.world !== 'ISOLATED') {
      return invalid(`Invalid world: ${String(params.world)}`);
    }

    if (params.when !== undefined && params.when !== 'before' && params.when !== 'after') {
      return invalid(`Invalid timing: ${String(params.when)}`);
    }

    return ok();
  },

  describe: (action) => {
    const world = action.params.world === 'ISOLATED' ? '[isolated]' : '';
    const timing = action.params.when ? `(${action.params.when})` : '';
    return `Script ${world}${timing}`.trim();
  },

  run: async (ctx, action) => {
    const tabId = ctx.tabId;
    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found for script action');
    }

    const params = action.params;
    const world: BrowserWorld = params.world || 'MAIN';

    // Resolve arguments
    const argsResult = resolveArgs(params.args, ctx.vars);
    if (!argsResult.ok) {
      return failed('VALIDATION_ERROR', argsResult.error);
    }

    // Execute script
    const result = await executeScript(tabId, ctx.frameId, params.code, argsResult.resolved, world);

    if (!result.ok) {
      return failed('SCRIPT_FAILED', result.error);
    }

    // Store result if saveAs specified
    if (params.saveAs) {
      ctx.vars[params.saveAs] = result.result;
    }

    // Apply assignments if specified
    if (params.assign) {
      applyAssignments(result.result, params.assign, ctx.vars);
    }

    return {
      status: 'success',
      output: { result: result.result },
    };
  },
};
