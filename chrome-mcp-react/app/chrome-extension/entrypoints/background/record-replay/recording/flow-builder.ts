import type { Edge, Flow, NodeBase, Step } from '../types';
import { STEP_TYPES } from '@/common/step-types';
import { recordingSession } from './session-manager';
import { mapStepToNodeConfig, EDGE_LABELS } from 'webpage-mcp-shared';

const WORKFLOW_VERSION = 1;

/**
 * Creates an initial flow structure for recording.
 * Initializes with nodes/edges (DAG) instead of steps.
 */
export function createInitialFlow(meta?: Partial<Flow>): Flow {
  const timeStamp = new Date().toISOString();
  const flow: Flow = {
    id: meta?.id || `flow_${Date.now()}`,
    name: meta?.name || 'new_workflow',
    version: WORKFLOW_VERSION,
    nodes: [],
    edges: [],
    variables: [],
    meta: {
      createdAt: timeStamp,
      updatedAt: timeStamp,
      ...meta?.meta,
    },
  };
  return flow;
}

export function generateStepId(): string {
  return `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Appends a navigation step to the flow.
 * Prefers centralized session append when recording is active.
 * Falls back to direct DAG mutation (does NOT write flow.steps).
 */
export function addNavigationStep(flow: Flow, url: string): void {
  const step: Step = { id: generateStepId(), type: STEP_TYPES.NAVIGATE, url } as Step;

  // Prefer centralized session append (single broadcast path) when active and matching flow
  const sessFlow = recordingSession.getFlow?.();
  if (recordingSession.getStatus?.() === 'recording' && sessFlow === flow) {
    recordingSession.appendSteps([step]);
    return;
  }

  // Fallback: mutate DAG directly (do not write flow.steps)
  appendNodeToFlow(flow, step);
}

/**
 * Appends a step as a node to the flow's DAG structure.
 * Creates node and edge from the previous node if exists.
 *
 * Internal helper - rarely invoked in practice. During active recording,
 * addNavigationStep() routes to session.appendSteps() which handles DAG
 * maintenance, caching, and timeline broadcast. This fallback only runs
 * when session is not active or flow reference doesn't match.
 */
function appendNodeToFlow(flow: Flow, step: Step): void {
  // Ensure DAG arrays exist
  if (!Array.isArray(flow.nodes)) flow.nodes = [];
  if (!Array.isArray(flow.edges)) flow.edges = [];

  const prevNodeId = flow.nodes.length > 0 ? flow.nodes[flow.nodes.length - 1]?.id : undefined;

  // Create new node
  const newNode: NodeBase = {
    id: step.id,
    type: step.type as NodeBase['type'],
    config: mapStepToNodeConfig(step),
  };
  flow.nodes.push(newNode);

  // Create edge from previous node if exists
  if (prevNodeId) {
    const edgeId = `e_${flow.edges.length}_${prevNodeId}_${step.id}`;
    const edge: Edge = {
      id: edgeId,
      from: prevNodeId,
      to: step.id,
      label: EDGE_LABELS.DEFAULT,
    };
    flow.edges.push(edge);
  }

  // Update meta timestamp (with error tolerance like session-manager)
  try {
    const timeStamp = new Date().toISOString();
    if (!flow.meta) {
      flow.meta = { createdAt: timeStamp, updatedAt: timeStamp };
    } else {
      flow.meta.updatedAt = timeStamp;
    }
  } catch {
    // ignore meta update errors to not block recording
  }
}
