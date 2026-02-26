/**
 * @fileoverview Flow type definition
 * @description Defining Flow IR (Intermediate Representation) in Record-Replay V3
 */

import type { ISODateTimeString, JsonObject } from './json';
import type { EdgeId, EdgeLabel, FlowId, NodeId } from './ids';
import type { FlowPolicy, NodePolicy } from './policy';
import type { VariableDefinition } from './variables';

/** Flow Schema version */
export const FLOW_SCHEMA_VERSION = 3 as const;

/**
 * Edge V3
 * @description DAG The edge in , connects two nodes
 */
export interface EdgeV3 {
  /** Edge unique identifier */
  id: EdgeId;
  /** Source node ID */
  from: NodeId;
  /** Target node ID */
  to: NodeId;
  /** Edge labels (for conditional branching and error handling) */
  label?: EdgeLabel;
}

/** Node type (extensible) */
export type NodeKind = string;

/**
 * Node V3
 * @description DAG The nodes in represent an executable operation
 */
export interface NodeV3 {
  /** Node unique identifier */
  id: NodeId;
  /** Node type */
  kind: NodeKind;
  /** Node name (for display) */
  name?: string;
  /** Whether to disable */
  disabled?: boolean;
  /** Node level policy */
  policy?: NodePolicy;
  /** Node configuration (type determined by kind) */
  config: JsonObject;
  /** UI layout information */
  ui?: { x: number; y: number };
}

/**
 * Flow metadata binding
 * @description Define the association of Flow with a specific domain name/path/URL
 */
export interface FlowBinding {
  kind: 'domain' | 'path' | 'url';
  value: string;
}

/**
 * Flow V3
 * @description Complete Flow definition, including nodes, edges and configurations
 */
export interface FlowV3 {
  /** Schema version */
  schemaVersion: typeof FLOW_SCHEMA_VERSION;
  /** Flow unique identifier */
  id: FlowId;
  /** Flow Name */
  name: string;
  /** Flow Description */
  description?: string;
  /** creation time */
  createdAt: ISODateTimeString;
  /** Update time */
  updatedAt: ISODateTimeString;

  /** Entry node ID (specified explicitly, does not rely on in-degree inference) */
  entryNodeId: NodeId;
  /** node list */
  nodes: NodeV3[];
  /** edge list */
  edges: EdgeV3[];

  /** variable definition */
  variables?: VariableDefinition[];
  /** Flow level strategy */
  policy?: FlowPolicy;
  /** Metadata */
  meta?: {
    /** label */
    tags?: string[];
    /** Binding rules */
    bindings?: FlowBinding[];
  };
}

/**
 * Find node by ID
 */
export function findNodeById(flow: FlowV3, nodeId: NodeId): NodeV3 | undefined {
  return flow.nodes.find((n) => n.id === nodeId);
}

/**
 * Find all edges starting from a specified node
 */
export function findEdgesFrom(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.from === nodeId);
}

/**
 * Find all edges pointing to a specified node
 */
export function findEdgesTo(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.to === nodeId);
}
