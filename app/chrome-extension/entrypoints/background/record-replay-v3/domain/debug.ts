/**
 * @fileoverview Debugger type definition
 * @description Defining debugger states and protocols in Record-Replay V3
 */

import type { JsonValue } from './json';
import type { NodeId, RunId } from './ids';
import type { PauseReason } from './events';

/**
 * breakpoint definition
 */
export interface Breakpoint {
  /** The node ID where the breakpoint is located */
  nodeId: NodeId;
  /** Whether to enable */
  enabled: boolean;
}

/**
 * Debugger status
 * @description Describes the current connection and execution status of the debugger
 */
export interface DebuggerState {
  /** Associated Run ID */
  runId: RunId;
  /** Debugger connection status */
  status: 'attached' | 'detached';
  /** Execution status */
  execution: 'running' | 'paused';
  /** Pause reason (only valid when execution='paused') */
  pauseReason?: PauseReason;
  /** Current node ID */
  currentNodeId?: NodeId;
  /** breakpoint list */
  breakpoints: Breakpoint[];
  /** single step mode */
  stepMode?: 'none' | 'stepOver';
}

/**
 * Debugger commands
 * @description Commands sent by the client to the debugger
 */
export type DebuggerCommand =
  // ===== Connection Control =====
  | { type: 'debug.attach'; runId: RunId }
  | { type: 'debug.detach'; runId: RunId }

  // ===== Execution Control =====
  | { type: 'debug.pause'; runId: RunId }
  | { type: 'debug.resume'; runId: RunId }
  | { type: 'debug.stepOver'; runId: RunId }

  // ===== Breakpoint management =====
  | { type: 'debug.setBreakpoints'; runId: RunId; nodeIds: NodeId[] }
  | { type: 'debug.addBreakpoint'; runId: RunId; nodeId: NodeId }
  | { type: 'debug.removeBreakpoint'; runId: RunId; nodeId: NodeId }

  // ===== Status query =====
  | { type: 'debug.getState'; runId: RunId }

  // ===== Variable operations =====
  | { type: 'debug.getVar'; runId: RunId; name: string }
  | { type: 'debug.setVar'; runId: RunId; name: string; value: JsonValue };

/** Debugger command type (extracted from union type) */
export type DebuggerCommandType = DebuggerCommand['type'];

/**
 * Debugger command response
 */
export type DebuggerResponse =
  | { ok: true; state?: DebuggerState; value?: JsonValue }
  | { ok: false; error: string };

/**
 * Create initial debugger state
 */
export function createInitialDebuggerState(runId: RunId): DebuggerState {
  return {
    runId,
    status: 'detached',
    execution: 'running',
    breakpoints: [],
    stepMode: 'none',
  };
}
