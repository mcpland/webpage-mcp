import type { Flow, RunRecord, NodeBase, Edge } from './types';
import { stepsToDAG, type RRNode, type RREdge } from 'webpage-mcp-shared';
import { NODE_TYPES } from '@/common/node-types';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { IndexedDbStorage, ensureMigratedFromLocal } from './storage/indexeddb-manager';

// Design note: IndexedDB-backed store for flows and run records.
// Includes lazy migration from chrome.storage.local for backwards compatibility.

// Validate if a type string is a valid NodeType
const VALID_NODE_TYPES = new Set<string>(Object.values(NODE_TYPES));
function isValidNodeType(type: string): boolean {
  return VALID_NODE_TYPES.has(type);
}

// Convert RRNode to NodeBase (ui coordinates are optional, not added here)
function toNodeBase(node: RRNode): NodeBase {
  return {
    id: node.id,
    type: isValidNodeType(node.type) ? (node.type as NodeBase['type']) : NODE_TYPES.SCRIPT,
    config: node.config,
  };
}

// Convert RREdge to Edge
function toEdge(edge: RREdge): Edge {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    label: edge.label,
  };
}

/**
 * Filter edges to only keep those whose from/to both exist in nodeIds.
 * Prevents topoOrder crash when edges reference non-existent nodes.
 */
function filterValidEdges(edges: Edge[], nodeIds: Set<string>): Edge[] {
  return edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
}

// =============================================================================
// UI Notification
// =============================================================================

/**
 * Timer handle for coalescing flow change notifications.
 * Prevents multiple rapid changes (e.g., during import) from flooding UI.
 */
let flowsChangedTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Notify UI that flows have changed.
 * Uses a short debounce (50ms) to coalesce rapid changes.
 */
function notifyFlowsChanged(): void {
  // If timer is already scheduled, skip (will be handled by pending timer)
  if (flowsChangedTimer !== undefined) return;

  flowsChangedTimer = setTimeout(() => {
    flowsChangedTimer = undefined;
    try {
      // Send message to all extension contexts (popup, sidepanel, etc.)
      // Use void cast to avoid unhandled promise rejection
      void chrome.runtime
        .sendMessage({
          type: BACKGROUND_MESSAGE_TYPES.RR_FLOWS_CHANGED,
        })
        .catch(() => {
          // Ignore errors - no listeners is expected when UI is closed
        });
    } catch {
      // Ignore errors (e.g., if chrome.runtime is not available)
    }
  }, 50);
}

/**
 * Strip deprecated steps field before persisting to IndexedDB.
 * This ensures new saves only contain the DAG model (nodes/edges).
 *
 * @param flow - Flow with or without steps
 * @returns Flow without steps field (omit entirely, not set to empty array)
 */
function stripStepsForSave(flow: Flow): Flow {
  if (!('steps' in flow)) {
    return flow;
  }

  const { steps: _steps, ...rest } = flow;
  return rest as Flow;
}

/**
 * Normalize flow before saving: ensure nodes/edges exist for scheduler compatibility.
 * Only generates DAG from steps if nodes are missing or empty.
 * Preserves existing nodes/edges to avoid overwriting user edits.
 *
 * Also validates edges: removes edges referencing non-existent nodes to prevent
 * runtime errors in scheduler's topoOrder calculation.
 */
function normalizeFlowForSave(flow: Flow): Flow {
  const hasNodes = Array.isArray(flow.nodes) && flow.nodes.length > 0;
  if (hasNodes) {
    // Validate edges even when nodes exist (e.g., imported flows may have invalid edges)
    const nodeIds = new Set(flow.nodes!.map((n) => n.id));
    if (Array.isArray(flow.edges) && flow.edges.length > 0) {
      const validEdges = filterValidEdges(flow.edges, nodeIds);
      if (validEdges.length !== flow.edges.length) {
        // Some edges were invalid, return cleaned flow
        return { ...flow, edges: validEdges };
      }
    }
    return flow;
  }

  // No nodes - generate from steps
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    return flow;
  }

  const dag = stepsToDAG(flow.steps);
  if (dag.nodes.length === 0) {
    return flow;
  }

  const nodes: NodeBase[] = dag.nodes.map(toNodeBase);
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Validate existing edges: only keep if from/to both exist in new nodes
  // Otherwise fall back to generated chain edges
  let edges: Edge[];
  if (Array.isArray(flow.edges) && flow.edges.length > 0) {
    const validEdges = filterValidEdges(flow.edges, nodeIds);
    edges = validEdges.length > 0 ? validEdges : dag.edges.map(toEdge);
  } else {
    edges = dag.edges.map(toEdge);
  }

  return {
    ...flow,
    nodes,
    edges,
  };
}

export interface PublishedFlowInfo {
  id: string;
  slug: string; // for tool name `flow.<slug>`
  version: number;
  name: string;
  description?: string;
}

/**
 * Check if a flow needs normalization (missing nodes when steps exist).
 */
function needsNormalization(flow: Flow): boolean {
  const hasSteps = Array.isArray(flow.steps) && flow.steps.length > 0;
  const hasNodes = Array.isArray(flow.nodes) && flow.nodes.length > 0;
  return hasSteps && !hasNodes;
}

/**
 * Lazy normalize a flow if needed, and persist the normalized version.
 * This handles legacy flows that only have steps but no nodes.
 * After normalization, steps field is stripped before persist AND return.
 */
async function lazyNormalize(flow: Flow): Promise<Flow> {
  if (!needsNormalization(flow)) {
    return stripStepsForSave(flow);
  }
  // Normalize and save back to storage (strip steps before persist)
  const normalized = normalizeFlowForSave(flow);
  const cleanFlow = stripStepsForSave(normalized);
  try {
    await IndexedDbStorage.flows.save(cleanFlow);
  } catch (e) {
    console.warn('lazyNormalize: failed to save normalized flow', e);
  }
  // Return DAG-only flow (do not leak deprecated steps to callers)
  return cleanFlow;
}

export async function listFlows(): Promise<Flow[]> {
  await ensureMigratedFromLocal();
  const flows = await IndexedDbStorage.flows.list();
  // Check if any flows need normalization
  const needsNorm = flows.some(needsNormalization);
  if (!needsNorm) {
    // Strip steps from all flows before returning
    return flows.map(stripStepsForSave);
  }
  // Normalize flows that need it (in parallel)
  // lazyNormalize already returns DAG-only flow
  const normalized = await Promise.all(
    flows.map(async (flow) => {
      if (needsNormalization(flow)) {
        return lazyNormalize(flow);
      }
      return stripStepsForSave(flow);
    }),
  );
  return normalized;
}

export async function getFlow(flowId: string): Promise<Flow | undefined> {
  await ensureMigratedFromLocal();
  const flow = await IndexedDbStorage.flows.get(flowId);
  if (!flow) return undefined;
  // Lazy normalize if needed (lazyNormalize returns DAG-only)
  if (needsNormalization(flow)) {
    return lazyNormalize(flow);
  }
  // Strip steps before returning
  return stripStepsForSave(flow);
}

export async function saveFlow(flow: Flow, options?: { notify?: boolean }): Promise<void> {
  await ensureMigratedFromLocal();
  // 1. Normalize: generate nodes/edges from steps if missing
  // 2. Strip: remove deprecated steps field before persist
  const normalizedFlow = normalizeFlowForSave(flow);
  const cleanFlow = stripStepsForSave(normalizedFlow);
  await IndexedDbStorage.flows.save(cleanFlow);
  // Notify UI by default, can be disabled for batch operations
  if (options?.notify !== false) {
    notifyFlowsChanged();
  }
}

export async function deleteFlow(flowId: string): Promise<void> {
  await ensureMigratedFromLocal();
  await IndexedDbStorage.flows.delete(flowId);
  notifyFlowsChanged();
}

export async function listRuns(): Promise<RunRecord[]> {
  await ensureMigratedFromLocal();
  return await IndexedDbStorage.runs.list();
}

export async function appendRun(record: RunRecord): Promise<void> {
  await ensureMigratedFromLocal();
  const runs = await IndexedDbStorage.runs.list();
  runs.push(record);
  // Trim to keep last 10 runs per flowId to avoid unbounded growth
  try {
    const byFlow = new Map<string, RunRecord[]>();
    for (const r of runs) {
      const list = byFlow.get(r.flowId) || [];
      list.push(r);
      byFlow.set(r.flowId, list);
    }
    const merged: RunRecord[] = [];
    for (const [, arr] of byFlow.entries()) {
      arr.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
      const last = arr.slice(Math.max(0, arr.length - 10));
      merged.push(...last);
    }
    await IndexedDbStorage.runs.replaceAll(merged);
  } catch (e) {
    console.warn('appendRun: trim failed, saving all', e);
    await IndexedDbStorage.runs.replaceAll(runs);
  }
}

export async function listPublished(): Promise<PublishedFlowInfo[]> {
  await ensureMigratedFromLocal();
  return await IndexedDbStorage.published.list();
}

export async function publishFlow(flow: Flow, slug?: string): Promise<PublishedFlowInfo> {
  await ensureMigratedFromLocal();
  const info: PublishedFlowInfo = {
    id: flow.id,
    slug: slug || toSlug(flow.name) || flow.id,
    version: flow.version,
    name: flow.name,
    description: flow.description,
  };
  await IndexedDbStorage.published.save(info);
  return info;
}

export async function unpublishFlow(flowId: string): Promise<void> {
  await ensureMigratedFromLocal();
  await IndexedDbStorage.published.delete(flowId);
}

export function toSlug(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 64);
}

export async function exportFlow(flowId: string): Promise<string> {
  const flow = await getFlow(flowId);
  if (!flow) throw new Error('flow not found');
  return JSON.stringify(flow, null, 2);
}

export async function exportAllFlows(): Promise<string> {
  const flows = await listFlows();
  return JSON.stringify({ flows }, null, 2);
}

/**
 * Import flows from JSON string.
 *
 * Supported formats:
 * 1. Array of flows: [...flows]
 * 2. Object with flows array: { flows: [...] }
 * 3. Single flow with steps: { id, steps: [...] }
 * 4. Single flow with nodes (new format): { id, nodes: [...], edges?: [...] }
 *
 * Flows are normalized on save (steps → nodes if needed).
 */
export async function importFlowFromJson(json: string): Promise<Flow[]> {
  await ensureMigratedFromLocal();
  const parsed = JSON.parse(json);

  // Detect candidates from various formats
  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.flows)
      ? parsed.flows
      : parsed?.id && (Array.isArray(parsed?.steps) || Array.isArray(parsed?.nodes))
        ? [parsed]
        : [];

  if (!candidates.length) {
    throw new Error('invalid flow json: no flows found');
  }

  const nowIso = new Date().toISOString();
  const flowsToImport: Flow[] = [];

  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('invalid flow json: flow must be an object');
    }

    const f = raw as Record<string, unknown>;
    const id = String(f.id || '').trim();
    if (!id) {
      throw new Error('invalid flow json: missing id');
    }

    // Normalize fields with sensible defaults
    const name = typeof f.name === 'string' && f.name.trim() ? f.name : id;
    const version = Number.isFinite(Number(f.version)) ? Number(f.version) : 1;

    // Handle meta with proper timestamps
    const existingMeta =
      f.meta && typeof f.meta === 'object' ? (f.meta as Record<string, unknown>) : {};
    const createdAt = typeof existingMeta.createdAt === 'string' ? existingMeta.createdAt : nowIso;

    // Build flow object - preserve steps only if present (for normalize)
    // saveFlow() will normalize (steps→nodes) then strip steps before persist
    const flow: Flow = {
      ...(f as object),
      id,
      name,
      version,
      meta: {
        ...existingMeta,
        createdAt,
        updatedAt: nowIso,
      },
    } as Flow;

    // Preserve steps for normalization if present in import data
    if (Array.isArray(f.steps) && f.steps.length > 0) {
      flow.steps = f.steps as Flow['steps'];
    }

    flowsToImport.push(flow);
  }

  // Save all flows (normalize on save)
  // Disable individual notifications to avoid flooding UI during batch import
  for (const f of flowsToImport) {
    await saveFlow(f, { notify: false });
  }

  // Send single notification after all flows are imported
  notifyFlowsChanged();

  return flowsToImport;
}

// Scheduling support
export type ScheduleType = 'once' | 'interval' | 'daily';
export interface FlowSchedule {
  id: string; // schedule id
  flowId: string;
  type: ScheduleType;
  enabled: boolean;
  // when: ISO string for 'once'; HH:mm for 'daily'; minutes for 'interval'
  when: string;
  // optional variables to pass when running
  args?: Record<string, any>;
}

export async function listSchedules(): Promise<FlowSchedule[]> {
  await ensureMigratedFromLocal();
  return await IndexedDbStorage.schedules.list();
}

export async function saveSchedule(s: FlowSchedule): Promise<void> {
  await ensureMigratedFromLocal();
  await IndexedDbStorage.schedules.save(s);
}

export async function removeSchedule(scheduleId: string): Promise<void> {
  await ensureMigratedFromLocal();
  await IndexedDbStorage.schedules.delete(scheduleId);
}
