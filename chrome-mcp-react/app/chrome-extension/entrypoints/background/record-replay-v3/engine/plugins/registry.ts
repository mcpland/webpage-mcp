/**
 * @fileoverview 插件注册表
 * @description 管理节点和触发器插件的注册和查询
 */

import type { NodeKind } from '../../domain/flow';
import type { TriggerKind } from '../../domain/triggers';
import { RR_ERROR_CODES, createRRError } from '../../domain/errors';
import type {
  NodeDefinition,
  TriggerDefinition,
  PluginRegistrationContext,
  RRPlugin,
} from './types';

/**
 * 插件注册表
 * @description 单例模式，管理所有已注册的节点和触发器
 */
export class PluginRegistry implements PluginRegistrationContext {
  private nodes = new Map<NodeKind, NodeDefinition>();
  private triggers = new Map<TriggerKind, TriggerDefinition>();

  /**
   * 注册节点定义
   * @description 如果已存在同名节点，会覆盖
   */
  registerNode(def: NodeDefinition): void {
    this.nodes.set(def.kind, def);
  }

  /**
   * 注册触发器定义
   * @description 如果已存在同名触发器，会覆盖
   */
  registerTrigger(def: TriggerDefinition): void {
    this.triggers.set(def.kind, def);
  }

  /**
   * 获取节点定义
   * @returns 节点定义或 undefined
   */
  getNode(kind: NodeKind): NodeDefinition | undefined {
    return this.nodes.get(kind);
  }

  /**
   * 获取节点定义（必须存在）
   * @throws RRError 如果节点未注册
   */
  getNodeOrThrow(kind: NodeKind): NodeDefinition {
    const def = this.nodes.get(kind);
    if (!def) {
      throw createRRError(RR_ERROR_CODES.UNSUPPORTED_NODE, `Node kind "${kind}" is not registered`);
    }
    return def;
  }

  /**
   * 获取触发器定义
   * @returns 触发器定义或 undefined
   */
  getTrigger(kind: TriggerKind): TriggerDefinition | undefined {
    return this.triggers.get(kind);
  }

  /**
   * 获取触发器定义（必须存在）
   * @throws RRError 如果触发器未注册
   */
  getTriggerOrThrow(kind: TriggerKind): TriggerDefinition {
    const def = this.triggers.get(kind);
    if (!def) {
      throw createRRError(
        RR_ERROR_CODES.UNSUPPORTED_NODE,
        `Trigger kind "${kind}" is not registered`,
      );
    }
    return def;
  }

  /**
   * 检查节点是否已注册
   */
  hasNode(kind: NodeKind): boolean {
    return this.nodes.has(kind);
  }

  /**
   * 检查触发器是否已注册
   */
  hasTrigger(kind: TriggerKind): boolean {
    return this.triggers.has(kind);
  }

  /**
   * 获取所有已注册的节点类型
   */
  listNodeKinds(): NodeKind[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * 获取所有已注册的触发器类型
   */
  listTriggerKinds(): TriggerKind[] {
    return Array.from(this.triggers.keys());
  }

  /**
   * 注册插件
   * @description 调用插件的 register 方法
   */
  registerPlugin(plugin: RRPlugin): void {
    plugin.register(this);
  }

  /**
   * 批量注册插件
   */
  registerPlugins(plugins: RRPlugin[]): void {
    for (const plugin of plugins) {
      this.registerPlugin(plugin);
    }
  }

  /**
   * 清空所有注册
   * @description 主要用于测试
   */
  clear(): void {
    this.nodes.clear();
    this.triggers.clear();
  }
}

/** 全局插件注册表实例 */
let globalRegistry: PluginRegistry | null = null;

/**
 * 获取全局插件注册表
 */
export function getPluginRegistry(): PluginRegistry {
  if (!globalRegistry) {
    globalRegistry = new PluginRegistry();
  }
  return globalRegistry;
}

/**
 * 重置全局插件注册表
 * @description 主要用于测试
 */
export function resetPluginRegistry(): void {
  globalRegistry = null;
}
