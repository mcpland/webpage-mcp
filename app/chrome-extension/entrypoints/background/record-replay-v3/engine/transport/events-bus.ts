/**
 * @fileoverview EventsBus Interface and Implementation
 * @description Event subscription, publishing, and persistence
 */

import type { RunId } from '../../domain/ids';
import type { RunEvent, RunEventInput, Unsubscribe } from '../../domain/events';
import type { EventsStore } from '../storage/storage-port';

/**
 * Event query parameters
 */
export interface EventsQuery {
  /** Run ID */
  runId: RunId;
  /** Starting sequence number (inclusive) */
  fromSeq?: number;
  /** Maximum number of results */
  limit?: number;
}

/**
 * Subscription filter
 */
export interface EventsFilter {
  /** Only receive events for this Run */
  runId?: RunId;
}

/**
 * EventsBus Interface
 * @description Responsible for event subscription, publishing, and persistence
 */
export interface EventsBus {
  /**
   * Subscribe to events
   * @param listener Event listener
   * @param filter Optional filter
   * @returns Unsubscribe function
   */
  subscribe(listener: (event: RunEvent) => void, filter?: EventsFilter): Unsubscribe;

  /**
   * Append event
   * @description Delegates to EventsStore for atomic seq allocation, then broadcasts
   * @param event Event input (without seq)
   * @returns Complete event (with seq and ts)
   */
  append(event: RunEventInput): Promise<RunEvent>;

  /**
   * Query historical events
   * @param query Query parameters
   * @returns Events sorted by seq ascending
   */
  list(query: EventsQuery): Promise<RunEvent[]>;
}

/**
 * Create NotImplemented EventsBus
 * @description Phase 0 placeholder
 */
export function createNotImplementedEventsBus(): EventsBus {
  const notImplemented = () => {
    throw new Error('EventsBus not implemented');
  };

  return {
    subscribe: () => {
      notImplemented();
      return () => {};
    },
    append: async () => notImplemented(),
    list: async () => notImplemented(),
  };
}

/**
 * Listener entry for subscription management
 */
interface ListenerEntry {
  listener: (event: RunEvent) => void;
  filter?: EventsFilter;
}

/**
 * Storage-backed EventsBus Implementation
 * @description
 * - seq allocation is done by EventsStore.append() (atomic with RunRecordV3.nextSeq)
 * - broadcast happens only after append resolves (i.e. after commit)
 */
export class StorageBackedEventsBus implements EventsBus {
  private listeners = new Set<ListenerEntry>();

  constructor(private readonly store: EventsStore) {}

  subscribe(listener: (event: RunEvent) => void, filter?: EventsFilter): Unsubscribe {
    const entry: ListenerEntry = { listener, filter };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  async append(input: RunEventInput): Promise<RunEvent> {
    // Delegate to storage for atomic seq allocation
    const event = await this.store.append(input);

    // Broadcast after successful commit
    this.broadcast(event);

    return event;
  }

  async list(query: EventsQuery): Promise<RunEvent[]> {
    return this.store.list(query.runId, {
      fromSeq: query.fromSeq,
      limit: query.limit,
    });
  }

  /**
   * Broadcast event to all matching listeners
   */
  private broadcast(event: RunEvent): void {
    const { runId } = event;
    for (const { listener, filter } of this.listeners) {
      if (!filter || !filter.runId || filter.runId === runId) {
        try {
          listener(event);
        } catch (error) {
          console.error('[StorageBackedEventsBus] Listener error:', error);
        }
      }
    }
  }
}

/**
 * In-memory EventsBus for testing
 * @description Uses internal seq counter, NOT suitable for production
 * @deprecated Use StorageBackedEventsBus with mock EventsStore for testing
 */
export class InMemoryEventsBus implements EventsBus {
  private events = new Map<RunId, RunEvent[]>();
  private seqCounters = new Map<RunId, number>();
  private listeners = new Set<ListenerEntry>();

  subscribe(listener: (event: RunEvent) => void, filter?: EventsFilter): Unsubscribe {
    const entry: ListenerEntry = { listener, filter };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  async append(input: RunEventInput): Promise<RunEvent> {
    const { runId } = input;

    // Allocate seq (NOT atomic, for testing only)
    const currentSeq = this.seqCounters.get(runId) ?? 0;
    const seq = currentSeq + 1;
    this.seqCounters.set(runId, seq);

    // Create complete event
    const event: RunEvent = {
      ...input,
      seq,
      ts: input.ts ?? Date.now(),
    } as RunEvent;

    // Store
    const runEvents = this.events.get(runId) ?? [];
    runEvents.push(event);
    this.events.set(runId, runEvents);

    // Broadcast
    for (const { listener, filter } of this.listeners) {
      if (!filter || !filter.runId || filter.runId === runId) {
        try {
          listener(event);
        } catch (error) {
          console.error('[InMemoryEventsBus] Listener error:', error);
        }
      }
    }

    return event;
  }

  async list(query: EventsQuery): Promise<RunEvent[]> {
    const runEvents = this.events.get(query.runId) ?? [];

    let result = runEvents;

    if (query.fromSeq !== undefined) {
      result = result.filter((e) => e.seq >= query.fromSeq!);
    }

    if (query.limit !== undefined) {
      result = result.slice(0, query.limit);
    }

    return result;
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.events.clear();
    this.seqCounters.clear();
    this.listeners.clear();
  }

  /**
   * Get current seq for a run (for testing)
   */
  getSeq(runId: RunId): number {
    return this.seqCounters.get(runId) ?? 0;
  }
}
