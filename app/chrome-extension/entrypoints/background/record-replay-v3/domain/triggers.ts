/**
 * @fileoverview Trigger type definition
 * @description Defining trigger specifications in Record-Replay V3
 */

import type { JsonObject, UnixMillis } from './json';
import type { FlowId, TriggerId } from './ids';

/** Trigger type */
export type TriggerKind =
  | 'manual'
  | 'url'
  | 'cron'
  | 'interval'
  | 'once'
  | 'command'
  | 'contextMenu'
  | 'dom';

/**
 * Trigger basic interface
 */
export interface TriggerSpecBase {
  /** Trigger ID */
  id: TriggerId;
  /** Trigger type */
  kind: TriggerKind;
  /** Whether to enable */
  enabled: boolean;
  /** Associated Flow ID */
  flowId: FlowId;
  /** Parameters passed to Flow */
  args?: JsonObject;
}

/**
 * URL Matching rules
 */
export interface UrlMatchRule {
  kind: 'url' | 'domain' | 'path';
  value: string;
}

/**
 * trigger specification union type
 */
export type TriggerSpec =
  // manual trigger
  | (TriggerSpecBase & { kind: 'manual' })

  // URL trigger
  | (TriggerSpecBase & {
      kind: 'url';
      match: UrlMatchRule[];
    })

  // Cron Timing trigger
  | (TriggerSpecBase & {
      kind: 'cron';
      cron: string;
      timezone?: string;
    })

  // Interval Timed trigger (repeat at fixed intervals)
  | (TriggerSpecBase & {
      kind: 'interval';
      /** Interval in minutes, minimum 1 */
      periodMinutes: number;
    })

  // Once Scheduled trigger (automatically disabled after triggering once at a specified time)
  | (TriggerSpecBase & {
      kind: 'once';
      /** Trigger timestamp (Unix milliseconds) */
      whenMs: UnixMillis;
    })

  // Shortcut key trigger
  | (TriggerSpecBase & {
      kind: 'command';
      commandKey: string;
    })

  // Right-click menu trigger
  | (TriggerSpecBase & {
      kind: 'contextMenu';
      title: string;
      contexts?: ReadonlyArray<string>;
    })

  // DOM Triggered by element appearing
  | (TriggerSpecBase & {
      kind: 'dom';
      selector: string;
      appear?: boolean;
      once?: boolean;
      debounceMs?: UnixMillis;
    });

/**
 * trigger firing context
 * @description Describes the context information when the trigger is fired
 */
export interface TriggerFireContext {
  /** Trigger ID */
  triggerId: TriggerId;
  /** Trigger type */
  kind: TriggerKind;
  /** Trigger time */
  firedAt: UnixMillis;
  /** Source Tab ID */
  sourceTabId?: number;
  /** Source URL */
  sourceUrl?: string;
}

/**
 * Get a typed trigger specification based on the trigger type
 */
export type TriggerSpecByKind<K extends TriggerKind> = Extract<TriggerSpec, { kind: K }>;

/**
 * Determine whether the trigger is enabled
 */
export function isTriggerEnabled(trigger: TriggerSpec): boolean {
  return trigger.enabled;
}

/**
 * Create trigger firing context
 */
export function createTriggerFireContext(
  trigger: TriggerSpec,
  options?: { sourceTabId?: number; sourceUrl?: string },
): TriggerFireContext {
  return {
    triggerId: trigger.id,
    kind: trigger.kind,
    firedAt: Date.now(),
    sourceTabId: options?.sourceTabId,
    sourceUrl: options?.sourceUrl,
  };
}
