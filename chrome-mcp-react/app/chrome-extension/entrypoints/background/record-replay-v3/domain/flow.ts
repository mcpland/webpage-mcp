/**
 * @fileoverview Flow 类型定义
 * @description 定义 Record-Replay V3 中的 Flow IR（中间表示）
 */

import type { ISODateTimeString, JsonObject } from './json';
import type { EdgeId, EdgeLabel, FlowId, NodeId } from './ids';
import type { FlowPolicy, NodePolicy } from './policy';
import type { VariableDefinition } from './variables';

/** Flow Schema 版本 */
export const FLOW_SCHEMA_VERSION = 3 as const;

/**
 * Edge V3
 * @description DAG 中的边，连接两个节点
 */
export interface EdgeV3 {
  /** Edge 唯一标识符 */
  id: EdgeId;
  /** 源节点 ID */
  from: NodeId;
  /** 目标节点 ID */
  to: NodeId;
  /** 边标签（用于条件分支和错误处理） */
  label?: EdgeLabel;
}

/** 节点类型（可扩展） */
export type NodeKind = string;

/**
 * Node V3
 * @description DAG 中的节点，代表一个可执行的操作
 */
export interface NodeV3 {
  /** Node 唯一标识符 */
  id: NodeId;
  /** 节点类型 */
  kind: NodeKind;
  /** 节点名称（用于显示） */
  name?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 节点级策略 */
  policy?: NodePolicy;
  /** 节点配置（类型由 kind 决定） */
  config: JsonObject;
  /** UI 布局信息 */
  ui?: { x: number; y: number };
}

/**
 * Flow 元数据绑定
 * @description 定义 Flow 与特定域名/路径/URL 的关联
 */
export interface FlowBinding {
  kind: 'domain' | 'path' | 'url';
  value: string;
}

/**
 * Flow V3
 * @description 完整的 Flow 定义，包含节点、边和配置
 */
export interface FlowV3 {
  /** Schema 版本 */
  schemaVersion: typeof FLOW_SCHEMA_VERSION;
  /** Flow 唯一标识符 */
  id: FlowId;
  /** Flow 名称 */
  name: string;
  /** Flow 描述 */
  description?: string;
  /** 创建时间 */
  createdAt: ISODateTimeString;
  /** 更新时间 */
  updatedAt: ISODateTimeString;

  /** 入口节点 ID（显式指定，不依赖入度推断） */
  entryNodeId: NodeId;
  /** 节点列表 */
  nodes: NodeV3[];
  /** 边列表 */
  edges: EdgeV3[];

  /** 变量定义 */
  variables?: VariableDefinition[];
  /** Flow 级策略 */
  policy?: FlowPolicy;
  /** 元数据 */
  meta?: {
    /** 标签 */
    tags?: string[];
    /** 绑定规则 */
    bindings?: FlowBinding[];
  };
}

/**
 * 根据 ID 查找节点
 */
export function findNodeById(flow: FlowV3, nodeId: NodeId): NodeV3 | undefined {
  return flow.nodes.find((n) => n.id === nodeId);
}

/**
 * 查找从指定节点出发的所有边
 */
export function findEdgesFrom(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.from === nodeId);
}

/**
 * 查找指向指定节点的所有边
 */
export function findEdgesTo(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.to === nodeId);
}
