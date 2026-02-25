/**
 * @fileoverview V2 ActionHandler -> V3 NodeDefinition adapter
 * @description Bridges legacy RR-V2 action handlers into the RR-V3 PluginRegistry.
 *
 * Design notes:
 * - V3 requires variable mutations to be represented as varsPatch so they are auditable in the event log.
 * - V2 handlers mutate ctx.vars directly, so we run them against a cloned VariableStore and diff it.
 * - Cross-node state (tabId/frameId changes from switchFrame/openTab/switchTab) is persisted in internal vars.
 *
 * WARNING: This adapter accesses V2 handler internals and may need updates if V2 types change.
 */

import { z } from 'zod';

import type {
  ActionExecutionContext,
  ActionExecutionResult,
  ActionHandler,
  ActionError,
  ActionErrorCode,
  ActionPolicy,
  ExecutableActionType,
  ValidationResult,
  Action,
} from '@/entrypoints/background/record-replay/actions/types';

import type { JsonValue, JsonObject } from '../../domain/json';
import { RR_ERROR_CODES, createRRError, type RRError, type RRErrorCode } from '../../domain/errors';
import type { NodePolicy } from '../../domain/policy';
import { mergeNodePolicy } from '../../domain/policy';

import type {
  NodeDefinition,
  NodeExecutionContext,
  NodeExecutionResult,
  VarsPatchOp,
} from './types';

// Internal run-scoped state keys used to emulate V2 "mutable context" across nodes.
const DEFAULT_TAB_ID_VAR = '__rr_v2__tabId';
const DEFAULT_FRAME_ID_VAR = '__rr_v2__frameId';

export interface V2ActionNodeAdapterOptions {
  /**
   * Whether to emit v2 ActionExecutionResult.output into V3 NodeExecutionResult.outputs.
   * Defaults to true.
   */
  includeOutput?: boolean;

  /**
   * Where to store cross-node "mutable context" state (tabId/frameId).
   * Defaults are "__rr_v2__tabId" and "__rr_v2__frameId".
   */
  stateVars?: {
    tabIdVar?: string;
    frameIdVar?: string;
  };

  /**
   * Execution flags forwarded into V2 ActionExecutionContext.execution.
   * Keep default undefined to preserve V2 handler behavior.
   */
  executionFlags?: ActionExecutionContext['execution'];
}

// ==================== Utilities ====================

function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e)
    return String((e as { message: unknown }).message);
  return String(e);
}

function deepClone<T>(value: T): T {
  const sc = (globalThis as unknown as { structuredClone?: <U>(v: U) => U }).structuredClone;
  if (typeof sc === 'function') return sc(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value);
    return JSON.parse(s) as JsonValue;
  } catch {
    return String(value);
  }
}

function mapLogLevel(level: 'info' | 'warn' | 'error' | undefined): 'info' | 'warn' | 'error' {
  return level ?? 'info';
}

function mapV2ErrorCode(code: ActionErrorCode): RRErrorCode {
  switch (code) {
    case 'VALIDATION_ERROR':
      return RR_ERROR_CODES.VALIDATION_ERROR;
    case 'TIMEOUT':
      return RR_ERROR_CODES.TIMEOUT;
    case 'TAB_NOT_FOUND':
      return RR_ERROR_CODES.TAB_NOT_FOUND;
    case 'FRAME_NOT_FOUND':
      return RR_ERROR_CODES.FRAME_NOT_FOUND;
    case 'TARGET_NOT_FOUND':
      return RR_ERROR_CODES.TARGET_NOT_FOUND;
    case 'ELEMENT_NOT_VISIBLE':
      return RR_ERROR_CODES.ELEMENT_NOT_VISIBLE;
    case 'NAVIGATION_FAILED':
      return RR_ERROR_CODES.NAVIGATION_FAILED;
    case 'NETWORK_REQUEST_FAILED':
      return RR_ERROR_CODES.NETWORK_REQUEST_FAILED;
    case 'SCRIPT_FAILED':
      return RR_ERROR_CODES.SCRIPT_FAILED;

    // V3 doesn't currently have dedicated codes for these.
    case 'DOWNLOAD_FAILED':
    case 'ASSERTION_FAILED':
      return RR_ERROR_CODES.TOOL_ERROR;

    case 'UNKNOWN':
    default:
      return RR_ERROR_CODES.INTERNAL;
  }
}

function toRRErrorFromV2(error: ActionError): RRError {
  const data = error.data !== undefined ? safeJsonValue(error.data) : undefined;
  return createRRError(
    mapV2ErrorCode(error.code),
    error.message,
    data !== undefined ? { data } : undefined,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray || bIsArray) {
    if (!aIsArray || !bIsArray) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEquals(a[i] as JsonValue, b[i] as JsonValue)) return false;
    }
    return true;
  }

  const aIsObj = isRecord(a);
  const bIsObj = isRecord(b);
  if (aIsObj || bIsObj) {
    if (!aIsObj || !bIsObj) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!jsonEquals(a[k] as JsonValue, (b as Record<string, unknown>)[k] as JsonValue))
        return false;
    }
    return true;
  }

  return false;
}

function diffVars(
  before: Record<string, JsonValue>,
  after: Record<string, JsonValue>,
): VarsPatchOp[] {
  const patch: VarsPatchOp[] = [];
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    const beforeHas = Object.prototype.hasOwnProperty.call(before, key);
    const afterHas = Object.prototype.hasOwnProperty.call(after, key);

    if (!afterHas) {
      if (beforeHas) patch.push({ op: 'delete', name: key });
      continue;
    }

    const afterVal = after[key];
    if (!beforeHas) {
      patch.push({ op: 'set', name: key, value: afterVal });
      continue;
    }

    const beforeVal = before[key];
    if (!jsonEquals(beforeVal, afterVal)) {
      patch.push({ op: 'set', name: key, value: afterVal });
    }
  }

  return patch;
}

function readNumberVar(vars: Record<string, JsonValue>, key: string): number | undefined {
  const v = vars[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toV2ActionPolicy(policy: NodePolicy | undefined): ActionPolicy | undefined {
  if (!policy) return undefined;

  const timeout = policy.timeout
    ? {
        ms: policy.timeout.ms,
        scope: policy.timeout.scope === 'node' ? ('action' as const) : ('attempt' as const),
      }
    : undefined;

  // NodePolicy/ActionPolicy are structurally similar; we only normalize timeout.scope.
  return {
    ...(timeout ? { timeout } : {}),
    ...(policy.retry ? { retry: policy.retry as unknown as ActionPolicy['retry'] } : {}),
    ...(policy.artifacts
      ? { artifacts: policy.artifacts as unknown as ActionPolicy['artifacts'] }
      : {}),
    ...(policy.onError
      ? (() => {
          // V2 only supports goto by edge label. Node-target goto can't be represented.
          if (policy.onError.kind === 'goto' && policy.onError.target.kind === 'node') {
            return { onError: { kind: 'stop' } as ActionPolicy['onError'] };
          }
          if (policy.onError.kind === 'continue') {
            return {
              onError: {
                kind: 'continue',
                level: policy.onError.as,
              } as ActionPolicy['onError'],
            };
          }
          if (policy.onError.kind === 'goto') {
            const target = policy.onError.target;
            if (target.kind === 'edgeLabel') {
              return {
                onError: {
                  kind: 'goto',
                  label: target.label,
                } as ActionPolicy['onError'],
              };
            }
            // Node target can't be represented in V2, fall through to stop
            return { onError: { kind: 'stop' } as ActionPolicy['onError'] };
          }
          if (policy.onError.kind === 'retry') {
            // V2 has retry policy on action.policy.retry; keep onError as stop to avoid double semantics.
            return { onError: { kind: 'stop' } as ActionPolicy['onError'] };
          }
          return { onError: policy.onError as unknown as ActionPolicy['onError'] };
        })()
      : {}),
  };
}

function toJsonRecord(value: unknown): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  if (!isRecord(value)) return out;

  for (const [k, v] of Object.entries(value)) {
    // Treat undefined as deletion (omit).
    if (v === undefined) continue;
    out[k] = safeJsonValue(v);
  }

  return out;
}

// ==================== Main Adapter ====================

/**
 * Adapt a single V2 ActionHandler into a V3 NodeDefinition.
 */
export function adaptV2ActionHandlerToV3NodeDefinition<T extends ExecutableActionType>(
  handler: ActionHandler<T>,
  options: V2ActionNodeAdapterOptions = {},
): NodeDefinition<T, JsonObject> {
  const tabIdVar = options.stateVars?.tabIdVar ?? DEFAULT_TAB_ID_VAR;
  const frameIdVar = options.stateVars?.frameIdVar ?? DEFAULT_FRAME_ID_VAR;

  return {
    kind: handler.type,
    schema: z.record(z.any()) as unknown as NodeDefinition<T, JsonObject>['schema'],
    execute: async (ctx: NodeExecutionContext, node): Promise<NodeExecutionResult> => {
      const beforeVars = ctx.vars;

      const effectiveTabId = readNumberVar(beforeVars, tabIdVar) ?? ctx.tabId;
      const effectiveFrameId = readNumberVar(beforeVars, frameIdVar);

      // Run against a cloned variable store to prevent bypassing vars.patch event stream.
      const v2Vars = deepClone(beforeVars) as unknown as Record<string, unknown>;

      const v2Ctx: ActionExecutionContext = {
        vars: v2Vars as unknown as ActionExecutionContext['vars'],
        tabId: effectiveTabId,
        frameId: effectiveFrameId,
        runId: ctx.runId,
        log: (message, level) => ctx.log(mapLogLevel(level), message),
        pushLog: (entry) => {
          try {
            ctx.log('debug', 'v2.pushLog', safeJsonValue(entry));
          } catch {
            // ignore
          }
        },
        captureScreenshot: async () => {
          const r = await ctx.artifacts.screenshot();
          if (r.ok) return r.base64;
          throw new Error(r.error.message);
        },
        ...(options.executionFlags ? { execution: options.executionFlags } : {}),
      };

      const effectivePolicy = mergeNodePolicy(ctx.flow.policy?.defaultNodePolicy, node.policy);
      const v2Policy = toV2ActionPolicy(effectivePolicy);

      const action: Action<T> = {
        id: node.id as Action<T>['id'],
        type: handler.type,
        ...(node.name ? { name: node.name } : {}),
        ...(node.disabled ? { disabled: true } : {}),
        ...(v2Policy ? { policy: v2Policy } : {}),
        params: node.config as unknown as Action<T>['params'],
        ...(node.ui ? { ui: node.ui as Action<T>['ui'] } : {}),
      };

      // V2 handler-level validation
      if (handler.validate) {
        const v: ValidationResult = handler.validate(action);
        if (!v.ok) {
          return {
            status: 'failed',
            error: createRRError(RR_ERROR_CODES.VALIDATION_ERROR, v.errors.join(', ')),
          };
        }
      }

      let result: ActionExecutionResult<T>;
      try {
        result = await handler.run(v2Ctx, action);
      } catch (e) {
        return {
          status: 'failed',
          error: createRRError(
            RR_ERROR_CODES.INTERNAL,
            `V2 handler "${handler.type}" threw: ${toErrorMessage(e)}`,
          ),
        };
      }

      if (result.status === 'failed') {
        const err = result.error
          ? toRRErrorFromV2(result.error)
          : createRRError(RR_ERROR_CODES.INTERNAL, `V2 handler "${handler.type}" failed`);
        return { status: 'failed', error: err };
      }

      if (result.status === 'paused') {
        return {
          status: 'failed',
          error: createRRError(
            RR_ERROR_CODES.RUN_PAUSED,
            `V2 handler "${handler.type}" returned paused (not supported in V3 NodeExecutionResult)`,
          ),
        };
      }

      // V3 does not support V2 scheduler control directives (foreach/while).
      if (result.control) {
        return {
          status: 'failed',
          error: createRRError(
            RR_ERROR_CODES.UNSUPPORTED_NODE,
            `V2 control directive "${result.control.kind}" is not supported by the V3 runner`,
            { data: safeJsonValue(result.control) },
          ),
        };
      }

      // Persist cross-node context changes via internal vars.
      if (typeof v2Ctx.frameId === 'number' && Number.isFinite(v2Ctx.frameId)) {
        v2Vars[frameIdVar] = v2Ctx.frameId;
      } else {
        delete v2Vars[frameIdVar];
      }

      if (typeof result.newTabId === 'number' && Number.isFinite(result.newTabId)) {
        v2Vars[tabIdVar] = result.newTabId;
      }

      const afterVars = toJsonRecord(v2Vars);
      const varsPatch = diffVars(beforeVars, afterVars);

      const outputs: Record<string, JsonValue> | undefined =
        options.includeOutput === false || result.output === undefined
          ? undefined
          : { [node.id]: safeJsonValue(result.output) };

      return {
        status: 'succeeded',
        ...(result.nextLabel ? { next: ctx.chooseNext(result.nextLabel) } : {}),
        ...(outputs ? { outputs } : {}),
        ...(varsPatch.length > 0 ? { varsPatch } : {}),
      };
    },
  };
}
