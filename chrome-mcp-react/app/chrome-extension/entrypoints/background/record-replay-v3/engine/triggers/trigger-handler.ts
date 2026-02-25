/**
 * @fileoverview 触发器处理器接口定义
 * @description 定义各类触发器的统一接口
 */

import type { TriggerSpec, TriggerKind } from '../../domain/triggers';

/**
 * 触发器处理器接口
 * @description 每种触发器类型需要实现此接口
 */
export interface TriggerHandler<K extends TriggerKind = TriggerKind> {
  /** 触发器类型 */
  readonly kind: K;

  /**
   * 安装触发器
   * @description 注册 chrome API 监听器等
   * @param trigger 触发器规范
   */
  install(trigger: Extract<TriggerSpec, { kind: K }>): Promise<void>;

  /**
   * 卸载触发器
   * @description 移除 chrome API 监听器等
   * @param triggerId 触发器 ID
   */
  uninstall(triggerId: string): Promise<void>;

  /**
   * 卸载所有触发器
   * @description 清理所有此类型的触发器
   */
  uninstallAll(): Promise<void>;

  /**
   * 获取已安装的触发器 ID 列表
   */
  getInstalledIds(): string[];
}

/**
 * 触发器触发回调
 * @description TriggerManager 注入给各 Handler 的回调
 */
export interface TriggerFireCallback {
  /**
   * 触发器被触发时调用
   * @param triggerId 触发器 ID
   * @param context 触发上下文
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
 * 触发器处理器工厂
 */
export type TriggerHandlerFactory<K extends TriggerKind> = (
  fireCallback: TriggerFireCallback,
) => TriggerHandler<K>;
