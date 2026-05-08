/**
 * @fileoverview Error type definition
 * @description Define error codes and error types used in Record-Replay V3
 */

import type { JsonValue } from './json';

/** Error code constant */
export const RR_ERROR_CODES = {
  // ===== Validation error =====
  /** Generic validation error */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Workflow secret reference is missing */
  SECRET_REF_NOT_FOUND: 'SECRET_REF_NOT_FOUND',
  /** Workflow secret reference is expired */
  SECRET_REF_EXPIRED: 'SECRET_REF_EXPIRED',
  /** Workflow secret reference is revoked */
  SECRET_REF_REVOKED: 'SECRET_REF_REVOKED',
  /** Workflow secret reference is invalid */
  SECRET_REF_INVALID: 'SECRET_REF_INVALID',
  /** Workflow output contract validation failed */
  OUTPUT_VALIDATION_FAILED: 'OUTPUT_VALIDATION_FAILED',
  /** Workflow descriptor revision is stale */
  STALE_WORKFLOW_DESCRIPTOR: 'STALE_WORKFLOW_DESCRIPTOR',
  /** Unsupported node type */
  UNSUPPORTED_NODE: 'UNSUPPORTED_NODE',
  /** DAG Invalid structure */
  DAG_INVALID: 'DAG_INVALID',
  /** DAG There is a cycle */
  DAG_CYCLE: 'DAG_CYCLE',

  // ===== Runtime error =====
  /** Operation timeout */
  TIMEOUT: 'TIMEOUT',
  /** Tab not found */
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  /** Frame not found */
  FRAME_NOT_FOUND: 'FRAME_NOT_FOUND',
  /** Target element not found */
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  /** Element is not visible */
  ELEMENT_NOT_VISIBLE: 'ELEMENT_NOT_VISIBLE',
  /** Navigation failed */
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  /** Network request failed */
  NETWORK_REQUEST_FAILED: 'NETWORK_REQUEST_FAILED',
  /** Runtime storage or artifact quota was exceeded */
  RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED',

  // ===== Script/Tool Error =====
  /** Script execution failed */
  SCRIPT_FAILED: 'SCRIPT_FAILED',
  /** Permission denied */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** Tool execution error */
  TOOL_ERROR: 'TOOL_ERROR',

  // ===== Control Error =====
  /** Run canceled */
  RUN_CANCELED: 'RUN_CANCELED',
  /** Run suspended */
  RUN_PAUSED: 'RUN_PAUSED',
  /** Run could not be safely recovered after a service worker restart */
  ABORTED_BY_RESTART: 'ABORTED_BY_RESTART',

  // ===== Internal error =====
  /** Internal error */
  INTERNAL: 'INTERNAL',
  /** Invariant violation */
  INVARIANT_VIOLATION: 'INVARIANT_VIOLATION',
} as const;

/** Error code type */
export type RRErrorCode = (typeof RR_ERROR_CODES)[keyof typeof RR_ERROR_CODES];

/**
 * Record-Replay Error interface
 * @description Unified error representation, supporting error chaining and retryable marking
 */
export interface RRError {
  /** error code */
  code: RRErrorCode;
  /** error message */
  message: string;
  /** Additional data */
  data?: JsonValue;
  /** Is it possible to retry */
  retryable?: boolean;
  /** Reason error (error chain) */
  cause?: RRError;
}

/**
 * Factory function to create RRError
 */
export function createRRError(
  code: RRErrorCode,
  message: string,
  options?: { data?: JsonValue; retryable?: boolean; cause?: RRError },
): RRError {
  return {
    code,
    message,
    ...(options?.data !== undefined && { data: options.data }),
    ...(options?.retryable !== undefined && { retryable: options.retryable }),
    ...(options?.cause !== undefined && { cause: options.cause }),
  };
}

function readErrorString(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== 'object' || !(key in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readErrorBoolean(error: unknown, key: 'retryable'): boolean | undefined {
  if (!error || typeof error !== 'object' || !(key in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readErrorNumber(error: unknown, key: string): number | undefined {
  if (!error || typeof error !== 'object' || !(key in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function getErrorCode(error: unknown): string | undefined {
  return readErrorString(error, 'code') ?? readErrorString(error, 'name');
}

export function getErrorMessage(error: unknown): string {
  return readErrorString(error, 'message') ?? String(error);
}

export function getErrorRetryable(error: unknown): boolean | undefined {
  return readErrorBoolean(error, 'retryable');
}

export function isResourceLimitError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (
    code === RR_ERROR_CODES.RESOURCE_LIMIT_EXCEEDED ||
    code === 'RUN_QUEUE_BACKPRESSURE' ||
    code === 'QuotaExceededError' ||
    code === 'NS_ERROR_DOM_QUOTA_REACHED'
  ) {
    return true;
  }

  const message = getErrorMessage(error);
  return /\b(backpressure|quota|rate.?limit|resource.?exhausted|storage.?limit|limit.?exceeded)\b/i.test(
    message,
  );
}

export function createResourceLimitExceededError(
  action: string,
  error: unknown,
  options: {
    retryable?: boolean;
    source?: string;
    data?: Record<string, JsonValue>;
  } = {},
): RRError {
  const originalCode = getErrorCode(error);
  const originalName = readErrorString(error, 'name');
  const originalErrorCode = readErrorString(error, 'code');
  const originalMessage = readErrorString(error, 'message');
  const scope = readErrorString(error, 'scope');
  const flowId = readErrorString(error, 'flowId');
  const limit = readErrorNumber(error, 'limit');
  const queuedCount = readErrorNumber(error, 'queuedCount');
  const retryable = options.retryable ?? getErrorRetryable(error) ?? false;
  const data: Record<string, JsonValue> = {
    ...(options.source ? { source: options.source } : {}),
    ...(originalCode ? { originalCode } : {}),
    ...(originalName ? { originalName } : {}),
    ...(originalErrorCode ? { originalErrorCode } : {}),
    ...(originalMessage ? { originalMessage } : {}),
    ...(scope ? { scope } : {}),
    ...(flowId ? { flowId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(queuedCount !== undefined ? { queuedCount } : {}),
    ...(options.data ?? {}),
  };

  return createRRError(
    RR_ERROR_CODES.RESOURCE_LIMIT_EXCEEDED,
    `${action}: ${getErrorMessage(error)}`,
    {
      retryable,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    },
  );
}
