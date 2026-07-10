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
import {
  TRIGGER_RESOURCE_LIMITS,
  findTriggerIdentifierViolation,
  findTriggerResourceLimitViolation,
} from '../domain/trigger-limits';
import { jsonUtf8ByteLength } from '../domain/json-limits';
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

function validateTriggerForStorage(spec: TriggerSpec): void {
  const idViolation = findTriggerIdentifierViolation(spec.id, 'trigger.id');
  if (idViolation) throw new Error(idViolation);
  const flowIdViolation = findTriggerIdentifierViolation(
    spec.flowId,
    'trigger.flowId',
  );
  if (flowIdViolation) throw new Error(flowIdViolation);

  if (
    spec.kind === 'url' &&
    (!Array.isArray(spec.match) ||
      spec.match.length > TRIGGER_RESOURCE_LIMITS.maxUrlMatchRules)
  ) {
    throw new Error(
      `trigger.match must contain at most ${TRIGGER_RESOURCE_LIMITS.maxUrlMatchRules} rules`,
    );
  }
  if (
    spec.kind === 'contextMenu' &&
    spec.contexts !== undefined &&
    (!Array.isArray(spec.contexts) ||
      spec.contexts.length > TRIGGER_RESOURCE_LIMITS.maxContextMenuContexts)
  ) {
    throw new Error(
      `trigger.contexts must contain at most ${TRIGGER_RESOURCE_LIMITS.maxContextMenuContexts} entries`,
    );
  }

  const resourceViolation = findTriggerResourceLimitViolation(spec);
  if (resourceViolation) throw new Error(resourceViolation);
}

function validateTriggerId(id: TriggerId): void {
  const violation = findTriggerIdentifierViolation(id, 'trigger.id');
  if (violation) throw new Error(violation);
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
          const results: TriggerSpec[] = [];
          let aggregateBytes = 2;
          const request = store.openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (
              !cursor ||
              results.length >= TRIGGER_RESOURCE_LIMITS.maxStoredTriggers
            ) {
              resolve(results);
              return;
            }
            const trigger = cursor.value as TriggerSpec;
            const triggerBytes = jsonUtf8ByteLength(
              trigger,
              TRIGGER_RESOURCE_LIMITS.maxListUtf8Bytes,
            );
            const addedBytes = triggerBytes + (results.length > 0 ? 1 : 0);
            if (
              addedBytes >
              TRIGGER_RESOURCE_LIMITS.maxListUtf8Bytes - aggregateBytes
            ) {
              resolve(results);
              return;
            }
            aggregateBytes += addedBytes;
            results.push(trigger);
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
        });
      });
    },

    async get(id: TriggerId): Promise<TriggerSpec | null> {
      validateTriggerId(id);
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
      validateTriggerForStorage(normalizedSpec);
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
          if (count >= TRIGGER_RESOURCE_LIMITS.maxStoredTriggers) {
            throw new Error(
              `Trigger limit exceeded (maximum ${TRIGGER_RESOURCE_LIMITS.maxStoredTriggers})`,
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
      validateTriggerId(id);
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
