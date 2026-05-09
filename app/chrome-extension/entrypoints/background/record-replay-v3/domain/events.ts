/**
 * @fileoverview Event type definition
 * @description Define run events and states in Record-Replay V3
 */

import type { JsonObject, JsonValue, UnixMillis } from './json';
import type { EdgeLabel, FlowId, NodeId, RunId } from './ids';
import type { RRError } from './errors';
import type { TriggerFireContext } from './triggers';
import type { ExecutionFlags } from '@/entrypoints/background/replay-actions';

/** Unsubscribe function type */
export type Unsubscribe = () => void;

/** Run Status */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'stopped_at_boundary';

/**
 * Event basic interface
 * @description Common fields for all events
 */
export interface EventBase {
  /** Owned Run ID */
  runId: RunId;
  /** event timestamp */
  ts: UnixMillis;
  /** monotonically increasing sequence number */
  seq: number;
}

/**
 * Reason for suspension
 * @description Describe the reason why Run paused
 */
export type PauseReason =
  | { kind: 'breakpoint'; nodeId: NodeId }
  | { kind: 'step'; nodeId: NodeId }
  | { kind: 'command' }
  | { kind: 'policy'; nodeId: NodeId; reason: string };

/** Reason for recovery */
export type RecoveryReason = 'sw_restart' | 'lease_expired';

export type NavigationObservationStatus = 'started' | 'completed' | 'failed' | 'unknown';
export type NetworkResourceType =
  | 'document'
  | 'stylesheet'
  | 'image'
  | 'media'
  | 'font'
  | 'script'
  | 'xhr'
  | 'fetch'
  | 'websocket'
  | 'eventsource'
  | 'other'
  | 'unknown';
export type VisibilityObservationStatus =
  | 'appeared'
  | 'disappeared'
  | 'stable'
  | 'changed'
  | 'timeout'
  | 'unknown';
export type SelectorResolvedBy =
  | 'primary'
  | 'candidate'
  | 'fingerprint'
  | 'domPath'
  | 'text'
  | 'role'
  | 'none'
  | 'unknown';
export type SelectorFingerprintStatus = 'matched' | 'mismatch' | 'missing' | 'unknown';

/**
 * Run event union type
 * @description All possible runtime events
 */
export type RunEvent =
  // ===== Run Life cycle events =====
  | (EventBase & { type: 'run.queued'; flowId: FlowId })
  | (EventBase & { type: 'run.started'; flowId: FlowId; tabId: number })
  | (EventBase & { type: 'run.paused'; reason: PauseReason; nodeId?: NodeId })
  | (EventBase & { type: 'run.resumed' })
  | (EventBase & {
      type: 'run.recovered';
      /** Reason for recovery */
      reason: RecoveryReason;
      /** restore state */
      fromStatus: 'running' | 'paused';
      /** Post-recovery status */
      toStatus: 'queued';
      /** Original ownerId (used for auditing) */
      prevOwnerId?: string;
    })
  | (EventBase & { type: 'run.canceled'; reason?: string })
  | (EventBase & { type: 'run.succeeded'; tookMs: number; outputs?: JsonObject })
  | (EventBase & {
      type: 'run.stopped_at_boundary';
      tookMs: number;
      boundary:
        | { kind: 'stopBeforeNode'; nodeId: NodeId }
        | { kind: 'endNode'; nodeId: NodeId };
      outputs?: JsonObject;
    })
  | (EventBase & { type: 'run.failed'; error: RRError; nodeId?: NodeId })

  // ===== Node Execution event =====
  | (EventBase & { type: 'node.queued'; nodeId: NodeId })
  | (EventBase & { type: 'node.started'; nodeId: NodeId; attempt: number })
  | (EventBase & {
      type: 'node.succeeded';
      nodeId: NodeId;
      tookMs: number;
      next?: { kind: 'edgeLabel'; label: EdgeLabel } | { kind: 'end' };
    })
  | (EventBase & {
      type: 'node.failed';
      nodeId: NodeId;
      attempt: number;
      error: RRError;
      decision: 'retry' | 'continue' | 'stop' | 'goto';
    })
  | (EventBase & { type: 'node.skipped'; nodeId: NodeId; reason: 'disabled' | 'unreachable' })

  // ===== Browser / DOM observation events =====
  | (EventBase & {
      type: 'navigation.observed';
      nodeId?: NodeId;
      beforeUrl?: string;
      afterUrl?: string;
      frameId?: number | string;
      sameDocument?: boolean;
      status: NavigationObservationStatus;
    })
  | (EventBase & {
      type: 'network.observed';
      nodeId?: NodeId;
      requestId: string;
      url: string;
      resourceType: NetworkResourceType;
      currentFrame: boolean;
      startedAt: UnixMillis;
      endedAt?: UnixMillis;
      status?: number;
      frameId?: number | string;
      method?: string;
      fromCache?: boolean;
      requestGroup?: string;
      quietWindowMs?: number;
      longLived?: boolean;
    })
  | (EventBase & {
      type: 'dom.visibility';
      nodeId?: NodeId;
      selector: string;
      candidateIndex?: number;
      matchCount: number;
      appearedAt?: UnixMillis;
      disappearedAt?: UnixMillis;
      stableForMs?: number;
      status: VisibilityObservationStatus;
    })
  | (EventBase & {
      type: 'selector.resolution';
      nodeId: NodeId;
      primarySelector: string;
      resolvedBy: SelectorResolvedBy;
      candidateIndex?: number;
      matchCount: number;
      fingerprint?: {
        status: SelectorFingerprintStatus;
        score?: number;
      };
    })

  // ===== Variables and Log Events =====
  | (EventBase & {
      type: 'vars.patch';
      patch: Array<{ op: 'set' | 'delete'; name: string; value?: JsonValue }>;
    })
  | (EventBase & {
      type: 'artifact.screenshot';
      nodeId: NodeId;
      artifactId?: string;
      savedAs?: string;
      /**
       * Legacy inline screenshot payload. New events should reference persisted
       * artifacts instead of duplicating base64 into the run event stream.
       */
      data?: string;
    })
  | (EventBase & {
      type: 'log';
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      data?: JsonValue;
    });

/** Run event type (extracted from union type) */
export type RunEventType = RunEvent['type'];

/**
 * Distributed Omit (preserved union type)
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Run Event input type
 * @description seq Must be allocated atomically by the storage layer (via RunRecordV3.nextSeq)
 * ts Optional, defaults to Date.now()
 */
export type RunEventInput = DistributiveOmit<RunEvent, 'seq' | 'ts'> & {
  ts?: UnixMillis;
};

/** Run Schema version */
export const RUN_SCHEMA_VERSION = 3 as const;

/**
 * Run Record V3
 * @description Run summary records stored in IndexedDB
 */
export interface RunRecordV3 {
  /** Schema version */
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  /** Run unique identifier */
  id: RunId;
  /** Associated Flow ID */
  flowId: FlowId;
  /** Expected workflow descriptor revision, when the caller requires one */
  expectedRevision?: string;

  /** Current status */
  status: RunStatus;
  /** creation time */
  createdAt: UnixMillis;
  /** Last updated */
  updatedAt: UnixMillis;

  /** Start execution time */
  startedAt?: UnixMillis;
  /** end time */
  finishedAt?: UnixMillis;
  /** Total time spent (milliseconds) */
  tookMs?: number;

  /** Bind Tab ID (exclusive per Run) */
  tabId?: number;
  /** Starting node ID (if not the default entry) */
  startNodeId?: NodeId;
  /** Stop before this node is executed, used for segment validation. */
  stopBeforeNodeId?: NodeId;
  /** Stop after this node succeeds or is skipped, used for segment validation. */
  endNodeId?: NodeId;
  /** Current execution node ID */
  currentNodeId?: NodeId;

  /** Current attempts */
  attempt: number;
  /** Maximum number of attempts */
  maxAttempts: number;

  /** Operating parameters */
  args?: JsonObject;
  /** trigger context */
  trigger?: TriggerFireContext;
  /** Debug configuration */
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };
  /** Run-scoped execution restrictions forwarded to handlers */
  execution?: ExecutionFlags;

  /** Error message (if failure) */
  error?: RRError;
  /** Output results */
  outputs?: JsonObject;

  /** Next event sequence number (cache field) */
  nextSeq: number;
}

/**
 * Determine whether Run has terminated
 */
export function isTerminalStatus(status: RunStatus): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'stopped_at_boundary'
  );
}

/**
 * Determine whether Run is being executed
 */
export function isActiveStatus(status: RunStatus): boolean {
  return status === 'running' || status === 'paused';
}
