/**
 * @fileoverview FlowV3 persistence
 * @description Implement Flow’s CRUD operations
 */

import type { FlowId } from "../domain/ids";
import type { FlowV3 } from "../domain/flow";
import { FLOW_SCHEMA_VERSION } from "../domain/flow";
import {
  FLOW_RESOURCE_LIMITS,
  findFlowResourceLimitViolation,
  normalizeFlowListOptions,
  type FlowListOptions,
} from "../domain/flow-limits";
import { RR_ERROR_CODES, createRRError } from "../domain/errors";
import type { FlowsStore } from "../engine/storage/storage-port";
import { RR_V3_STORES, withTransaction } from "./db";

/**
 * Verify Flow structure
 */
export function validateFlow(flow: FlowV3): void {
  const resourceViolation = findFlowResourceLimitViolation(flow);
  if (resourceViolation) {
    throw createRRError(RR_ERROR_CODES.VALIDATION_ERROR, resourceViolation);
  }

  // Verify schema version
  if (flow.schemaVersion !== FLOW_SCHEMA_VERSION) {
    throw createRRError(
      RR_ERROR_CODES.VALIDATION_ERROR,
      `Invalid schema version: expected ${FLOW_SCHEMA_VERSION}, got ${flow.schemaVersion}`,
    );
  }

  // Validate required fields
  if (!flow.id) {
    throw createRRError(RR_ERROR_CODES.VALIDATION_ERROR, "Flow id is required");
  }
  if (!flow.name) {
    throw createRRError(
      RR_ERROR_CODES.VALIDATION_ERROR,
      "Flow name is required",
    );
  }
  if (!flow.entryNodeId) {
    throw createRRError(
      RR_ERROR_CODES.VALIDATION_ERROR,
      "Flow entryNodeId is required",
    );
  }

  const nodeIds = new Set<string>();
  for (const node of flow.nodes) {
    if (nodeIds.has(node.id)) {
      throw createRRError(
        RR_ERROR_CODES.VALIDATION_ERROR,
        `Duplicate node ID: "${node.id}"`,
      );
    }
    nodeIds.add(node.id);
  }

  // Verify entryNodeId exists
  if (!nodeIds.has(flow.entryNodeId)) {
    throw createRRError(
      RR_ERROR_CODES.VALIDATION_ERROR,
      `Entry node "${flow.entryNodeId}" does not exist in flow`,
    );
  }

  const edgeIds = new Set<string>();
  // Check edge references
  for (const edge of flow.edges) {
    if (edgeIds.has(edge.id)) {
      throw createRRError(
        RR_ERROR_CODES.VALIDATION_ERROR,
        `Duplicate edge ID: "${edge.id}"`,
      );
    }
    edgeIds.add(edge.id);

    if (!nodeIds.has(edge.from)) {
      throw createRRError(
        RR_ERROR_CODES.VALIDATION_ERROR,
        `Edge "${edge.id}" references non-existent source node "${edge.from}"`,
      );
    }
    if (!nodeIds.has(edge.to)) {
      throw createRRError(
        RR_ERROR_CODES.VALIDATION_ERROR,
        `Edge "${edge.id}" references non-existent target node "${edge.to}"`,
      );
    }
  }
}

/**
 * Create FlowsStore implementation
 */
export function createFlowsStore(): FlowsStore {
  return {
    async list(options?: FlowListOptions): Promise<FlowV3[]> {
      const { offset, limit } = normalizeFlowListOptions(options);
      return withTransaction(RR_V3_STORES.FLOWS, "readonly", async (stores) => {
        const store = stores[RR_V3_STORES.FLOWS];
        return new Promise<FlowV3[]>((resolve, reject) => {
          const results: FlowV3[] = [];
          let skipped = 0;
          const request = store.index("updatedAt").openCursor(null, "prev");
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || results.length >= limit) {
              resolve(results);
              return;
            }
            if (skipped < offset) {
              skipped += 1;
              cursor.continue();
              return;
            }
            results.push(cursor.value as FlowV3);
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
        });
      });
    },

    async get(id: FlowId): Promise<FlowV3 | null> {
      return withTransaction(RR_V3_STORES.FLOWS, "readonly", async (stores) => {
        const store = stores[RR_V3_STORES.FLOWS];
        return new Promise<FlowV3 | null>((resolve, reject) => {
          const request = store.get(id);
          request.onsuccess = () => resolve((request.result as FlowV3) ?? null);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async save(flow: FlowV3): Promise<void> {
      // Verification
      validateFlow(flow);

      return withTransaction(
        RR_V3_STORES.FLOWS,
        "readwrite",
        async (stores) => {
          const store = stores[RR_V3_STORES.FLOWS];
          const existing = await new Promise<FlowV3 | undefined>(
            (resolve, reject) => {
              const request = store.get(flow.id);
              request.onsuccess = () =>
                resolve(request.result as FlowV3 | undefined);
              request.onerror = () => reject(request.error);
            },
          );
          if (!existing) {
            const count = await new Promise<number>((resolve, reject) => {
              const request = store.count();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            if (count >= FLOW_RESOURCE_LIMITS.maxStoredFlows) {
              throw createRRError(
                RR_ERROR_CODES.VALIDATION_ERROR,
                `Cannot store more than ${FLOW_RESOURCE_LIMITS.maxStoredFlows} flows`,
              );
            }
          }
          return new Promise<void>((resolve, reject) => {
            const request = store.put(flow);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
        },
      );
    },

    async delete(id: FlowId): Promise<void> {
      return withTransaction(
        RR_V3_STORES.FLOWS,
        "readwrite",
        async (stores) => {
          const store = stores[RR_V3_STORES.FLOWS];
          return new Promise<void>((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
        },
      );
    },
  };
}
