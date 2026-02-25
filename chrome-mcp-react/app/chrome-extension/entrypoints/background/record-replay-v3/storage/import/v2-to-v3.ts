/**
 * @fileoverview V2 到 V3 数据转换器
 * @description 将 V2 格式数据转换为 V3 格式，支持双向转换
 */

import type { FlowV3, NodeV3, EdgeV3, FlowBinding } from '../../domain/flow';
import type { TriggerSpec } from '../../domain/triggers';
import type { VariableDefinition } from '../../domain/variables';
import type { NodeId, FlowId, EdgeId } from '../../domain/ids';
import type { ISODateTimeString } from '../../domain/json';
import { FLOW_SCHEMA_VERSION } from '../../domain/flow';

// ==================== V2 Types (imported from record-replay) ====================

/** V2 Node type definition */
interface V2Node {
  id: string;
  type: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
  ui?: { x: number; y: number };
}

/** V2 Edge type definition */
interface V2Edge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

/** V2 Variable definition */
interface V2VariableDef {
  key: string;
  label?: string;
  sensitive?: boolean;
  default?: unknown;
  type?: string;
  rules?: { required?: boolean; pattern?: string; enum?: string[] };
}

/** V2 Flow binding */
interface V2Binding {
  type: 'domain' | 'path' | 'url';
  value: string;
}

/** V2 Flow definition */
interface V2Flow {
  id: string;
  name: string;
  description?: string;
  version: number;
  meta?: {
    createdAt?: string;
    updatedAt?: string;
    domain?: string;
    tags?: string[];
    bindings?: V2Binding[];
    tool?: { category?: string; description?: string };
    exposedOutputs?: Array<{ nodeId: string; as: string }>;
  };
  variables?: V2VariableDef[];
  nodes?: V2Node[];
  edges?: V2Edge[];
  subflows?: Record<string, { nodes: V2Node[]; edges: V2Edge[] }>;
}

// ==================== Conversion Result Types ====================

export interface ConversionResult<T> {
  success: boolean;
  data?: T;
  errors: string[];
  warnings: string[];
}

// ==================== V2 -> V3 Conversion ====================

/**
 * 将 V2 Flow 转换为 V3 Flow
 * @param v2Flow V2 格式的 Flow
 * @returns 转换结果，包含成功/失败状态、数据和错误/警告信息
 */
export function convertFlowV2ToV3(v2Flow: V2Flow): ConversionResult<FlowV3> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 基础字段验证
  if (!v2Flow.id) {
    errors.push('V2 Flow missing required field: id');
  }
  if (!v2Flow.name) {
    errors.push('V2 Flow missing required field: name');
  }
  if (!v2Flow.nodes || v2Flow.nodes.length === 0) {
    errors.push('V2 Flow has no nodes');
  }

  // 2. 检查不支持的特性
  if (v2Flow.subflows && Object.keys(v2Flow.subflows).length > 0) {
    errors.push(
      'V3 does not support subflows yet. Flow contains subflows: ' +
        Object.keys(v2Flow.subflows).join(', '),
    );
  }

  // 检查 foreach/while 节点
  const unsupportedNodes = (v2Flow.nodes || []).filter(
    (n) => n.type === 'foreach' || n.type === 'while',
  );
  if (unsupportedNodes.length > 0) {
    errors.push(
      'V3 does not support foreach/while nodes yet. Found: ' +
        unsupportedNodes.map((n) => `${n.id} (${n.type})`).join(', '),
    );
  }

  // 如果有致命错误，直接返回
  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  // 3. 转换节点
  const nodes: NodeV3[] = [];
  for (const v2Node of v2Flow.nodes || []) {
    const node = convertNodeV2ToV3(v2Node);
    if (node) {
      nodes.push(node);
    } else {
      warnings.push(`Skipped invalid node: ${v2Node.id}`);
    }
  }

  // 4. 转换边
  const edges: EdgeV3[] = [];
  for (const v2Edge of v2Flow.edges || []) {
    const edge = convertEdgeV2ToV3(v2Edge);
    if (edge) {
      edges.push(edge);
    } else {
      warnings.push(`Skipped invalid edge: ${v2Edge.id}`);
    }
  }

  // 5. 计算 entryNodeId
  const entryResult = findEntryNodeId(nodes, edges);
  warnings.push(...entryResult.warnings);
  if (!entryResult.nodeId) {
    errors.push('Could not determine entry node. No valid root node found.');
    return { success: false, errors, warnings };
  }
  const entryNodeId = entryResult.nodeId;

  // 6. 转换变量
  const variables = convertVariablesV2ToV3(v2Flow.variables || []);

  // 7. 转换元数据
  const meta = convertMetaV2ToV3(v2Flow.meta);

  // 8. 构建 V3 Flow
  const now = new Date().toISOString() as ISODateTimeString;
  const v3Flow: FlowV3 = {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id: v2Flow.id as FlowId,
    name: v2Flow.name,
    createdAt: (v2Flow.meta?.createdAt as ISODateTimeString) || now,
    updatedAt: (v2Flow.meta?.updatedAt as ISODateTimeString) || now,
    entryNodeId,
    nodes,
    edges,
  };

  // 可选字段
  if (v2Flow.description) {
    v3Flow.description = v2Flow.description;
  }
  if (variables.length > 0) {
    v3Flow.variables = variables;
  }
  if (meta) {
    v3Flow.meta = meta;
  }

  return { success: true, data: v3Flow, errors, warnings };
}

/**
 * 转换单个 V2 Node 为 V3 Node
 */
function convertNodeV2ToV3(v2Node: V2Node): NodeV3 | null {
  if (!v2Node.id || !v2Node.type) {
    return null;
  }

  const node: NodeV3 = {
    id: v2Node.id as NodeId,
    kind: v2Node.type, // V2 type -> V3 kind
    config: (v2Node.config as Record<string, unknown>) || {},
  };

  // 可选字段
  if (v2Node.name) {
    node.name = v2Node.name;
  }
  if (v2Node.disabled) {
    node.disabled = v2Node.disabled;
  }
  if (v2Node.ui) {
    node.ui = v2Node.ui;
  }

  return node;
}

/**
 * 转换单个 V2 Edge 为 V3 Edge
 */
function convertEdgeV2ToV3(v2Edge: V2Edge): EdgeV3 | null {
  if (!v2Edge.id || !v2Edge.from || !v2Edge.to) {
    return null;
  }

  const edge: EdgeV3 = {
    id: v2Edge.id as EdgeId,
    from: v2Edge.from as NodeId,
    to: v2Edge.to as NodeId,
  };

  // label 直接传递
  if (v2Edge.label) {
    edge.label = v2Edge.label as EdgeV3['label'];
  }

  return edge;
}

/** entryNodeId 计算结果 */
interface EntryNodeResult {
  nodeId: NodeId | null;
  warnings: string[];
}

/**
 * 找到入口节点 ID
 *
 * 规则：
 * 1. 排除 trigger 类型节点（这些是 UI 节点，不参与执行）
 * 2. 只统计「可执行节点 -> 可执行节点」的边来计算入度（忽略 trigger 指出的边）
 * 3. 找到入度为 0 的节点作为候选
 * 4. 如果有多个候选，使用稳定选择规则：
 *    - 优先选择 UI 坐标最靠左上的节点（按 x 升序，x 相同按 y 升序）
 *    - 如果无 UI 坐标，按 ID 字典序取第一个
 */
function findEntryNodeId(nodes: NodeV3[], edges: EdgeV3[]): EntryNodeResult {
  const warnings: string[] = [];

  // 1. 排除 trigger 节点，获取可执行节点
  const executableNodes = nodes.filter((n) => n.kind !== 'trigger');
  if (executableNodes.length === 0) {
    warnings.push('No executable nodes found; cannot determine entry node');
    return { nodeId: null, warnings };
  }

  const executableNodeIds = new Set<NodeId>(executableNodes.map((n) => n.id));

  // 2. 计算入度（只统计可执行节点之间的边）
  const inDegree = new Map<NodeId, number>();
  for (const node of executableNodes) {
    inDegree.set(node.id, 0);
  }
  for (const edge of edges) {
    // 忽略从非可执行节点（如 trigger）指出的边
    if (!executableNodeIds.has(edge.from)) {
      continue;
    }
    // 忽略指向非可执行节点的边
    if (!executableNodeIds.has(edge.to)) {
      continue;
    }
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // 3. 找入度为 0 的节点
  const rootNodes = executableNodes.filter((n) => inDegree.get(n.id) === 0);

  if (rootNodes.length === 0) {
    // 没有入度为 0 的节点，说明图中存在环，使用稳定选择器选择 fallback
    const fallbackResult = selectStableRootNode(executableNodes);
    warnings.push(
      `No inDegree=0 executable node found (graph may contain cycles); ` +
        `falling back to "${fallbackResult.node.id}" by ${fallbackResult.rule}`,
    );
    return { nodeId: fallbackResult.node.id, warnings };
  }

  // 4. 单个根节点，直接返回
  if (rootNodes.length === 1) {
    return { nodeId: rootNodes[0].id, warnings };
  }

  // 5. 多个根节点，使用稳定选择规则
  const selectedResult = selectStableRootNode(rootNodes);
  const candidateIds = rootNodes
    .map((n) => n.id)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
  warnings.push(
    `Multiple inDegree=0 executable nodes (${candidateIds}); ` +
      `selected "${selectedResult.node.id}" by ${selectedResult.rule}`,
  );

  return { nodeId: selectedResult.node.id, warnings };
}

/** 稳定选择结果 */
interface StableSelectionResult {
  node: NodeV3;
  rule: string;
}

/**
 * 从多个根节点中选择一个稳定的入口节点
 * 优先按 UI 坐标（左上角优先），其次按 ID 字典序
 */
function selectStableRootNode(nodes: NodeV3[]): StableSelectionResult {
  // 检查节点是否有有效的 UI 坐标
  const hasValidUi = (n: NodeV3): n is NodeV3 & { ui: { x: number; y: number } } =>
    !!n.ui && Number.isFinite(n.ui.x) && Number.isFinite(n.ui.y);

  const nodesWithUi = nodes.filter(hasValidUi);

  if (nodesWithUi.length > 0) {
    // 按 UI 坐标排序：x 升序 -> y 升序 -> id 字典序（作为 tie-breaker）
    nodesWithUi.sort((a, b) => {
      if (a.ui.x !== b.ui.x) return a.ui.x - b.ui.x;
      if (a.ui.y !== b.ui.y) return a.ui.y - b.ui.y;
      return a.id.localeCompare(b.id);
    });
    const selected = nodesWithUi[0];
    return {
      node: selected,
      rule: `ui(x=${selected.ui.x}, y=${selected.ui.y})`,
    };
  }

  // 无 UI 坐标，按 ID 字典序
  const sortedById = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  return { node: sortedById[0], rule: 'id' };
}

/**
 * 转换变量定义
 */
function convertVariablesV2ToV3(v2Variables: V2VariableDef[]): VariableDefinition[] {
  return v2Variables
    .filter((v) => v.key)
    .map((v) => {
      const variable: VariableDefinition = {
        name: v.key,
      };

      if (v.label) {
        variable.label = v.label;
      }
      if (v.sensitive) {
        variable.sensitive = v.sensitive;
      }
      if (v.default !== undefined) {
        variable.default = v.default;
      }
      if (v.rules?.required) {
        variable.required = v.rules.required;
      }

      return variable;
    });
}

/**
 * 转换元数据
 */
function convertMetaV2ToV3(v2Meta: V2Flow['meta']): FlowV3['meta'] | undefined {
  if (!v2Meta) return undefined;

  const meta: FlowV3['meta'] = {};

  if (v2Meta.tags && v2Meta.tags.length > 0) {
    meta.tags = v2Meta.tags;
  }

  if (v2Meta.bindings && v2Meta.bindings.length > 0) {
    meta.bindings = v2Meta.bindings.map((b) => ({
      kind: b.type, // V2 type -> V3 kind
      value: b.value,
    }));
  }

  // 如果 meta 为空对象，返回 undefined
  if (Object.keys(meta).length === 0) {
    return undefined;
  }

  return meta;
}

// ==================== V3 -> V2 Conversion ====================

/**
 * 将 V3 Flow 转换为 V2 Flow（用于在 V2 Builder 中编辑）
 * @param v3Flow V3 格式的 Flow
 * @returns 转换结果
 */
export function convertFlowV3ToV2(v3Flow: FlowV3): ConversionResult<V2Flow> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 转换节点
  const nodes: V2Node[] = v3Flow.nodes.map((n) => ({
    id: n.id,
    type: n.kind, // V3 kind -> V2 type
    name: n.name,
    disabled: n.disabled,
    config: n.config as Record<string, unknown>,
    ui: n.ui,
  }));

  // 2. 转换边
  const edges: V2Edge[] = v3Flow.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    label: e.label,
  }));

  // 3. 转换变量
  const variables: V2VariableDef[] = (v3Flow.variables || []).map((v) => ({
    key: v.name,
    label: v.label,
    sensitive: v.sensitive,
    default: v.default,
    rules: v.required ? { required: v.required } : undefined,
  }));

  // 4. 转换元数据
  const meta: V2Flow['meta'] = {
    createdAt: v3Flow.createdAt,
    updatedAt: v3Flow.updatedAt,
  };

  if (v3Flow.meta?.tags) {
    meta.tags = v3Flow.meta.tags;
  }

  if (v3Flow.meta?.bindings) {
    meta.bindings = v3Flow.meta.bindings.map((b) => ({
      type: b.kind, // V3 kind -> V2 type
      value: b.value,
    }));
  }

  // 5. 构建 V2 Flow
  const v2Flow: V2Flow = {
    id: v3Flow.id,
    name: v3Flow.name,
    description: v3Flow.description,
    version: 2, // V2 版本
    meta,
    variables: variables.length > 0 ? variables : undefined,
    nodes,
    edges,
  };

  return { success: true, data: v2Flow, errors, warnings };
}

// ==================== Trigger Conversion ====================

/** V2 Trigger 定义 */
interface V2Trigger {
  id: string;
  type: 'url' | 'command' | 'manual' | 'schedule' | 'element';
  flowId: string;
  enabled?: boolean;
  match?: Array<{ kind: string; value: string }>;
  title?: string;
  commandKey?: string;
  selector?: string;
  appear?: boolean;
  once?: boolean;
  debounceMs?: number;
  schedule?: {
    type: 'interval' | 'daily' | 'weekly';
    intervalMs?: number;
    time?: string;
    days?: number[];
  };
}

/**
 * 将 V2 Trigger 转换为 V3 TriggerSpec
 * @param v2Trigger V2 格式的 Trigger
 * @returns 转换结果
 */
export function convertTriggerV2ToV3(v2Trigger: V2Trigger): ConversionResult<TriggerSpec> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!v2Trigger.id) {
    errors.push('V2 Trigger missing required field: id');
  }
  if (!v2Trigger.flowId) {
    errors.push('V2 Trigger missing required field: flowId');
  }
  if (!v2Trigger.type) {
    errors.push('V2 Trigger missing required field: type');
  }

  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  // 根据 type 构建不同的 TriggerSpec
  let trigger: TriggerSpec;

  switch (v2Trigger.type) {
    case 'manual':
      trigger = {
        id: v2Trigger.id,
        kind: 'manual',
        flowId: v2Trigger.flowId as FlowId,
        enabled: v2Trigger.enabled ?? true,
      };
      break;

    case 'command':
      trigger = {
        id: v2Trigger.id,
        kind: 'command',
        flowId: v2Trigger.flowId as FlowId,
        enabled: v2Trigger.enabled ?? true,
        command: v2Trigger.commandKey || 'run_workflow',
      };
      break;

    case 'url':
      trigger = {
        id: v2Trigger.id,
        kind: 'url',
        flowId: v2Trigger.flowId as FlowId,
        enabled: v2Trigger.enabled ?? true,
        patterns: (v2Trigger.match || []).map((m) => m.value),
      };
      break;

    case 'schedule': { // 将 V2 schedule 转换为 cron 表达式
      const cron = convertScheduleToCron(v2Trigger.schedule);
      if (!cron) {
        errors.push('Could not convert V2 schedule to cron expression');
        return { success: false, errors, warnings };
      }
      trigger = {
        id: v2Trigger.id,
        kind: 'cron',
        flowId: v2Trigger.flowId as FlowId,
        enabled: v2Trigger.enabled ?? true,
        cron,
      };
      break;
    }

    case 'element':
      warnings.push('Element trigger is not fully supported in V3, converting to manual');
      trigger = {
        id: v2Trigger.id,
        kind: 'manual',
        flowId: v2Trigger.flowId as FlowId,
        enabled: v2Trigger.enabled ?? true,
      };
      break;

    default:
      errors.push(`Unknown V2 trigger type: ${v2Trigger.type}`);
      return { success: false, errors, warnings };
  }

  return { success: true, data: trigger, errors, warnings };
}

/**
 * Convert V2 schedule config to cron expression
 */
function convertScheduleToCron(schedule: V2Trigger['schedule']): string | null {
  if (!schedule) return null;

  switch (schedule.type) {
    case 'interval': { // 将间隔转换为近似 cron（每 N 分钟）
      const intervalMinutes = Math.max(1, Math.round((schedule.intervalMs || 60000) / 60000));
      if (intervalMinutes < 60) {
        return `*/${intervalMinutes} * * * *`;
      } else {
        const hours = Math.round(intervalMinutes / 60);
        return `0 */${hours} * * *`;
      }
    }

    case 'daily':
      // 每天指定时间
      if (schedule.time) {
        const [hour, minute] = schedule.time.split(':').map(Number);
        return `${minute || 0} ${hour || 0} * * *`;
      }
      return '0 0 * * *'; // 默认每天 0:00

    case 'weekly': { // 每周指定天数和时间
      const days = (schedule.days || [0]).join(',');
      if (schedule.time) {
        const [hour, minute] = schedule.time.split(':').map(Number);
        return `${minute || 0} ${hour || 0} * * ${days}`;
      }
      return `0 0 * * ${days}`;
    }

    default:
      return null;
  }
}

// ==================== Converter Interface ====================

/**
 * V2 到 V3 转换器接口
 */
export interface V2ToV3Converter {
  /** 转换 Flow */
  convertFlow(v2Flow: unknown): FlowV3;
  /** 转换 Trigger */
  convertTrigger(v2Trigger: unknown): TriggerSpec;
}

/**
 * 创建 V2ToV3Converter 实例
 */
export function createV2ToV3Converter(): V2ToV3Converter {
  return {
    convertFlow(v2Flow: unknown): FlowV3 {
      const result = convertFlowV2ToV3(v2Flow as V2Flow);
      if (!result.success || !result.data) {
        throw new Error(`Flow conversion failed: ${result.errors.join('; ')}`);
      }
      return result.data;
    },

    convertTrigger(v2Trigger: unknown): TriggerSpec {
      const result = convertTriggerV2ToV3(v2Trigger as V2Trigger);
      if (!result.success || !result.data) {
        throw new Error(`Trigger conversion failed: ${result.errors.join('; ')}`);
      }
      return result.data;
    },
  };
}

/**
 * 创建 NotImplemented 的 V2ToV3Converter（向后兼容）
 * @deprecated 使用 createV2ToV3Converter() 替代
 */
export function createNotImplementedV2ToV3Converter(): V2ToV3Converter {
  return createV2ToV3Converter();
}
