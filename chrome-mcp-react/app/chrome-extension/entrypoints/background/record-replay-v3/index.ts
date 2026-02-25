/**
 * @fileoverview Record-Replay V3 公共 API 入口
 * @description 导出所有公共类型和接口
 */

// ==================== Domain ====================
export * from './domain';

// ==================== Engine ====================
export * from './engine';

// ==================== Storage ====================
export * from './storage';

// ==================== Factory Functions ====================

import type { StoragePort } from './engine/storage/storage-port';
import { createFlowsStore } from './storage/flows';
import { createRunsStore } from './storage/runs';
import { createEventsStore } from './storage/events';
import { createQueueStore } from './storage/queue';
import { createPersistentVarsStore } from './storage/persistent-vars';
import { createTriggersStore } from './storage/triggers';

/**
 * 创建完整的 StoragePort 实现
 */
export function createStoragePort(): StoragePort {
  return {
    flows: createFlowsStore(),
    runs: createRunsStore(),
    events: createEventsStore(),
    queue: createQueueStore(),
    persistentVars: createPersistentVarsStore(),
    triggers: createTriggersStore(),
  };
}

// ==================== Version ====================

/** V3 API 版本 */
export const RR_V3_VERSION = '3.0.0' as const;

/** 是否为 V3 API */
export const IS_RR_V3 = true as const;
