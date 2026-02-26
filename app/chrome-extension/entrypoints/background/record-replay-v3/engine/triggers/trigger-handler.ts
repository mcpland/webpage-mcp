/**
 * @fileoverview Trigger handler interface definition
 * @description Define a unified interface for various types of triggers
 */

import type { TriggerSpec, TriggerKind } from '../../domain/triggers';

/**
 * Trigger handler interface
 * @description Each trigger type needs to implement this interface
 */
export interface TriggerHandler<K extends TriggerKind = TriggerKind> {
  /** Trigger type */
  readonly kind: K;

  /**
   * Install trigger
   * @description Register chrome API listeners, etc.
   * @param trigger Trigger specification
   */
  install(trigger: Extract<TriggerSpec, { kind: K }>): Promise<void>;

  /**
   * uninstall trigger
   * @description Remove chrome API listeners, etc.
   * @param triggerId Trigger ID
   */
  uninstall(triggerId: string): Promise<void>;

  /**
   * Uninstall all triggers
   * @description Clean all triggers of this type
   */
  uninstallAll(): Promise<void>;

  /**
   * Get a list of installed trigger IDs
   */
  getInstalledIds(): string[];
}

/**
 * Trigger fires callback
 * @description TriggerManager Callbacks injected into each Handler
 */
export interface TriggerFireCallback {
  /**
   * Called when the trigger is fired
   * @param triggerId Trigger ID
   * @param context trigger context
   */
  onFire(
    triggerId: string,
    context: {
      sourceTabId?: number;
      sourceUrl?: string;
    },
  ): Promise<void>;
}

/**
 * trigger handler factory
 */
export type TriggerHandlerFactory<K extends TriggerKind> = (
  fireCallback: TriggerFireCallback,
) => TriggerHandler<K>;
