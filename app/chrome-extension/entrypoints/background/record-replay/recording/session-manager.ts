import type { Edge, Flow, NodeBase, Step, VariableDef } from '../types';
import { BACKGROUND_MESSAGE_TYPES, TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { NODE_TYPES } from '@/common/node-types';
import { mapStepToNodeConfig, stepsToDAG, EDGE_LABELS } from 'webpage-mcp-shared';

/**
 * Recording status state machine:
 * - idle: No active recording
 * - recording: Actively capturing user interactions
 * - paused: Temporarily paused (UI can resume)
 * - stopping: Draining final steps from content scripts before save
 */
export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'stopping';
export const MAX_RECORDING_ACTIVE_TABS = 128;

export type RecordingLimitReason =
  | 'node_count'
  | 'payload_bytes'
  | 'variable_count'
  | 'duration'
  | 'step_rate';

export interface RecordingSessionLimits {
  maxNodes: number;
  maxPayloadBytes: number;
  maxVariables: number;
  maxDurationMs: number;
  maxStepsPerSecond: number;
  timelineWindow: number;
}

export interface RecordingMutationResult {
  accepted: number;
  truncated: boolean;
  reason?: RecordingLimitReason;
}

export const DEFAULT_RECORDING_SESSION_LIMITS: Readonly<RecordingSessionLimits> = Object.freeze({
  maxNodes: 5_000,
  maxPayloadBytes: 16 * 1024 * 1024,
  maxVariables: 256,
  maxDurationMs: 4 * 60 * 60 * 1_000,
  maxStepsPerSecond: 1_000,
  timelineWindow: 30,
});

export interface RecordingSessionState {
  sessionId: string;
  status: RecordingStatus;
  originTabId: number | null;
  flow: Flow | null;
  // Track tabs that have participated in this recording session
  activeTabs: Set<number>;
  // Track which tabs have acknowledged stop command
  stoppedTabs: Set<number>;
}

// Valid node types for type checking
const VALID_NODE_TYPES = new Set<string>(Object.values(NODE_TYPES));

export class RecordingSessionManager {
  private readonly limits: RecordingSessionLimits;
  private state: RecordingSessionState = {
    sessionId: '',
    status: 'idle',
    originTabId: null,
    flow: null,
    activeTabs: new Set<number>(),
    stoppedTabs: new Set<number>(),
  };

  // Session-level cache for incremental DAG sync (cleared on session start/stop)
  // Note: stepIndexMap removed - we no longer write to flow.steps
  private nodeIndexMap: Map<string, number> = new Map();
  private nodeBytesById: Map<string, number> = new Map();
  private variableBytesByKey: Map<string, number> = new Map();
  // Monotonic counter for edge id generation (avoids collision on delete/reorder)
  private edgeSeq: number = 0;
  private aggregatePayloadBytes = 0;
  private edgePayloadBytes = 0;
  private recordingStartedAtMs = 0;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private rateWindowStartedAtMs = 0;
  private rateWindowStepCount = 0;
  private limitReached: RecordingLimitReason | null = null;
  private automaticStopRequested = false;
  private limitHandler: ((reason: RecordingLimitReason) => void) | null = null;

  constructor(limits: Partial<RecordingSessionLimits> = {}) {
    this.limits = {
      maxNodes: this.normalizeLimit(limits.maxNodes, DEFAULT_RECORDING_SESSION_LIMITS.maxNodes),
      maxPayloadBytes: this.normalizeLimit(
        limits.maxPayloadBytes,
        DEFAULT_RECORDING_SESSION_LIMITS.maxPayloadBytes,
      ),
      maxVariables: this.normalizeLimit(
        limits.maxVariables,
        DEFAULT_RECORDING_SESSION_LIMITS.maxVariables,
      ),
      maxDurationMs: this.normalizeLimit(
        limits.maxDurationMs,
        DEFAULT_RECORDING_SESSION_LIMITS.maxDurationMs,
      ),
      maxStepsPerSecond: this.normalizeLimit(
        limits.maxStepsPerSecond,
        DEFAULT_RECORDING_SESSION_LIMITS.maxStepsPerSecond,
      ),
      timelineWindow: this.normalizeLimit(
        limits.timelineWindow,
        DEFAULT_RECORDING_SESSION_LIMITS.timelineWindow,
      ),
    };
  }

  getStatus(): RecordingStatus {
    return this.state.status;
  }

  getSession(): Readonly<RecordingSessionState> {
    return this.state;
  }

  getFlow(): Flow | null {
    return this.state.flow;
  }

  getOriginTabId(): number | null {
    return this.state.originTabId;
  }

  addActiveTab(tabId: number): boolean {
    if (!Number.isInteger(tabId) || tabId < 0) return false;
    if (this.state.activeTabs.has(tabId)) return true;
    if (this.state.activeTabs.size >= MAX_RECORDING_ACTIVE_TABS) return false;
    this.state.activeTabs.add(tabId);
    return true;
  }

  removeActiveTab(tabId: number): void {
    this.state.activeTabs.delete(tabId);
  }

  getActiveTabs(): number[] {
    return Array.from(this.state.activeTabs);
  }

  hasActiveTab(tabId: number): boolean {
    return Number.isInteger(tabId) && tabId >= 0 && this.state.activeTabs.has(tabId);
  }

  getBudgetState(): Readonly<{
    payloadBytes: number;
    limitReached: RecordingLimitReason | null;
  }> {
    return {
      payloadBytes: this.aggregatePayloadBytes,
      limitReached: this.limitReached,
    };
  }

  setLimitHandler(handler: ((reason: RecordingLimitReason) => void) | null): void {
    this.limitHandler = handler;
  }

  async startSession(flow: Flow, originTabId: number): Promise<void> {
    // Clear cache for fresh session
    this.nodeIndexMap.clear();
    this.nodeBytesById.clear();
    this.variableBytesByKey.clear();
    this.edgeSeq = 0;
    this.aggregatePayloadBytes = 0;
    this.edgePayloadBytes = 0;
    this.recordingStartedAtMs = Date.now();
    if (this.durationTimer) clearTimeout(this.durationTimer);
    const expectedSessionId = `sess_${this.recordingStartedAtMs}`;
    this.durationTimer = setTimeout(() => {
      if (
        this.state.sessionId === expectedSessionId &&
        this.state.status !== 'idle' &&
        !this.limitReached
      ) {
        this.reachLimit('duration', this.limits.maxDurationMs, 0);
      }
    }, this.limits.maxDurationMs);
    this.rateWindowStartedAtMs = this.recordingStartedAtMs;
    this.rateWindowStepCount = 0;
    this.limitReached = null;
    this.automaticStopRequested = false;

    this.state = {
      sessionId: expectedSessionId,
      status: 'recording',
      originTabId,
      flow,
      activeTabs: new Set<number>([originTabId]),
      stoppedTabs: new Set<number>(),
    };

    // Initialize caches from existing flow data (supports resume scenarios)
    this.rebuildCaches();
    this.rebuildBudgetAccounting();
    try {
      this.assertInitialFlowWithinBudget();
    } catch (error) {
      await this.stopSession();
      throw error;
    }
  }

  /**
   * Transition to stopping state. Content scripts can still send final steps.
   * Returns the sessionId for barrier verification.
   */
  beginStopping(): string {
    if (this.state.status === 'idle') return '';
    this.state.status = 'stopping';
    this.state.stoppedTabs.clear();
    return this.state.sessionId;
  }

  /**
   * Mark a tab as having acknowledged the stop command.
   * Returns true if all active tabs have stopped.
   */
  markTabStopped(tabId: number): boolean {
    this.state.stoppedTabs.add(tabId);
    // Check if all active tabs have acknowledged
    for (const activeTabId of this.state.activeTabs) {
      if (!this.state.stoppedTabs.has(activeTabId)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if we're in stopping state (still accepting final steps).
   */
  isStopping(): boolean {
    return this.state.status === 'stopping';
  }

  /**
   * Check if we can accept steps (recording or stopping).
   */
  canAcceptSteps(): boolean {
    return (
      !this.limitReached &&
      (this.state.status === 'recording' || this.state.status === 'stopping')
    );
  }

  /**
   * Transition to paused state.
   */
  pause(): void {
    if (this.state.status === 'recording') {
      this.state.status = 'paused';
    }
  }

  /**
   * Resume from paused state.
   */
  resume(): void {
    if (this.state.status === 'paused') {
      this.state.status = 'recording';
    }
  }

  /**
   * Finalize stop and clear session state.
   */
  async stopSession(): Promise<Flow | null> {
    const flow = this.state.flow;
    this.state.status = 'idle';
    this.state.flow = null;
    this.state.originTabId = null;
    this.state.activeTabs.clear();
    this.state.stoppedTabs.clear();
    // Clear cache
    this.nodeIndexMap.clear();
    this.nodeBytesById.clear();
    this.variableBytesByKey.clear();
    this.edgeSeq = 0;
    this.aggregatePayloadBytes = 0;
    this.edgePayloadBytes = 0;
    this.recordingStartedAtMs = 0;
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = null;
    this.rateWindowStartedAtMs = 0;
    this.rateWindowStepCount = 0;
    this.limitReached = null;
    this.automaticStopRequested = false;
    return flow;
  }

  updateFlow(mutator: (f: Flow) => void): void {
    const f = this.state.flow;
    if (!f) return;
    mutator(f);
    try {
      (f.meta as any).updatedAt = new Date().toISOString();
    } catch (e) {
      // ignore meta update errors
    }
  }

  /**
   * Append or upsert steps to the flow with incremental DAG sync.
   * Uses upsert semantics: if a step with the same id exists, update it in place.
   * This ensures fill steps get their final value even after initial flush.
   *
   * DAG sync: maintains flow.nodes/edges during recording.
   * - New step → create node + edge from previous node
   * - Upsert step → update node.config and node.type
   * - Invariant violation → fallback to linear DAG rebuild
   *
   * Note: flow.steps is no longer written. Nodes are the source of truth.
   */
  appendSteps(steps: Step[]): RecordingMutationResult {
    const f = this.state.flow;
    if (!f || !Array.isArray(steps) || steps.length === 0) {
      return { accepted: 0, truncated: false };
    }
    if (this.limitReached) {
      return { accepted: 0, truncated: true, reason: this.limitReached };
    }
    if (this.isDurationExceeded()) {
      return this.reachLimit('duration', this.limits.maxDurationMs, 0);
    }
    if (!this.reserveStepRate(steps.length)) {
      return this.reachLimit('step_rate', this.limits.maxStepsPerSecond, 0);
    }

    // Initialize arrays if missing and refresh the fixed JSON envelope cost.
    const initializedArrays = !Array.isArray(f.nodes) || !Array.isArray(f.edges);
    if (!Array.isArray(f.nodes)) f.nodes = [];
    if (!Array.isArray(f.edges)) f.edges = [];
    if (initializedArrays) this.rebuildBudgetAccounting();

    // Legacy compatibility: if flow only has steps, initialize DAG from them once
    if (f.nodes.length === 0 && Array.isArray(f.steps) && f.steps.length > 0) {
      this.rebuildDagFromSteps();
      if (f.nodes.length > this.limits.maxNodes) {
        return this.reachLimit('node_count', this.limits.maxNodes, 0);
      }
      if (this.aggregatePayloadBytes > this.limits.maxPayloadBytes) {
        return this.reachLimit('payload_bytes', this.limits.maxPayloadBytes, 0);
      }
    }

    const nodes = f.nodes;
    const edges = f.edges;

    // Check invariants: edges must match linear chain
    // If violated (e.g., imported flow, manual edit), rebuild linear chain
    if (!this.checkDagInvariant(nodes, edges)) {
      this.rechainEdges();
    }

    // Process each incoming step with upsert semantics + incremental DAG sync
    let needsRebuild = false;
    let accepted = 0;
    for (const step of steps) {
      // Ensure step has an id
      if (!step.id) {
        step.id = `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      }

      const nodeIdx = this.nodeIndexMap.get(step.id);
      if (nodeIdx !== undefined) {
        // Upsert: update existing node in place
        if (!nodes[nodeIdx]) {
          needsRebuild = true;
          continue;
        }
        const updatedNode: NodeBase = {
          ...nodes[nodeIdx],
          type: this.toNodeType(step.type),
          config: mapStepToNodeConfig(step),
        };
        const previousBytes = this.nodeBytesById.get(step.id) ?? this.jsonUtf8Bytes(nodes[nodeIdx]);
        const updatedBytes = this.jsonUtf8Bytes(updatedNode);
        const projectedBytes = this.aggregatePayloadBytes - previousBytes + updatedBytes;
        if (projectedBytes > this.limits.maxPayloadBytes) {
          this.reachLimit('payload_bytes', this.limits.maxPayloadBytes, accepted);
          break;
        }
        nodes[nodeIdx] = updatedNode;
        this.nodeBytesById.set(step.id, updatedBytes);
        this.aggregatePayloadBytes = projectedBytes;
        accepted += 1;
      } else {
        // Append: new node
        if (nodes.length >= this.limits.maxNodes) {
          this.reachLimit('node_count', this.limits.maxNodes, accepted);
          break;
        }
        const prevNodeId = nodes.length > 0 ? nodes[nodes.length - 1]?.id : undefined;

        // Create corresponding node
        const newNode: NodeBase = {
          id: step.id,
          type: this.toNodeType(step.type),
          config: mapStepToNodeConfig(step),
        };
        const nodeBytes = this.jsonUtf8Bytes(newNode);
        let newEdge: Edge | null = null;
        let edgeBytes = 0;
        if (prevNodeId) {
          newEdge = {
            id: `e_${this.edgeSeq}_${prevNodeId}_${step.id}`,
            from: prevNodeId,
            to: step.id,
            label: EDGE_LABELS.DEFAULT,
          };
          edgeBytes = this.jsonUtf8Bytes(newEdge);
        }
        const nodeSeparatorBytes = nodes.length > 0 ? 1 : 0;
        const edgeSeparatorBytes = edges.length > 0 && newEdge ? 1 : 0;
        const projectedBytes =
          this.aggregatePayloadBytes +
          nodeBytes +
          nodeSeparatorBytes +
          edgeBytes +
          edgeSeparatorBytes;
        if (projectedBytes > this.limits.maxPayloadBytes) {
          this.reachLimit('payload_bytes', this.limits.maxPayloadBytes, accepted);
          break;
        }

        nodes.push(newNode);
        this.nodeIndexMap.set(step.id, nodes.length - 1);
        this.nodeBytesById.set(step.id, nodeBytes);
        this.aggregatePayloadBytes = projectedBytes;
        accepted += 1;

        // Create edge from previous node (if exists)
        if (prevNodeId && newEdge) {
          if (!this.nodeIndexMap.has(prevNodeId)) {
            needsRebuild = true;
            continue;
          }
          edges.push(newEdge);
          this.edgeSeq += 1;
          this.edgePayloadBytes += edgeBytes;
        }
      }
    }

    // Final invariant check: if any inconsistency detected, rebuild edges
    if (needsRebuild || !this.checkDagInvariant(nodes, edges)) {
      this.rechainEdges();
    }

    // Update meta timestamp
    try {
      if (f.meta) {
        f.meta.updatedAt = new Date().toISOString();
      }
    } catch {
      // ignore meta update errors
    }

    if (accepted > 0) this.broadcastTimelineUpdate();
    return {
      accepted,
      truncated: this.limitReached !== null,
      ...(this.limitReached ? { reason: this.limitReached } : {}),
    };
  }

  /**
   * Convert step type to valid NodeType with fallback to SCRIPT.
   * Logs a warning for unknown types to help detect upstream type drift.
   */
  private toNodeType(stepType: string): NodeBase['type'] {
    if (VALID_NODE_TYPES.has(stepType)) {
      return stepType as NodeBase['type'];
    }
    console.warn(`[RecordingSession] Unknown step type "${stepType}", falling back to "script"`);
    return NODE_TYPES.SCRIPT;
  }

  /**
   * Check DAG invariant for linear recording:
   * - edges.length === max(0, nodes.length - 1)
   * - Last edge (if exists) points to the last node
   */
  private checkDagInvariant(nodes: NodeBase[], edges: Edge[]): boolean {
    const nodeCount = nodes.length;
    const expectedEdgeCount = Math.max(0, nodeCount - 1);

    // Check edge count matches expected linear chain
    if (edges.length !== expectedEdgeCount) {
      return false;
    }

    // Check last edge points to last node (if edges exist)
    if (edges.length > 0 && nodes.length > 0) {
      const lastEdge = edges[edges.length - 1];
      const lastNodeId = nodes[nodes.length - 1]?.id;
      if (lastEdge.to !== lastNodeId) {
        return false;
      }
    }

    return true;
  }

  /**
   * Rebuild caches from current flow state.
   * Called on session start and after DAG rebuild.
   */
  private rebuildCaches(): void {
    const f = this.state.flow;
    if (!f) return;

    this.nodeIndexMap.clear();

    if (Array.isArray(f.nodes)) {
      for (let i = 0; i < f.nodes.length; i++) {
        const id = f.nodes[i]?.id;
        if (id) this.nodeIndexMap.set(id, i);
      }
    }

    // Sync edgeSeq to continue from current edge count (avoids id collision)
    this.edgeSeq = Array.isArray(f.edges) ? f.edges.length : 0;
  }

  /**
   * Full DAG rebuild from legacy steps.
   * Used when flow only has steps[] but no nodes[].
   */
  private rebuildDagFromSteps(): void {
    const f = this.state.flow;
    if (!f || !Array.isArray(f.steps) || f.steps.length === 0) return;

    const dag = stepsToDAG(f.steps);

    // Clear and repopulate nodes
    if (!Array.isArray(f.nodes)) f.nodes = [];
    f.nodes.length = 0;
    for (const n of dag.nodes) {
      f.nodes.push({
        id: n.id,
        type: this.toNodeType(n.type),
        config: n.config,
      });
    }

    // Clear and repopulate edges
    if (!Array.isArray(f.edges)) f.edges = [];
    f.edges.length = 0;
    for (const e of dag.edges) {
      f.edges.push({
        id: e.id,
        from: e.from,
        to: e.to,
        label: e.label,
      });
    }

    // Rebuild caches
    this.rebuildCaches();
    this.rebuildBudgetAccounting();
  }

  /**
   * Re-chain edges linearly according to current nodes order.
   * Used when edge invariant is violated but nodes exist.
   */
  private rechainEdges(): void {
    const f = this.state.flow;
    if (!f) return;

    if (!Array.isArray(f.nodes)) f.nodes = [];
    if (!Array.isArray(f.edges)) f.edges = [];

    // Clear and re-chain edges
    f.edges.length = 0;
    for (let i = 0; i < f.nodes.length - 1; i++) {
      const from = f.nodes[i].id;
      const to = f.nodes[i + 1].id;
      f.edges.push({
        id: `e_${i}_${from}_${to}`,
        from,
        to,
        label: EDGE_LABELS.DEFAULT,
      });
    }

    // Rebuild caches
    this.rebuildCaches();
    this.rebuildBudgetAccounting();
  }

  /**
   * Append variables to the flow. Deduplicates by key.
   */
  appendVariables(variables: VariableDef[]): RecordingMutationResult {
    const f = this.state.flow;
    if (!f || !Array.isArray(variables) || variables.length === 0) {
      return { accepted: 0, truncated: false };
    }
    if (this.limitReached) {
      return { accepted: 0, truncated: true, reason: this.limitReached };
    }
    if (this.isDurationExceeded()) {
      return this.reachLimit('duration', this.limits.maxDurationMs, 0);
    }

    if (!f.variables) {
      f.variables = [];
      this.rebuildBudgetAccounting();
    }

    // Deduplicate by key - newer definitions override older ones
    const existingKeys = new Set(f.variables.map((v) => v.key));
    let accepted = 0;
    for (const v of variables) {
      if (!v.key) continue;
      if (existingKeys.has(v.key)) {
        // Update existing variable
        const idx = f.variables.findIndex((fv) => fv.key === v.key);
        if (idx >= 0) {
          const previousBytes =
            this.variableBytesByKey.get(v.key) ?? this.jsonUtf8Bytes(f.variables[idx]);
          const updatedBytes = this.jsonUtf8Bytes(v);
          const projectedBytes = this.aggregatePayloadBytes - previousBytes + updatedBytes;
          if (projectedBytes > this.limits.maxPayloadBytes) {
            this.reachLimit('payload_bytes', this.limits.maxPayloadBytes, accepted);
            break;
          }
          f.variables[idx] = v;
          this.variableBytesByKey.set(v.key, updatedBytes);
          this.aggregatePayloadBytes = projectedBytes;
          accepted += 1;
        }
      } else {
        if (f.variables.length >= this.limits.maxVariables) {
          this.reachLimit('variable_count', this.limits.maxVariables, accepted);
          break;
        }
        const variableBytes = this.jsonUtf8Bytes(v);
        const separatorBytes = f.variables.length > 0 ? 1 : 0;
        if (
          this.aggregatePayloadBytes + variableBytes + separatorBytes >
          this.limits.maxPayloadBytes
        ) {
          this.reachLimit('payload_bytes', this.limits.maxPayloadBytes, accepted);
          break;
        }
        f.variables.push(v);
        existingKeys.add(v.key);
        this.variableBytesByKey.set(v.key, variableBytes);
        this.aggregatePayloadBytes += variableBytes + separatorBytes;
        accepted += 1;
      }
    }

    // Update meta timestamp
    try {
      if (f.meta) {
        f.meta.updatedAt = new Date().toISOString();
      }
    } catch {
      // ignore meta update errors
    }
    return {
      accepted,
      truncated: this.limitReached !== null,
      ...(this.limitReached ? { reason: this.limitReached } : {}),
    };
  }

  private normalizeLimit(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.max(1, Math.floor(value))
      : fallback;
  }

  private jsonUtf8Bytes(value: unknown): number {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
      return this.limits.maxPayloadBytes + 1;
    }
  }

  private rebuildBudgetAccounting(): void {
    const flow = this.state.flow;
    this.nodeBytesById.clear();
    this.variableBytesByKey.clear();
    this.edgePayloadBytes = 0;
    this.aggregatePayloadBytes = 0;
    if (!flow) return;

    for (const node of Array.isArray(flow.nodes) ? flow.nodes : []) {
      const bytes = this.jsonUtf8Bytes(node);
      this.nodeBytesById.set(node.id, bytes);
    }
    for (const edge of Array.isArray(flow.edges) ? flow.edges : []) {
      const bytes = this.jsonUtf8Bytes(edge);
      this.edgePayloadBytes += bytes;
    }
    for (const variable of Array.isArray(flow.variables) ? flow.variables : []) {
      const bytes = this.jsonUtf8Bytes(variable);
      this.variableBytesByKey.set(variable.key, bytes);
    }
    // This is the exact serialized flow size at rebuild points. Incremental
    // mutations below adjust it by their exact JSON element delta, including
    // array separators, so repeated appends never stringify the whole flow.
    this.aggregatePayloadBytes = this.jsonUtf8Bytes(flow);
  }

  private assertInitialFlowWithinBudget(): void {
    const flow = this.state.flow;
    if (!flow) return;
    const nodeCount = Array.isArray(flow.nodes)
      ? flow.nodes.length
      : Array.isArray(flow.steps)
        ? flow.steps.length
        : 0;
    if (nodeCount > this.limits.maxNodes) {
      throw new Error(`recording flow exceeds the ${this.limits.maxNodes}-node limit`);
    }
    if ((flow.variables?.length ?? 0) > this.limits.maxVariables) {
      throw new Error(`recording flow exceeds the ${this.limits.maxVariables}-variable limit`);
    }
    if (this.aggregatePayloadBytes > this.limits.maxPayloadBytes) {
      throw new Error(
        `recording flow exceeds the ${this.limits.maxPayloadBytes}-byte payload limit`,
      );
    }
  }

  private isDurationExceeded(now = Date.now()): boolean {
    return (
      this.recordingStartedAtMs > 0 && now - this.recordingStartedAtMs > this.limits.maxDurationMs
    );
  }

  private reserveStepRate(count: number, now = Date.now()): boolean {
    if (
      this.rateWindowStartedAtMs <= 0 ||
      now < this.rateWindowStartedAtMs ||
      now - this.rateWindowStartedAtMs >= 1_000
    ) {
      this.rateWindowStartedAtMs = now;
      this.rateWindowStepCount = 0;
    }
    if (this.rateWindowStepCount + count > this.limits.maxStepsPerSecond) return false;
    this.rateWindowStepCount += count;
    return true;
  }

  private reachLimit(
    reason: RecordingLimitReason,
    limit: number,
    accepted: number,
  ): RecordingMutationResult {
    if (!this.limitReached) {
      this.limitReached = reason;
      const flow = this.state.flow;
      if (flow) {
        const now = new Date().toISOString();
        if (!flow.meta) flow.meta = { createdAt: now, updatedAt: now };
        flow.meta.updatedAt = now;
        flow.meta.recording = {
          ...(flow.meta.recording ?? {}),
          truncated: true,
          truncationReason: reason,
          truncatedAt: now,
          truncationLimit: limit,
        };
      }

      if (!this.automaticStopRequested) {
        this.automaticStopRequested = true;
        if (this.limitHandler) {
          const handler = this.limitHandler;
          queueMicrotask(() => handler(reason));
        } else {
          try {
            void chrome.runtime
              .sendMessage({
                type: BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING,
                reason: `recording_limit:${reason}`,
              })
              .catch(() => {});
          } catch {
            // The current mutation remains blocked even if the stop notification
            // cannot be delivered during service-worker teardown.
          }
        }
      }
    }
    return { accepted, truncated: true, reason: this.limitReached ?? reason };
  }

  /**
   * Derive timeline steps from nodes for UI broadcast.
   * This keeps protocol compatibility with recorder.js without storing steps.
   */
  private getTimelineSnapshot(): { steps: Step[]; totalSteps: number } {
    const f = this.state.flow;
    if (!f) return { steps: [], totalSteps: 0 };

    // Primary: derive from nodes
    if (Array.isArray(f.nodes) && f.nodes.length > 0) {
      const totalSteps = f.nodes.length;
      const recentNodes = f.nodes.slice(Math.max(0, totalSteps - this.limits.timelineWindow));
      const steps = recentNodes.map((n) => {
        const cfg =
          n && typeof n.config === 'object' && n.config != null
            ? (n.config as Record<string, unknown>)
            : {};
        // Important: id and type must override any values in config
        // (config may contain 'type' for trigger nodes, etc.)
        return { ...cfg, id: n.id, type: n.type } as Step;
      });
      return { steps, totalSteps };
    }

    // Legacy fallback: use steps if no nodes (shouldn't happen in normal recording)
    if (Array.isArray(f.steps) && f.steps.length > 0) {
      return {
        steps: f.steps.slice(Math.max(0, f.steps.length - this.limits.timelineWindow)),
        totalSteps: f.steps.length,
      };
    }

    return { steps: [], totalSteps: 0 };
  }

  // Broadcast timeline updates to relevant tabs (top-frame only)
  broadcastTimelineUpdate(): void {
    try {
      const { steps, totalSteps } = this.getTimelineSnapshot();
      if (steps.length === 0) return;

      // Prefer broadcasting to all tabs that participated in this session, so timeline
      // stays consistent when user switches across tabs/windows during a single session.
      const targets = this.getActiveTabs();
      const list =
        targets && targets.length
          ? targets
          : this.state.originTabId != null
            ? [this.state.originTabId]
            : [];
      for (const tabId of list) {
        chrome.tabs.sendMessage(
          tabId,
          { action: TOOL_MESSAGE_TYPES.RR_TIMELINE_UPDATE, steps, totalSteps },
          { frameId: 0 },
        );
      }

      // Also broadcast to extension pages (popup/sidepanel) for recording UI sync.
      void chrome.runtime
        .sendMessage({
          type: TOOL_MESSAGE_TYPES.RR_TIMELINE_UPDATE,
          payload: { steps, totalSteps },
          steps,
          totalSteps,
        })
        .catch(() => {
          // Ignore no-listener errors when popup/sidepanel are closed.
        });
    } catch {}
  }
}

// Singleton for wiring convenience
export const recordingSession = new RecordingSessionManager();
