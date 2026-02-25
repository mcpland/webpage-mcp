/**
 * @fileoverview V2 数据读取器
 * @description 读取 V2 格式的数据（占位实现）
 */

/**
 * V2 数据读取器接口
 * @description Phase 5+ 实现
 */
export interface V2Reader {
  /** 读取 V2 Flows */
  readFlows(): Promise<unknown[]>;
  /** 读取 V2 Runs */
  readRuns(): Promise<unknown[]>;
  /** 读取 V2 Triggers */
  readTriggers(): Promise<unknown[]>;
  /** 读取 V2 Schedules */
  readSchedules(): Promise<unknown[]>;
}

/**
 * 创建 NotImplemented 的 V2Reader
 */
export function createNotImplementedV2Reader(): V2Reader {
  const notImplemented = async () => {
    throw new Error('V2Reader not implemented');
  };

  return {
    readFlows: notImplemented,
    readRuns: notImplemented,
    readTriggers: notImplemented,
    readSchedules: notImplemented,
  };
}
