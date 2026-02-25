/**
 * @fileoverview StoragePort 接口定义
 * @description 定义 Storage 层的抽象接口，用于依赖注入
 */

import type { FlowId, RunId, TriggerId } from '../../domain/ids';
import type { FlowV3 } from '../../domain/flow';
import type { RunEvent, RunEventInput, RunRecordV3 } from '../../domain/events';
import type { PersistentVarRecord, PersistentVariableName } from '../../domain/variables';
import type { TriggerSpec } from '../../domain/triggers';
import type { RunQueue } from '../queue/queue';

/**
 * FlowsStore 接口
 */
export interface FlowsStore {
  /** 列出所有 Flow */
  list(): Promise<FlowV3[]>;
  /** 获取单个 Flow */
  get(id: FlowId): Promise<FlowV3 | null>;
  /** 保存 Flow */
  save(flow: FlowV3): Promise<void>;
  /** 删除 Flow */
  delete(id: FlowId): Promise<void>;
}

/**
 * RunsStore 接口
 */
export interface RunsStore {
  /** 列出所有 Run 记录 */
  list(): Promise<RunRecordV3[]>;
  /** 获取单个 Run 记录 */
  get(id: RunId): Promise<RunRecordV3 | null>;
  /** 保存 Run 记录 */
  save(record: RunRecordV3): Promise<void>;
  /** 部分更新 Run 记录 */
  patch(id: RunId, patch: Partial<RunRecordV3>): Promise<void>;
}

/**
 * EventsStore 接口
 * @description seq 分配必须由 append() 内部原子完成
 */
export interface EventsStore {
  /**
   * 追加事件并原子分配 seq
   * @description 在单个事务中：读取 RunRecordV3.nextSeq -> 写入事件 -> 递增 nextSeq
   * @param event 事件输入（不含 seq）
   * @returns 完整事件（含分配的 seq 和 ts）
   */
  append(event: RunEventInput): Promise<RunEvent>;

  /**
   * 列出事件
   * @param runId Run ID
   * @param opts 查询选项
   */
  list(runId: RunId, opts?: { fromSeq?: number; limit?: number }): Promise<RunEvent[]>;
}

/**
 * PersistentVarsStore 接口
 */
export interface PersistentVarsStore {
  /** 获取持久化变量 */
  get(key: PersistentVariableName): Promise<PersistentVarRecord | undefined>;
  /** 设置持久化变量 */
  set(
    key: PersistentVariableName,
    value: PersistentVarRecord['value'],
  ): Promise<PersistentVarRecord>;
  /** 删除持久化变量 */
  delete(key: PersistentVariableName): Promise<void>;
  /** 列出持久化变量 */
  list(prefix?: PersistentVariableName): Promise<PersistentVarRecord[]>;
}

/**
 * TriggersStore 接口
 */
export interface TriggersStore {
  /** 列出所有触发器 */
  list(): Promise<TriggerSpec[]>;
  /** 获取单个触发器 */
  get(id: TriggerId): Promise<TriggerSpec | null>;
  /** 保存触发器 */
  save(spec: TriggerSpec): Promise<void>;
  /** 删除触发器 */
  delete(id: TriggerId): Promise<void>;
}

/**
 * StoragePort 接口
 * @description 聚合所有存储接口，用于依赖注入
 */
export interface StoragePort {
  /** Flows 存储 */
  flows: FlowsStore;
  /** Runs 存储 */
  runs: RunsStore;
  /** Events 存储 */
  events: EventsStore;
  /** Queue 存储 */
  queue: RunQueue;
  /** 持久化变量存储 */
  persistentVars: PersistentVarsStore;
  /** 触发器存储 */
  triggers: TriggersStore;
}

/**
 * 创建 NotImplemented 的 Store
 * @description 避免 Proxy 生成 'then' 导致 thenable 行为
 */
function createNotImplementedStore<T extends object>(name: string): T {
  const target = {} as T;
  return new Proxy(target, {
    get(_, prop) {
      // Avoid thenable behavior by returning undefined for 'then'
      if (prop === 'then') {
        return undefined;
      }
      return async () => {
        throw new Error(`${name}.${String(prop)} not implemented`);
      };
    },
  });
}

/**
 * 创建 NotImplemented 的 StoragePort
 * @description Phase 0 占位实现
 */
export function createNotImplementedStoragePort(): StoragePort {
  return {
    flows: createNotImplementedStore<FlowsStore>('FlowsStore'),
    runs: createNotImplementedStore<RunsStore>('RunsStore'),
    events: createNotImplementedStore<EventsStore>('EventsStore'),
    queue: createNotImplementedStore<RunQueue>('RunQueue'),
    persistentVars: createNotImplementedStore<PersistentVarsStore>('PersistentVarsStore'),
    triggers: createNotImplementedStore<TriggersStore>('TriggersStore'),
  };
}
