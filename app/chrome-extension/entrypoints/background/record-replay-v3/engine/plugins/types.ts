/**
 * @fileoverview Plug-in type definition
 * @description Define node and trigger plugin interfaces in Record-Replay V3
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
 * Schema Type
 * @description Use Zod for configuration verification
 */
export type Schema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

/**
 * node execution context
 * @description The runtime context provided to the node executor
 */
export interface NodeExecutionContext {
  /** Run ID */
  runId: RunId;
  /** Flow Definition (snapshot) */
  flow: FlowV3;
  /** Current node ID */
  nodeId: NodeId;

  /** Bind Tab ID (exclusive per Run) */
  tabId: number;
  /** Frame ID（Default 0 is the main frame) */
  frameId?: number;

  /** Current variable table */
  vars: Record<string, JsonValue>;

  /**
   * logging
   */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: JsonValue) => void;

  /**
   * Select next edge
   * @description Used for conditional branch nodes
   */
  chooseNext: (label: string) => { kind: 'edgeLabel'; label: string };

  /**
   * Workpiece operations
   */
  artifacts: {
    /** Take a screenshot of the current page */
    screenshot: () => Promise<{ ok: true; base64: string } | { ok: false; error: RRError }>;
  };

  /**
   * Persistent variable operations
   */
  persistent: {
    /** Get persistent variables */
    get: (name: `$${string}`) => Promise<JsonValue | undefined>;
    /** Set persistent variables */
    set: (name: `$${string}`, value: JsonValue) => Promise<void>;
    /** Delete persistent variables */
    delete: (name: `$${string}`) => Promise<void>;
  };
}

/**
 * Variable patch operation
 */
export interface VarsPatchOp {
  op: 'set' | 'delete';
  name: string;
  value?: JsonValue;
}

/**
 * Node execution results
 */
export type NodeExecutionResult =
  | {
      status: 'succeeded';
      /** Next execution direction */
      next?: { kind: 'edgeLabel'; label: string } | { kind: 'end' };
      /** Output results */
      outputs?: JsonObject;
      /** Variable modification */
      varsPatch?: VarsPatchOp[];
    }
  | { status: 'failed'; error: RRError };

/**
 * Node definition
 * @description Define execution logic for a node type
 */
export interface NodeDefinition<
  TKind extends NodeKind = NodeKind,
  TConfig extends JsonObject = JsonObject,
> {
  /** Node type identifier */
  kind: TKind;
  /** Configuration verification Schema */
  schema: Schema<TConfig>;
  /** Default policy */
  defaultPolicy?: NodePolicy;
  /**
   * execution node
   * @param ctx execution context
   * @param node Node definition (including configuration)
   */
  execute(
    ctx: NodeExecutionContext,
    node: NodeV3 & { kind: TKind; config: TConfig },
  ): Promise<NodeExecutionResult>;
}

/**
 * trigger installation context
 */
export interface TriggerInstallContext<
  TKind extends TriggerKind = TriggerKind,
  TConfig extends JsonObject = JsonObject,
> {
  /** Trigger ID */
  triggerId: TriggerId;
  /** Trigger type */
  kind: TKind;
  /** Whether to enable */
  enabled: boolean;
  /** Associated Flow ID */
  flowId: FlowId;
  /** Trigger configuration */
  config: TConfig;
  /** Parameters passed to Flow */
  args?: JsonObject;
}

/**
 * Trigger definition
 * @description Define installation and uninstallation logic for a trigger type
 */
export interface TriggerDefinition<
  TKind extends TriggerKind = TriggerKind,
  TConfig extends JsonObject = JsonObject,
> {
  /** Trigger type identifier */
  kind: TKind;
  /** Configuration verification Schema */
  schema: Schema<TConfig>;
  /** Install trigger */
  install(ctx: TriggerInstallContext<TKind, TConfig>): Promise<void> | void;
  /** uninstall trigger */
  uninstall(ctx: TriggerInstallContext<TKind, TConfig>): Promise<void> | void;
}

/**
 * Plugin registration context
 */
export interface PluginRegistrationContext {
  /** Register node definition */
  registerNode(def: NodeDefinition): void;
  /** Register trigger definition */
  registerTrigger(def: TriggerDefinition): void;
}

/**
 * Plug-in interface
 * @description Record-Replay Standard interface for plug-ins
 */
export interface RRPlugin {
  /** Plugin name */
  name: string;
  /** Register plugin content */
  register(ctx: PluginRegistrationContext): void;
}
