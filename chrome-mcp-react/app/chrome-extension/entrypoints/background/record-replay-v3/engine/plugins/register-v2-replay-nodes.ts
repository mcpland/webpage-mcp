/**
 * @fileoverview Register RR-V2 replay action handlers as RR-V3 nodes
 * @description
 * Batch registration of V2 action handlers into the V3 PluginRegistry.
 * This enables V3 to execute flows that use V2 action types.
 */

import { createReplayActionRegistry } from '@/entrypoints/background/record-replay/actions/handlers';
import type {
  ActionHandler,
  ExecutableActionType,
} from '@/entrypoints/background/record-replay/actions/types';

import type { PluginRegistry } from './registry';
import {
  adaptV2ActionHandlerToV3NodeDefinition,
  type V2ActionNodeAdapterOptions,
} from './v2-action-adapter';

export interface RegisterV2ReplayNodesOptions extends V2ActionNodeAdapterOptions {
  /**
   * Only include these action types. If not specified, all V2 handlers are included.
   */
  include?: ReadonlyArray<string>;

  /**
   * Exclude these action types. Applied after include filter.
   */
  exclude?: ReadonlyArray<string>;
}

/**
 * Register V2 replay action handlers as V3 node definitions.
 *
 * @param registry The V3 PluginRegistry to register nodes into
 * @param options Configuration options
 * @returns Array of registered node kinds
 *
 * @example
 * ```ts
 * const plugins = new PluginRegistry();
 * const registered = registerV2ReplayNodesAsV3Nodes(plugins, {
 *   // Exclude control flow handlers that V3 runner doesn't support
 *   exclude: ['foreach', 'while'],
 * });
 * console.log('Registered:', registered);
 * ```
 */
export function registerV2ReplayNodesAsV3Nodes(
  registry: PluginRegistry,
  options: RegisterV2ReplayNodesOptions = {},
): string[] {
  const actionRegistry = createReplayActionRegistry();
  const handlers = actionRegistry.list();

  const include = options.include ? new Set(options.include) : null;
  const exclude = options.exclude ? new Set(options.exclude) : null;

  const registered: string[] = [];

  for (const handler of handlers) {
    if (include && !include.has(handler.type)) continue;
    if (exclude && exclude.has(handler.type)) continue;

    // Cast needed because V2 handler types don't perfectly align with V3 NodeKind
    const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(
      handler as ActionHandler<ExecutableActionType>,
      options,
    );
    registry.registerNode(nodeDef as unknown as Parameters<typeof registry.registerNode>[0]);
    registered.push(handler.type);
  }

  return registered;
}

/**
 * Get list of V2 action types that can be registered.
 * Useful for debugging and documentation.
 */
export function listV2ActionTypes(): string[] {
  const actionRegistry = createReplayActionRegistry();
  return actionRegistry.list().map((h) => h.type);
}

/**
 * Default exclude list for V3 registration.
 * These handlers rely on V2 control directives that V3 runner doesn't support.
 */
export const DEFAULT_V2_EXCLUDE_LIST = ['foreach', 'while'] as const;
