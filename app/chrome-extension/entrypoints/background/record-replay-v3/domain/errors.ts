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
