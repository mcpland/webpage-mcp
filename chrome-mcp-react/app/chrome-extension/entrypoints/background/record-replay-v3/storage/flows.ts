/**
 * @fileoverview FlowV3 持久化
 * @description 实现 Flow 的 CRUD 操作
 */

import type { FlowId } from '../domain/ids';
import type { FlowV3 } from '../domain/flow';
import { FLOW_SCHEMA_VERSION } from '../domain/flow';
import { RR_ERROR_CODES, createRRError } from '../domain/errors';
import type { FlowsStore } from '../engine/storage/storage-port';
import { RR_V3_STORES, withTransaction } from './db';

/**
 * 校验 Flow 结构
 */
function validateFlow(flow: FlowV3): void {
  // 校验 schema 版本
  if (flow.schemaVersion !== FLOW_SCHEMA_VERSION) {
    throw createRRError(
      RR_ERROR_CODES.VALIDATION_ERROR,
      `Invalid schema version: expected ${FLOW_SCHEMA_VERSION}, got ${flow.schemaVersion}`,
    );
  }

  // 校验必填字段
  if (!flow.id) {
    throw createRRError(RR_ERROR_CODES.VALIDATION_ERROR, 'Flow id is required');
  }
  if (!flow.name) {
    throw createRRError(RR_ERROR_CODES.VALIDATION_ERROR, 'Flow name is required');
  }
  if (!flow.entryNodeId) {
    throw createRRError(RR_ERROR_CODES.VALIDATION_ERROR, 'Flow entryNodeId is required');
  }

  // 校验 entryNodeId 存在
  const nodeIds = new Set(flow.nodes.map((n) => n.id));
  if (!nodeIds.has(flow.entryNodeId)) {
    throw createRRError(
      RR_ERROR_CODES.VALIDATION_ERROR,
      `Entry node "${flow.entryNodeId}" does not exist in flow`,
    );
  }

  // 校验边引用
  for (const edge of flow.edges) {
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
 * 创建 FlowsStore 实现
 */
export function createFlowsStore(): FlowsStore {
  return {
    async list(): Promise<FlowV3[]> {
      return withTransaction(RR_V3_STORES.FLOWS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.FLOWS];
        return new Promise<FlowV3[]>((resolve, reject) => {
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result as FlowV3[]);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async get(id: FlowId): Promise<FlowV3 | null> {
      return withTransaction(RR_V3_STORES.FLOWS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.FLOWS];
        return new Promise<FlowV3 | null>((resolve, reject) => {
          const request = store.get(id);
          request.onsuccess = () => resolve((request.result as FlowV3) ?? null);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async save(flow: FlowV3): Promise<void> {
      // 校验
      validateFlow(flow);

      return withTransaction(RR_V3_STORES.FLOWS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.FLOWS];
        return new Promise<void>((resolve, reject) => {
          const request = store.put(flow);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    async delete(id: FlowId): Promise<void> {
      return withTransaction(RR_V3_STORES.FLOWS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.FLOWS];
        return new Promise<void>((resolve, reject) => {
          const request = store.delete(id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },
  };
}
