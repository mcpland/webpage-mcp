/**
 * @fileoverview Register replay action handlers as runtime nodes.
 * @description Batch registration of action handlers into the RR-V3 PluginRegistry.
 */

import { createReplayActionRegistry } from '@/entrypoints/background/replay-actions';
import type { ActionHandler, ExecutableActionType } from '@/entrypoints/background/replay-actions';

import type { PluginRegistry } from './registry';
import {
  adaptActionHandlerToNodeDefinition,
  type ActionHandlerNodeAdapterOptions,
} from './action-handler-node-adapter';

export interface RegisterReplayNodesOptions extends ActionHandlerNodeAdapterOptions {
  /**
   * Only include these action types. If not specified, all handlers are included.
   */
  include?: ReadonlyArray<string>;

  /**
   * Exclude these action types. Applied after include filter.
   */
  exclude?: ReadonlyArray<string>;
}

/**
 * Register replay action handlers as runtime node definitions.
 *
 * @param registry The V3 PluginRegistry to register nodes into
 * @param options Configuration options
 * @returns Array of registered node kinds
 *
 * @example
 * ```ts
 * const plugins = new PluginRegistry();
 * const registered = registerReplayNodes(plugins, {
 *   // Exclude control flow handlers that V3 runner doesn't support
 *   exclude: ['foreach', 'while'],
 * });
 * console.log('Registered:', registered);
 * ```
 */
export function registerReplayNodes(
  registry: PluginRegistry,
  options: RegisterReplayNodesOptions = {},
): string[] {
  const actionRegistry = createReplayActionRegistry();
  const handlers = actionRegistry.list();

  const include = options.include ? new Set(options.include) : null;
  const exclude = options.exclude ? new Set(options.exclude) : null;

  const registered: string[] = [];

  for (const handler of handlers) {
    if (include && !include.has(handler.type)) continue;
    if (exclude && exclude.has(handler.type)) continue;

    // Cast needed because action-handler types don't perfectly align with NodeKind
    const nodeDef = adaptActionHandlerToNodeDefinition(
      handler as ActionHandler<ExecutableActionType>,
      options,
    );
    registry.registerNode(nodeDef as unknown as Parameters<typeof registry.registerNode>[0]);
    registered.push(handler.type);
  }

  return registered;
}

/**
 * Get list of action types that can be registered.
 * Useful for debugging and documentation.
 */
export function listReplayActionTypes(): string[] {
  const actionRegistry = createReplayActionRegistry();
  return actionRegistry.list().map((h) => h.type);
}

/**
 * Default exclude list for V3 registration.
 * These handlers rely on control directives that the V3 runner doesn't support.
 */
export const DEFAULT_REPLAY_NODE_EXCLUDE_LIST = ['foreach', 'while'] as const;
