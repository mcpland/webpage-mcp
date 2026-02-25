/**
 * @fileoverview 触发器类型定义
 * @description 定义 Record-Replay V3 中的触发器规范
 */

import type { JsonObject, UnixMillis } from './json';
import type { FlowId, TriggerId } from './ids';

/** 触发器类型 */
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
 * 触发器基础接口
 */
export interface TriggerSpecBase {
  /** 触发器 ID */
  id: TriggerId;
  /** 触发器类型 */
  kind: TriggerKind;
  /** 是否启用 */
  enabled: boolean;
  /** 关联的 Flow ID */
  flowId: FlowId;
  /** 传递给 Flow 的参数 */
  args?: JsonObject;
}

/**
 * URL 匹配规则
 */
export interface UrlMatchRule {
  kind: 'url' | 'domain' | 'path';
  value: string;
}

/**
 * 触发器规范联合类型
 */
export type TriggerSpec =
  // 手动触发
  | (TriggerSpecBase & { kind: 'manual' })

  // URL 触发
  | (TriggerSpecBase & {
      kind: 'url';
      match: UrlMatchRule[];
    })

  // Cron 定时触发
  | (TriggerSpecBase & {
      kind: 'cron';
      cron: string;
      timezone?: string;
    })

  // Interval 定时触发（固定间隔重复）
  | (TriggerSpecBase & {
      kind: 'interval';
      /** 间隔分钟数，最小为 1 */
      periodMinutes: number;
    })

  // Once 定时触发（指定时间触发一次后自动禁用）
  | (TriggerSpecBase & {
      kind: 'once';
      /** 触发时间戳 (Unix milliseconds) */
      whenMs: UnixMillis;
    })

  // 快捷键触发
  | (TriggerSpecBase & {
      kind: 'command';
      commandKey: string;
    })

  // 右键菜单触发
  | (TriggerSpecBase & {
      kind: 'contextMenu';
      title: string;
      contexts?: ReadonlyArray<string>;
    })

  // DOM 元素出现触发
  | (TriggerSpecBase & {
      kind: 'dom';
      selector: string;
      appear?: boolean;
      once?: boolean;
      debounceMs?: UnixMillis;
    });

/**
 * 触发器触发上下文
 * @description 描述触发器被触发时的上下文信息
 */
export interface TriggerFireContext {
  /** 触发器 ID */
  triggerId: TriggerId;
  /** 触发器类型 */
  kind: TriggerKind;
  /** 触发时间 */
  firedAt: UnixMillis;
  /** 来源 Tab ID */
  sourceTabId?: number;
  /** 来源 URL */
  sourceUrl?: string;
}

/**
 * 根据触发器类型获取类型化的触发器规范
 */
export type TriggerSpecByKind<K extends TriggerKind> = Extract<TriggerSpec, { kind: K }>;

/**
 * 判断触发器是否启用
 */
export function isTriggerEnabled(trigger: TriggerSpec): boolean {
  return trigger.enabled;
}

/**
 * 创建触发器触发上下文
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
