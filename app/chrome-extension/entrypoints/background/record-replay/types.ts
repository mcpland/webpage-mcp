/**
 * Record & Replay Core Types
 *
 * This file contains the core type definitions for the record-replay system.
 * Legacy Step types have been moved to ./legacy-types.ts and are re-exported
 * here for backward compatibility.
 *
 * Type system architecture:
 * - Legacy types (./legacy-types.ts): Step-based execution model (being phased out)
 * - Action types (./actions/types.ts): DAG-based execution model (new standard)
 * - Core types (this file): Flow, Node, Edge, Run records (shared by both)
 */

import { NODE_TYPES } from '@/common/node-types';

// =============================================================================
// Re-export Legacy Types for Backward Compatibility
// =============================================================================

export type {
  // Selector types
  SelectorType,
  SelectorCandidate,
  TargetLocator,
  // Step types
  StepType,
  StepBase,
  StepClick,
  StepFill,
  StepTriggerEvent,
  StepSetAttribute,
  StepScreenshot,
  StepSwitchFrame,
  StepLoopElements,
  StepKey,
  StepScroll,
  StepDrag,
  StepWait,
  StepAssert,
  StepScript,
  StepIf,
  StepForeach,
  StepWhile,
  StepHttp,
  StepExtract,
  StepOpenTab,
  StepSwitchTab,
  StepCloseTab,
  StepNavigate,
  StepHandleDownload,
  StepExecuteFlow,
  Step,
} from './legacy-types';

// Import Step type for use in Flow interface
import type { Step } from './legacy-types';

// =============================================================================
// Variable Definitions
// =============================================================================

export type VariableType = 'string' | 'number' | 'boolean' | 'enum' | 'array';

export interface VariableDef {
  key: string;
  label?: string;
  sensitive?: boolean;
  // default value can be string/number/boolean/array depending on type
  default?: any; // keep broad for backward compatibility
  type?: VariableType; // default to 'string' when omitted
  rules?: { required?: boolean; pattern?: string; enum?: string[] };
}

// =============================================================================
// DAG Node and Edge Types (Flow V2)
// =============================================================================

export type NodeType = (typeof NODE_TYPES)[keyof typeof NODE_TYPES];

export interface NodeBase {
  id: string;
  type: NodeType;
  name?: string;
  disabled?: boolean;
  config?: any;
  ui?: { x: number; y: number };
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  // label identifies the logical branch. Keep 'default' for linear/main path.
  // For conditionals, use arbitrary strings like 'case:<id>' or 'else'.
  label?: string;
}

// =============================================================================
// Flow Definition
// =============================================================================

export interface Flow {
  id: string;
  name: string;
  description?: string;
  version: number;
  meta?: {
    createdAt: string;
    updatedAt: string;
    domain?: string;
    tags?: string[];
    bindings?: Array<{ type: 'domain' | 'path' | 'url'; value: string }>;
    tool?: { category?: string; description?: string };
    exposedOutputs?: Array<{ nodeId: string; as: string }>;
    /** Recording stop barrier status (used during recording stop) */
    stopBarrier?: {
      ok: boolean;
      sessionId?: string;
      stoppedAt?: string;
      failed?: Array<{
        tabId: number;
        skipped?: boolean;
        reason?: string;
        topTimedOut?: boolean;
        topError?: string;
        subframesFailed?: number;
      }>;
    };
  };
  variables?: VariableDef[];
  /**
   * @deprecated Use nodes/edges instead. This field is no longer written to storage.
   * Kept as optional for backward compatibility with existing flows and imports.
   */
  steps?: Step[];
  // Flow V2: DAG-based execution model
  nodes?: NodeBase[];
  edges?: Edge[];
  subflows?: Record<string, { nodes: NodeBase[]; edges: Edge[] }>;
}

// =============================================================================
// Run Records and Results
// =============================================================================

export interface RunLogEntry {
  stepId: string;
  status: 'success' | 'failed' | 'retrying' | 'warning';
  message?: string;
  tookMs?: number;
  screenshotBase64?: string; // small thumbnail (optional)
  consoleSnippets?: string[]; // critical lines
  networkSnippets?: Array<{ method: string; url: string; status?: number; ms?: number }>;
  // selector fallback info
  fallbackUsed?: boolean;
  fallbackFrom?: string;
  fallbackTo?: string;
}

export interface RunRecord {
  id: string;
  flowId: string;
  startedAt: string;
  finishedAt?: string;
  success?: boolean;
  entries: RunLogEntry[];
}

export interface RunResult {
  runId: string;
  success: boolean;
  summary: { total: number; success: number; failed: number; tookMs: number };
  url?: string | null;
  outputs?: Record<string, any> | null;
  logs?: RunLogEntry[];
  screenshots?: { onFailure?: string | null };
  paused?: boolean; // when true, the run was intentionally paused (e.g., breakpoint)
}
