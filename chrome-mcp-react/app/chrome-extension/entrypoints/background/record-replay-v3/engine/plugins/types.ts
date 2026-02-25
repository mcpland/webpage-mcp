/**
 * @fileoverview 插件类型定义
 * @description 定义 Record-Replay V3 中的节点和触发器插件接口
 */

import { z } from 'zod';

import type { JsonObject, JsonValue } from '../../domain/json';
import type { FlowId, NodeId, RunId, TriggerId } from '../../domain/ids';
import type { NodeKind } from '../../domain/flow';
import type { RRError } from '../../domain/errors';
import type { NodePolicy } from '../../domain/policy';
import type { FlowV3, NodeV3 } from '../../domain/flow';
import type { TriggerKind } from '../../domain/triggers';

/**
 * Schema 类型
 * @description 使用 Zod 进行配置校验
 */
export type Schema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

/**
 * 节点执行上下文
 * @description 提供给节点执行器的运行时上下文
 */
export interface NodeExecutionContext {
  /** Run ID */
  runId: RunId;
  /** Flow 定义（快照） */
  flow: FlowV3;
  /** 当前节点 ID */
  nodeId: NodeId;

  /** 绑定的 Tab ID（每 Run 独占） */
  tabId: number;
  /** Frame ID（默认 0 为主框架） */
  frameId?: number;

  /** 当前变量表 */
  vars: Record<string, JsonValue>;

  /**
   * 日志记录
   */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: JsonValue) => void;

  /**
   * 选择下一个边
   * @description 用于条件分支节点
   */
  chooseNext: (label: string) => { kind: 'edgeLabel'; label: string };

  /**
   * 工件操作
   */
  artifacts: {
    /** 截取当前页面截图 */
    screenshot: () => Promise<{ ok: true; base64: string } | { ok: false; error: RRError }>;
  };

  /**
   * 持久化变量操作
   */
  persistent: {
    /** 获取持久化变量 */
    get: (name: `$${string}`) => Promise<JsonValue | undefined>;
    /** 设置持久化变量 */
    set: (name: `$${string}`, value: JsonValue) => Promise<void>;
    /** 删除持久化变量 */
    delete: (name: `$${string}`) => Promise<void>;
  };
}

/**
 * 变量补丁操作
 */
export interface VarsPatchOp {
  op: 'set' | 'delete';
  name: string;
  value?: JsonValue;
}

/**
 * 节点执行结果
 */
export type NodeExecutionResult =
  | {
      status: 'succeeded';
      /** 下一步执行方向 */
      next?: { kind: 'edgeLabel'; label: string } | { kind: 'end' };
      /** 输出结果 */
      outputs?: JsonObject;
      /** 变量修改 */
      varsPatch?: VarsPatchOp[];
    }
  | { status: 'failed'; error: RRError };

/**
 * 节点定义
 * @description 定义一种节点类型的执行逻辑
 */
export interface NodeDefinition<
  TKind extends NodeKind = NodeKind,
  TConfig extends JsonObject = JsonObject,
> {
  /** 节点类型标识 */
  kind: TKind;
  /** 配置校验 Schema */
  schema: Schema<TConfig>;
  /** 默认策略 */
  defaultPolicy?: NodePolicy;
  /**
   * 执行节点
   * @param ctx 执行上下文
   * @param node 节点定义（含配置）
   */
  execute(
    ctx: NodeExecutionContext,
    node: NodeV3 & { kind: TKind; config: TConfig },
  ): Promise<NodeExecutionResult>;
}

/**
 * 触发器安装上下文
 */
export interface TriggerInstallContext<
  TKind extends TriggerKind = TriggerKind,
  TConfig extends JsonObject = JsonObject,
> {
  /** 触发器 ID */
  triggerId: TriggerId;
  /** 触发器类型 */
  kind: TKind;
  /** 是否启用 */
  enabled: boolean;
  /** 关联的 Flow ID */
  flowId: FlowId;
  /** 触发器配置 */
  config: TConfig;
  /** 传递给 Flow 的参数 */
  args?: JsonObject;
}

/**
 * 触发器定义
 * @description 定义一种触发器类型的安装和卸载逻辑
 */
export interface TriggerDefinition<
  TKind extends TriggerKind = TriggerKind,
  TConfig extends JsonObject = JsonObject,
> {
  /** 触发器类型标识 */
  kind: TKind;
  /** 配置校验 Schema */
  schema: Schema<TConfig>;
  /** 安装触发器 */
  install(ctx: TriggerInstallContext<TKind, TConfig>): Promise<void> | void;
  /** 卸载触发器 */
  uninstall(ctx: TriggerInstallContext<TKind, TConfig>): Promise<void> | void;
}

/**
 * 插件注册上下文
 */
export interface PluginRegistrationContext {
  /** 注册节点定义 */
  registerNode(def: NodeDefinition): void;
  /** 注册触发器定义 */
  registerTrigger(def: TriggerDefinition): void;
}

/**
 * 插件接口
 * @description Record-Replay 插件的标准接口
 */
export interface RRPlugin {
  /** 插件名称 */
  name: string;
  /** 注册插件内容 */
  register(ctx: PluginRegistrationContext): void;
}
