/**
 * Action Registry - Action Executor registry and execution pipeline
 *
 * Features:
 * - Dynamically register/unregister handler
 * - Middleware/hook mechanism (beforeExecute, afterExecute)
 * - Retry and timeout strategies
 * - type safety
 */

import type {
  Action,
  ActionError,
  ActionErrorCode,
  ActionExecutionContext,
  ActionExecutionResult,
  ActionHandler,
  EdgeLabel,
  ElementTarget,
  ExecutableAction,
  ExecutableActionType,
  FrameTarget,
  JsonValue,
  NonEmptyArray,
  Resolvable,
  RetryPolicy,
  SelectorCandidate,
  TimeoutPolicy,
  ValidationResult,
  VariablePathSegment,
  VariablePointer,
  VariableStore,
} from './types';
import {
  normalizeWorkflowNodeSideEffectProfile,
  workflowSideEffectAllowsRetry,
} from 'webpage-mcp-shared';
import {
  boundedRetryCount,
  boundedRetryDelay,
} from '../engine/policies/retry-limits';
import { boundedActionTimeout } from '../engine/policies/timeout-limits';

// ================================
// type definition
// ================================

type AnyExecutableAction = {
  [T in ExecutableActionType]: ExecutableAction<T>;
}[ExecutableActionType];
type AnyExecutableHandler = { [T in ExecutableActionType]: ActionHandler<T> }[ExecutableActionType];

export interface BeforeExecuteArgs<T extends ExecutableActionType> {
  ctx: ActionExecutionContext;
  action: ExecutableAction<T>;
  handler: ActionHandler<T>;
  attempt: number;
}

export type BeforeExecuteHook = <T extends ExecutableActionType>(
  args: BeforeExecuteArgs<T>,
) => void | ActionExecutionResult<T> | Promise<void | ActionExecutionResult<T>>;

export interface AfterExecuteArgs<T extends ExecutableActionType> {
  ctx: ActionExecutionContext;
  action: ExecutableAction<T>;
  handler: ActionHandler<T>;
  result: ActionExecutionResult<T>;
  attempt: number;
}

export type AfterExecuteHook = <T extends ExecutableActionType>(
  args: AfterExecuteArgs<T>,
) => void | ActionExecutionResult<T> | Promise<void | ActionExecutionResult<T>>;

export interface ActionRegistryHooks {
  beforeExecute?: BeforeExecuteHook;
  afterExecute?: AfterExecuteHook;
}

// ================================
// Utility functions
// ================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNonEmptyArray(value: string[], fallback: string): NonEmptyArray<string> {
  return (value.length > 0 ? value : [fallback]) as NonEmptyArray<string>;
}

const ACTION_ERROR_CODES: ReadonlyArray<ActionErrorCode> = [
  'VALIDATION_ERROR',
  'TIMEOUT',
  'TAB_NOT_FOUND',
  'FRAME_NOT_FOUND',
  'TARGET_NOT_FOUND',
  'ELEMENT_NOT_VISIBLE',
  'NAVIGATION_FAILED',
  'NETWORK_REQUEST_FAILED',
  'DOWNLOAD_FAILED',
  'ASSERTION_FAILED',
  'SCRIPT_FAILED',
  'UNKNOWN',
] as const;

function isActionErrorCode(value: unknown): value is ActionErrorCode {
  return typeof value === 'string' && (ACTION_ERROR_CODES as ReadonlyArray<string>).includes(value);
}

function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (isRecord(e) && typeof e.message === 'string') return e.message;
  return 'Unknown error';
}

function toActionError(e: unknown, fallbackCode: ActionErrorCode = 'UNKNOWN'): ActionError {
  if (isRecord(e) && isActionErrorCode(e.code) && typeof e.message === 'string') {
    return { code: e.code, message: e.message, data: undefined };
  }
  return { code: fallbackCode, message: toErrorMessage(e) };
}

export function ok(): ValidationResult {
  return { ok: true };
}

export function invalid(...errors: string[]): ValidationResult {
  return { ok: false, errors: toNonEmptyArray(errors.filter(Boolean), 'Validation failed') };
}

export function failed<T extends ExecutableActionType>(
  code: ActionErrorCode,
  message: string,
): ActionExecutionResult<T> {
  return { status: 'failed', error: { code, message } };
}

function sleep(ms: number): Promise<void> {
  const safe = Math.max(0, Math.floor(ms));
  return new Promise((resolve) => setTimeout(resolve, safe));
}

// ================================
// Resolvable parser
// ================================

function isVariablePointer(value: unknown): value is VariablePointer {
  if (!isRecord(value)) return false;
  if (typeof value.name !== 'string' || value.name.length === 0) return false;
  if (value.path === undefined) return true;
  if (!Array.isArray(value.path)) return false;
  return value.path.every((s) => typeof s === 'string' || typeof s === 'number');
}

function isVarValue(
  value: unknown,
): value is { kind: 'var'; ref: VariablePointer; default?: unknown } {
  if (!isRecord(value)) return false;
  if (value.kind !== 'var') return false;
  return isVariablePointer(value.ref);
}

function isExprValue(value: unknown): value is { kind: 'expr'; default?: unknown } {
  if (!isRecord(value)) return false;
  if (value.kind !== 'expr') return false;
  return 'expr' in value;
}

function isStringTemplate(value: unknown): value is { kind: 'template'; parts: unknown[] } {
  if (!isRecord(value)) return false;
  if (value.kind !== 'template') return false;
  return Array.isArray(value.parts) && value.parts.length > 0;
}

function readByPath(
  value: JsonValue,
  path?: ReadonlyArray<VariablePathSegment>,
): JsonValue | undefined {
  if (!path || path.length === 0) return value;
  let cur: JsonValue | undefined = value;
  for (const seg of path) {
    if (cur === undefined || cur === null) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg] as JsonValue | undefined;
      continue;
    }
    if (typeof seg === 'string') {
      if (!isRecord(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg] as JsonValue | undefined;
      continue;
    }
    return undefined;
  }
  return cur;
}

export function tryResolveJson(
  value: Resolvable<JsonValue>,
  vars: VariableStore,
): { ok: true; value: JsonValue } | { ok: false; error: string } {
  if (isVarValue(value)) {
    const ref = value.ref;
    const root = vars[ref.name];
    const resolved = root === undefined ? undefined : readByPath(root, ref.path);
    if (resolved !== undefined) return { ok: true, value: resolved };
    if ('default' in value) return { ok: true, value: (value.default ?? null) as JsonValue };
    return { ok: true, value: null };
  }
  if (isExprValue(value)) {
    if ('default' in value) return { ok: true, value: (value.default ?? null) as JsonValue };
    return { ok: false, error: 'Expression value is not supported by the default resolver' };
  }
  return { ok: true, value };
}

function formatInserted(value: JsonValue, format?: 'text' | 'json' | 'urlEncoded'): string {
  if (format === 'json') return JSON.stringify(value);
  const text = value === null ? '' : typeof value === 'string' ? value : String(value);
  if (format === 'urlEncoded') return encodeURIComponent(text);
  return text;
}

export function tryResolveString(
  value: Resolvable<string>,
  vars: VariableStore,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value === 'string') return { ok: true, value };
  if (isVarValue(value)) {
    const ref = value.ref;
    const root = vars[ref.name];
    const resolved = root === undefined ? undefined : readByPath(root, ref.path);
    if (resolved !== undefined && resolved !== null) return { ok: true, value: String(resolved) };
    if ('default' in value && typeof value.default === 'string')
      return { ok: true, value: value.default };
    return { ok: true, value: '' };
  }
  if (isStringTemplate(value)) {
    const parts = value.parts;
    let out = '';
    for (const p of parts) {
      if (!isRecord(p) || typeof p.kind !== 'string')
        return { ok: false, error: 'Invalid template part' };
      if (p.kind === 'text') {
        if (typeof p.value !== 'string') return { ok: false, error: 'Invalid template text part' };
        out += p.value;
        continue;
      }
      if (p.kind === 'insert') {
        const resolved = tryResolveJson(p.value as Resolvable<JsonValue>, vars);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        out += formatInserted(
          resolved.value,
          (p.format as 'text' | 'json' | 'urlEncoded' | undefined) ?? 'text',
        );
        continue;
      }
      return {
        ok: false,
        error: `Unknown template part kind: ${String((p as { kind: string }).kind)}`,
      };
    }
    return { ok: true, value: out };
  }
  if (isExprValue(value)) {
    if ('default' in value && typeof value.default === 'string')
      return { ok: true, value: value.default };
    return { ok: false, error: 'Expression value is not supported by the default resolver' };
  }
  return { ok: false, error: 'Unsupported resolvable string value' };
}

export function tryResolveNumber(
  value: Resolvable<number>,
  vars: VariableStore,
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
  if (isVarValue(value)) {
    const ref = value.ref;
    const root = vars[ref.name];
    const resolved = root === undefined ? undefined : readByPath(root, ref.path);
    if (typeof resolved === 'number' && Number.isFinite(resolved))
      return { ok: true, value: resolved };
    if (typeof resolved === 'string' && resolved.trim() !== '') {
      const n = Number(resolved);
      if (Number.isFinite(n)) return { ok: true, value: n };
    }
    if ('default' in value && typeof value.default === 'number' && Number.isFinite(value.default))
      return { ok: true, value: value.default };
    return { ok: false, error: `Variable "${ref.name}" is not a finite number` };
  }
  if (isExprValue(value)) {
    if ('default' in value && typeof value.default === 'number' && Number.isFinite(value.default))
      return { ok: true, value: value.default };
    return { ok: false, error: 'Expression value is not supported by the default resolver' };
  }
  return { ok: false, error: 'Unsupported resolvable number value' };
}

/**
 * Resolve a generic JSON value (alias for tryResolveJson)
 * Useful for script/http handlers that work with arbitrary JSON
 */
export const tryResolveValue = tryResolveJson;

// ================================
// Retry and timeout logic
// ================================

function shouldRetry(policy: RetryPolicy | undefined, error: ActionError | undefined): boolean {
  if (!policy) return false;
  if (policy.retries <= 0) return false;
  if (!error) return false;
  if (error.code === 'VALIDATION_ERROR') return false;
  if (policy.retryOn && policy.retryOn.length > 0) return policy.retryOn.includes(error.code);
  return true;
}

function computeRetryDelayMs(policy: RetryPolicy, retryIndex: number): number {
  const backoff = policy.backoff ?? 'none';
  const capped = boundedRetryDelay(
    policy.intervalMs,
    retryIndex,
    backoff,
    policy.maxIntervalMs,
  );
  if ((policy.jitter ?? 'none') === 'full') return Math.floor(Math.random() * capped);
  return capped;
}

async function runWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number | undefined,
): Promise<{ ok: true; value: T } | { ok: false; error: ActionError }> {
  if (timeoutMs === undefined) {
    try {
      return { ok: true, value: await run() };
    } catch (e) {
      return { ok: false, error: toActionError(e) };
    }
  }

  const ms = Math.max(0, Math.floor(timeoutMs));
  if (ms === 0) return { ok: false, error: { code: 'TIMEOUT', message: 'Timeout reached' } };

  return await new Promise((resolve) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      resolve({ ok: false, error: { code: 'TIMEOUT', message: 'Timeout reached' } });
    }, ms);

    run()
      .then((value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      })
      .catch((e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: toActionError(e) });
      });
  });
}

// ================================
// ActionRegistry class
// ================================

export class ActionRegistry {
  private readonly handlers: { [T in ExecutableActionType]?: ActionHandler<T> } = {};
  private readonly beforeHooks: BeforeExecuteHook[] = [];
  private readonly afterHooks: AfterExecuteHook[] = [];

  /**
   * Register action handler
   */
  register<T extends ExecutableActionType>(
    handler: ActionHandler<T>,
    options?: { override?: boolean },
  ): void {
    const override = options?.override !== false;
    const existing = this.handlers[handler.type];
    if (existing && !override) {
      throw new Error(`Handler already registered for type: ${handler.type}`);
    }
    // Type assertion needed due to TypeScript mapped type limitation

    (this.handlers as Record<ExecutableActionType, ActionHandler<any>>)[handler.type] = handler;
  }

  /**
   * Logout action handler
   */
  unregister<T extends ExecutableActionType>(type: T): boolean {
    const exists = this.handlers[type] !== undefined;
    delete this.handlers[type];
    return exists;
  }

  /**
   * Get handler
   */
  get<T extends ExecutableActionType>(type: T): ActionHandler<T> | undefined {
    return this.handlers[type];
  }

  /**
   * Check if handler exists
   */
  has(type: ExecutableActionType): boolean {
    return this.handlers[type] !== undefined;
  }

  /**
   * List all registered handlers
   */
  list(): ReadonlyArray<AnyExecutableHandler> {
    const arr = Object.values(this.handlers).filter(
      (h): h is AnyExecutableHandler => h !== undefined,
    );
    return arr;
  }

  /**
   * Register beforeExecute hook
   */
  onBeforeExecute(hook: BeforeExecuteHook): () => void {
    this.beforeHooks.push(hook);
    return () => {
      const idx = this.beforeHooks.indexOf(hook);
      if (idx >= 0) this.beforeHooks.splice(idx, 1);
    };
  }

  /**
   * Register afterExecute hook
   */
  onAfterExecute(hook: AfterExecuteHook): () => void {
    this.afterHooks.push(hook);
    return () => {
      const idx = this.afterHooks.indexOf(hook);
      if (idx >= 0) this.afterHooks.splice(idx, 1);
    };
  }

  /**
   * Batch registration hook
   */
  use(hooks: ActionRegistryHooks): () => void {
    const disposers: Array<() => void> = [];
    if (hooks.beforeExecute) disposers.push(this.onBeforeExecute(hooks.beforeExecute));
    if (hooks.afterExecute) disposers.push(this.onAfterExecute(hooks.afterExecute));
    return () => {
      for (const d of disposers) d();
    };
  }

  /**
   * Verify action configuration
   */
  validate<T extends ExecutableActionType>(action: ExecutableAction<T>): ValidationResult {
    const handler = this.get(action.type);
    if (!handler) return invalid(`Unsupported action type: ${String(action.type)}`);
    if (!handler.validate) return ok();
    return handler.validate(action);
  }

  /**
   * Execute action
   */
  async execute<T extends ExecutableActionType>(
    ctx: ActionExecutionContext,
    action: ExecutableAction<T>,
  ): Promise<ActionExecutionResult<T>> {
    const startedAt = Date.now();

    // Skip disabled actions
    if (action.disabled) {
      return { status: 'skipped', durationMs: Date.now() - startedAt };
    }

    // Get handler
    const handler = this.get(action.type);
    if (!handler) {
      return {
        status: 'failed',
        error: {
          code: 'VALIDATION_ERROR',
          message: `Unsupported action type: ${String(action.type)}`,
        },
        durationMs: Date.now() - startedAt,
      };
    }

    // Verify
    const v = this.validate(action);
    if (!v.ok) {
      let result: ActionExecutionResult<T> = {
        status: 'failed',
        error: { code: 'VALIDATION_ERROR', message: v.errors.join(', ') },
      };

      // Call the afterExecute hook
      for (const hook of this.afterHooks) {
        try {
          const maybe = await hook({ ctx, action, handler, result, attempt: 0 });
          if (maybe) result = maybe;
        } catch (e) {
          try {
            ctx.log(`afterExecute hook failed: ${toErrorMessage(e)}`, 'warn');
          } catch {
            // ignore
          }
        }
      }

      result.durationMs = Date.now() - startedAt;
      return result;
    }

    // Calculate retry and timeout parameters
    const requestedRetryPolicy = action.policy?.retry;
    const sideEffectProfile = normalizeWorkflowNodeSideEffectProfile(
      action.type,
      action.params,
      action.sideEffect,
    );
    const retryPolicy =
      requestedRetryPolicy && workflowSideEffectAllowsRetry(sideEffectProfile, 'node')
        ? requestedRetryPolicy
        : undefined;
    const requestedTimeoutPolicy = action.policy?.timeout;
    const timeoutPolicy = requestedTimeoutPolicy
      ? {
          ms: boundedActionTimeout(requestedTimeoutPolicy.ms),
          scope: requestedTimeoutPolicy.scope === 'action' ? ('action' as const) : ('attempt' as const),
        }
      : undefined;
    const maxAttempts = 1 + boundedRetryCount(retryPolicy?.retries);
    if (requestedRetryPolicy && !retryPolicy) {
      try {
        ctx.log(
          `Retry suppressed for action "${action.type}" because sideEffect.retry=${sideEffectProfile.retry}`,
          'warn',
        );
      } catch {
        // ignore
      }
    }

    const actionDeadline =
      timeoutPolicy && timeoutPolicy.ms > 0 && (timeoutPolicy.scope ?? 'attempt') === 'action'
        ? startedAt + timeoutPolicy.ms
        : undefined;

    const remainingActionMs = () =>
      actionDeadline === undefined ? undefined : Math.max(0, actionDeadline - Date.now());

    let last: ActionExecutionResult<T> | undefined;

    // Execution loop (supports retry)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptTimeoutMs: number | undefined = (() => {
        if (!timeoutPolicy || timeoutPolicy.ms <= 0) return undefined;
        const scope = timeoutPolicy.scope ?? 'attempt';
        if (scope === 'attempt') return timeoutPolicy.ms;
        return remainingActionMs();
      })();

      if (attemptTimeoutMs !== undefined && attemptTimeoutMs <= 0) {
        last = failed<T>('TIMEOUT', 'Timeout reached');
        break;
      }

      // beforeExecute Hook (can be short-circuited)
      let shortCircuited: ActionExecutionResult<T> | undefined;
      for (const hook of this.beforeHooks) {
        try {
          const maybe = await hook({ ctx, action, handler, attempt });
          if (maybe) {
            shortCircuited = maybe;
            break;
          }
        } catch (e) {
          try {
            ctx.log(`beforeExecute hook failed: ${toErrorMessage(e)}`, 'warn');
          } catch {
            // ignore
          }
        }
      }

      // Execute handler
      const runOutcome =
        shortCircuited ??
        (await (async () => {
          const out = await runWithTimeout(() => handler.run(ctx, action), attemptTimeoutMs);
          if (!out.ok) return failed<T>(out.error.code, out.error.message);

          const result = out.value ?? ({} as ActionExecutionResult<T>);
          if (result.status === 'failed' && !result.error) {
            return { ...result, error: { code: 'UNKNOWN' as const, message: 'Action failed' } };
          }
          return result;
        })());

      let result: ActionExecutionResult<T> = runOutcome;

      // afterExecute hook (result can be replaced)
      for (const hook of this.afterHooks) {
        try {
          const maybe = await hook({ ctx, action, handler, result, attempt });
          if (maybe) result = maybe;
        } catch (e) {
          try {
            ctx.log(`afterExecute hook failed: ${toErrorMessage(e)}`, 'warn');
          } catch {
            // ignore
          }
        }
      }

      last = result;

      // Exit on success
      if (result.status !== 'failed') break;

      // Determine whether to retry
      const canRetry = attempt < maxAttempts - 1 && shouldRetry(retryPolicy, result.error);
      if (!canRetry) break;

      const delay = computeRetryDelayMs(retryPolicy!, attempt);
      if (
        actionDeadline !== undefined &&
        remainingActionMs() !== undefined &&
        (remainingActionMs() as number) < delay
      ) {
        break;
      }

      try {
        ctx.log(`Retrying action "${action.type}" (attempt ${attempt + 1}/${maxAttempts})`, 'warn');
      } catch {
        // ignore
      }

      if (delay > 0) await sleep(delay);
    }

    const finalResult: ActionExecutionResult<T> =
      last ??
      ({
        status: 'failed',
        error: { code: 'UNKNOWN', message: 'Action execution produced no result' },
      } as ActionExecutionResult<T>);

    finalResult.durationMs = Date.now() - startedAt;
    return finalResult;
  }
}

// ================================
// Export factory function
// ================================

/**
 * Create a default ActionRegistry instance
 */
export function createActionRegistry(): ActionRegistry {
  return new ActionRegistry();
}
