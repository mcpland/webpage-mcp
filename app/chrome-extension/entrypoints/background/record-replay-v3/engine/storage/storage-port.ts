/**
 * @fileoverview StoragePort Interface definition
 * @description Define the abstract interface of the Storage layer for dependency injection
 */

import type { FlowId, RunId, TriggerId } from "../../domain/ids";
import type { FlowV3 } from "../../domain/flow";
import type { FlowListOptions } from "../../domain/flow-limits";
import type { RunEvent, RunEventInput, RunRecordV3 } from "../../domain/events";
import type {
  PersistentVarRecord,
  PersistentVariableName,
} from "../../domain/variables";
import type { TriggerSpec } from "../../domain/triggers";
import type { RunQueue } from "../queue/queue";
import type { ArtifactStore } from "../../storage/artifacts";

/**
 * FlowsStore interface
 */
export interface FlowsStore {
  /** List flows within the persisted collection bound. */
  list(options?: FlowListOptions): Promise<FlowV3[]>;
  /** Get a single flow */
  get(id: FlowId): Promise<FlowV3 | null>;
  /** Save Flow */
  save(flow: FlowV3): Promise<void>;
  /** Delete Flow */
  delete(id: FlowId): Promise<void>;
}

/**
 * RunsStore interface
 */
export interface RunsStore {
  /** List all Run records */
  list(): Promise<RunRecordV3[]>;
  /** Get a single Run record */
  get(id: RunId): Promise<RunRecordV3 | null>;
  /** Save run record */
  save(record: RunRecordV3): Promise<void>;
  /** Partially updated Run record */
  patch(id: RunId, patch: Partial<RunRecordV3>): Promise<void>;
}

/**
 * EventsStore interface
 * @description seq Allocation must be done atomically inside append()
 */
export interface EventsStore {
  /**
   * Append events and atomically assign seq
   * @description In a single transaction: read RunRecordV3.nextSeq -> Write event -> increment nextSeq
   * @param event Event input (without seq)
   * @returns Complete event (with assigned seq and ts)
   */
  append(event: RunEventInput): Promise<RunEvent>;

  /**
   * list events
   * @param runId Run ID
   * @param opts Query options
   */
  list(
    runId: RunId,
    opts?: { fromSeq?: number; limit?: number },
  ): Promise<RunEvent[]>;
}

/**
 * PersistentVarsStore interface
 */
export interface PersistentVarsStore {
  /** Get persistent variables */
  get(key: PersistentVariableName): Promise<PersistentVarRecord | undefined>;
  /** Set persistent variables */
  set(
    key: PersistentVariableName,
    value: PersistentVarRecord["value"],
  ): Promise<PersistentVarRecord>;
  /** Delete persistent variables */
  delete(key: PersistentVariableName): Promise<void>;
  /** List persistent variables */
  list(prefix?: PersistentVariableName): Promise<PersistentVarRecord[]>;
}

/**
 * TriggersStore interface
 */
export interface TriggersStore {
  /** List all triggers */
  list(): Promise<TriggerSpec[]>;
  /** Get a single trigger */
  get(id: TriggerId): Promise<TriggerSpec | null>;
  /** save trigger */
  save(spec: TriggerSpec): Promise<void>;
  /** delete trigger */
  delete(id: TriggerId): Promise<void>;
}

/**
 * StoragePort interface
 * @description Aggregate all storage interfaces for dependency injection
 */
export interface StoragePort {
  /** Flows storage */
  flows: FlowsStore;
  /** Runs storage */
  runs: RunsStore;
  /** Events storage */
  events: EventsStore;
  /** Queue storage */
  queue: RunQueue;
  /** Persistent variable storage */
  persistentVars: PersistentVarsStore;
  /** trigger storage */
  triggers: TriggersStore;
  /** persisted debug artifacts */
  artifacts: ArtifactStore;
}

/**
 * Create NotImplemented Store
 * @description Avoid Proxy generating 'then' leading to thenable behavior
 */
function createNotImplementedStore<T extends object>(name: string): T {
  const target = {} as T;
  return new Proxy(target, {
    get(_, prop) {
      // Avoid thenable behavior by returning undefined for 'then'
      if (prop === "then") {
        return undefined;
      }
      return async () => {
        throw new Error(`${name}.${String(prop)} not implemented`);
      };
    },
  });
}

/**
 * Create NotImplemented StoragePort
 * @description Phase 0 Placeholder implementation
 */
export function createNotImplementedStoragePort(): StoragePort {
  return {
    flows: createNotImplementedStore<FlowsStore>("FlowsStore"),
    runs: createNotImplementedStore<RunsStore>("RunsStore"),
    events: createNotImplementedStore<EventsStore>("EventsStore"),
    queue: createNotImplementedStore<RunQueue>("RunQueue"),
    persistentVars: createNotImplementedStore<PersistentVarsStore>(
      "PersistentVarsStore",
    ),
    triggers: createNotImplementedStore<TriggersStore>("TriggersStore"),
    artifacts: createNotImplementedStore<ArtifactStore>("ArtifactStore"),
  };
}
