/**
 * @fileoverview Plugin registry
 * @description Management node and trigger plug-in registration and query
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
 * Plugin registry
 * @description Singleton mode, manages all registered nodes and triggers
 */
export class PluginRegistry implements PluginRegistrationContext {
  private nodes = new Map<NodeKind, NodeDefinition>();
  private triggers = new Map<TriggerKind, TriggerDefinition>();

  /**
   * Register node definition
   * @description If a node with the same name already exists, it will be overwritten.
   */
  registerNode(def: NodeDefinition): void {
    this.nodes.set(def.kind, def);
  }

  /**
   * Register trigger definition
   * @description If a trigger with the same name already exists, it will be overwritten
   */
  registerTrigger(def: TriggerDefinition): void {
    this.triggers.set(def.kind, def);
  }

  /**
   * Get node definition
   * @returns Node defined or undefined
   */
  getNode(kind: NodeKind): NodeDefinition | undefined {
    return this.nodes.get(kind);
  }

  /**
   * Get node definition (must exist)
   * @throws RRError If the node is not registered
   */
  getNodeOrThrow(kind: NodeKind): NodeDefinition {
    const def = this.nodes.get(kind);
    if (!def) {
      throw createRRError(RR_ERROR_CODES.UNSUPPORTED_NODE, `Node kind "${kind}" is not registered`);
    }
    return def;
  }

  /**
   * Get trigger definition
   * @returns Trigger defined or undefined
   */
  getTrigger(kind: TriggerKind): TriggerDefinition | undefined {
    return this.triggers.get(kind);
  }

  /**
   * Get trigger definition (must exist)
   * @throws RRError If the trigger is not registered
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
   * Check if the node is registered
   */
  hasNode(kind: NodeKind): boolean {
    return this.nodes.has(kind);
  }

  /**
   * Check if the trigger is registered
   */
  hasTrigger(kind: TriggerKind): boolean {
    return this.triggers.has(kind);
  }

  /**
   * Get all registered node types
   */
  listNodeKinds(): NodeKind[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Get all registered trigger types
   */
  listTriggerKinds(): TriggerKind[] {
    return Array.from(this.triggers.keys());
  }

  /**
   * Register plugin
   * @description Call the plugin’s register method
   */
  registerPlugin(plugin: RRPlugin): void {
    plugin.register(this);
  }

  /**
   * Batch registration plug-in
   */
  registerPlugins(plugins: RRPlugin[]): void {
    for (const plugin of plugins) {
      this.registerPlugin(plugin);
    }
  }

  /**
   * Clear all registrations
   * @description Mainly used for testing
   */
  clear(): void {
    this.nodes.clear();
    this.triggers.clear();
  }
}

/** Global plug-in registry instance */
let globalRegistry: PluginRegistry | null = null;

/**
 * Get the global plug-in registry
 */
export function getPluginRegistry(): PluginRegistry {
  if (!globalRegistry) {
    globalRegistry = new PluginRegistry();
  }
  return globalRegistry;
}

/**
 * Reset global plugin registry
 * @description Mainly used for testing
 */
export function resetPluginRegistry(): void {
  globalRegistry = null;
}
