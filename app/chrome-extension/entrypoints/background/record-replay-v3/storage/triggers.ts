/**
 * @fileoverview trigger storage
 * @description Implement CRUD operations of triggers (Complete implementation in Phase 4)
 */

import type { TriggerId } from '../domain/ids';
import type { TriggerSpec } from '../domain/triggers';
import {
  DOM_TRIGGER_LIMITS,
  normalizeDomTriggerDebounceMs,
  normalizeDomTriggerSelector,
  normalizeDomTriggerTabId,
} from '../domain/dom-trigger-policy';
import type { TriggersStore } from '../engine/storage/storage-port';
import { RR_V3_STORES, withTransaction } from './db';

function normalizeTriggerForStorage(spec: TriggerSpec): TriggerSpec {
  if (spec.kind !== 'dom') return spec;

  const selector = normalizeDomTriggerSelector(spec.selector);
  const debounceMs = normalizeDomTriggerDebounceMs(spec.debounceMs);
  if (spec.tabId === undefined) {
    if (spec.enabled) {
      throw new Error('Enabled DOM triggers require an explicit trigger.tabId scope');
    }
    return { ...spec, selector, debounceMs };
  }

  return {
    ...spec,
    selector,
    tabId: normalizeDomTriggerTabId(spec.tabId),
    debounceMs,
  };
}

/**
 * Create a TriggersStore implementation
 */
export function createTriggersStore(): TriggersStore {
  return {
    async list(): Promise<TriggerSpec[]> {
      return withTransaction(RR_V3_STORES.TRIGGERS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.TRIGGERS];
        return new Promise<TriggerSpec[]>((resolve, reject) => {
          const request = store.getAll(undefined, DOM_TRIGGER_LIMITS.maxStoredTriggers);
          request.onsuccess = () => resolve(request.result as TriggerSpec[]);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async get(id: TriggerId): Promise<TriggerSpec | null> {
      return withTransaction(RR_V3_STORES.TRIGGERS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.TRIGGERS];
        return new Promise<TriggerSpec | null>((resolve, reject) => {
          const request = store.get(id);
          request.onsuccess = () => resolve((request.result as TriggerSpec) ?? null);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async save(spec: TriggerSpec): Promise<void> {
      const normalizedSpec = normalizeTriggerForStorage(spec);
      return withTransaction(RR_V3_STORES.TRIGGERS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.TRIGGERS];
        const existing = await new Promise<TriggerSpec | undefined>((resolve, reject) => {
          const request = store.get(normalizedSpec.id);
          request.onsuccess = () => resolve(request.result as TriggerSpec | undefined);
          request.onerror = () => reject(request.error);
        });

        if (!existing) {
          const count = await new Promise<number>((resolve, reject) => {
            const request = store.count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          if (count >= DOM_TRIGGER_LIMITS.maxStoredTriggers) {
            throw new Error(
              `Trigger limit exceeded (maximum ${DOM_TRIGGER_LIMITS.maxStoredTriggers})`,
            );
          }
        }

        return new Promise<void>((resolve, reject) => {
          const request = store.put(normalizedSpec);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    async delete(id: TriggerId): Promise<void> {
      return withTransaction(RR_V3_STORES.TRIGGERS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.TRIGGERS];
        return new Promise<void>((resolve, reject) => {
          const request = store.delete(id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },
  };
}
