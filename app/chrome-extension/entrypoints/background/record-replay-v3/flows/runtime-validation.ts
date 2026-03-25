import { createReplayActionRegistry } from '@/entrypoints/background/replay-actions';
import type { FlowV3 } from '../domain/flow';
import { getReachableNodes } from '../engine/kernel/traversal';
import { DEFAULT_REPLAY_NODE_EXCLUDE_LIST } from '../engine/plugins/register-replay-nodes';

const EXECUTABLE_RUNTIME_NODE_KINDS = new Set(
  createReplayActionRegistry()
    .list()
    .map((handler) => handler.type)
    .filter((type) => !DEFAULT_REPLAY_NODE_EXCLUDE_LIST.includes(type as (typeof DEFAULT_REPLAY_NODE_EXCLUDE_LIST)[number])),
);

export function validateReachableRuntimeNodes(flow: Pick<FlowV3, 'entryNodeId' | 'nodes' | 'edges'>): void {
  const nodesById = new Map(flow.nodes.map((node) => [node.id, node]));

  for (const nodeId of getReachableNodes(flow as FlowV3)) {
    const node = nodesById.get(nodeId);
    if (!node) {
      continue;
    }
    if (!EXECUTABLE_RUNTIME_NODE_KINDS.has(node.kind)) {
      throw new Error(
        `Flow entry path reaches non-executable node "${node.id}" with kind "${node.kind}"`,
      );
    }
  }
}
