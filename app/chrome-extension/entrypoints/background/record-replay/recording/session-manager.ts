import type { Edge, Flow, NodeBase, Step, VariableDef } from "../types";
import {
  BACKGROUND_MESSAGE_TYPES,
  TOOL_MESSAGE_TYPES,
} from "@/common/message-types";
import { NODE_TYPES } from "@/common/node-types";
import {
  mapStepToNodeConfig,
  stepsToDAG,
  EDGE_LABELS,
} from "webpage-mcp-shared";
import {
  RECORDING_RECOVERY_VERSION,
  browserRecordingRecoveryStore,
  type RecordingRecoveryCheckpoint,
  type RecordingRecoveryIngestState,
  type RecordingRecoveryStore,
} from "./recording-recovery-store";

/**
 * Recording status state machine:
 * - idle: No active recording
 * - recording: Actively capturing user interactions
 * - paused: Temporarily paused (UI can resume)
 * - stopping: Draining final steps from content scripts before save
 */
export type RecordingStatus = "idle" | "recording" | "paused" | "stopping";
export const MAX_RECORDING_ACTIVE_TABS = 128;
export const RECORDING_RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000;

const MAX_RECOVERY_SOURCES = 200;
const MAX_RECOVERY_PENDING_FRAME_STEPS = 128;
const MAX_RECOVERY_LAST_STEP_TABS = MAX_RECORDING_ACTIVE_TABS;
const MAX_RECOVERY_INGEST_BYTES = 3 * 1024 * 1024;
const STOP_RECOVERY_RETRY_BASE_MS = 60_000;
const STOP_RECOVERY_RETRY_MAX_MS = 60 * 60_000;
const STOP_RECOVERY_FINALIZATION_OVERHEAD_BYTES = 512 * 1024;

export type RecordingLimitReason =
  | "node_count"
  | "payload_bytes"
  | "variable_count"
  | "duration"
  | "step_rate";

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

export const DEFAULT_RECORDING_SESSION_LIMITS: Readonly<RecordingSessionLimits> =
  Object.freeze({
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
  private readonly recoveryStore: RecordingRecoveryStore | null;
  private state: RecordingSessionState = {
    sessionId: "",
    status: "idle",
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
  private stopRetryCount = 0;
  private limitReached: RecordingLimitReason | null = null;
  private automaticStopRequested = false;
  private limitHandler: ((reason: RecordingLimitReason) => void) | null = null;
  private activeTabDocuments = new Map<number, string>();
  private recoveryIngestState: RecordingRecoveryIngestState = {
    sessionId: "",
    sources: [],
    pendingFrameSteps: [],
    lastStepByTab: [],
  };
  private recoveryRevision = 0;
  private recoveryCreatedAt = 0;
  private recoveryExpiresAt = 0;
  private recoveryInitPromise: Promise<void> | null = null;
  private recoveryReady = false;
  private recoveryError: Error | null = null;
  private recoveredSession = false;
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(
    limits: Partial<RecordingSessionLimits> = {},
    recoveryStore: RecordingRecoveryStore | null = null,
  ) {
    this.recoveryStore = recoveryStore;
    this.limits = {
      maxNodes: this.normalizeLimit(
        limits.maxNodes,
        DEFAULT_RECORDING_SESSION_LIMITS.maxNodes,
      ),
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

  isRecoveryReady(): boolean {
    return !this.recoveryStore || (this.recoveryReady && !this.recoveryError);
  }

  wasSessionRecovered(): boolean {
    return this.recoveredSession;
  }

  async waitUntilReady(): Promise<void> {
    if (!this.recoveryStore) return;
    await this.initializeRecovery();
    if (this.recoveryError) throw this.recoveryError;
  }

  initializeRecovery(): Promise<void> {
    if (!this.recoveryStore) {
      this.recoveryReady = true;
      return Promise.resolve();
    }
    if (this.recoveryInitPromise) return this.recoveryInitPromise;

    this.recoveryInitPromise = (async () => {
      const raw = await this.recoveryStore!.load();
      if (!raw) {
        this.recoveryReady = true;
        return;
      }

      try {
        await this.restoreRecoveryCheckpoint(raw);
      } catch (error) {
        this.resetSessionState();
        let cleanupError: unknown;
        try {
          await this.recoveryStore!.clear();
        } catch (cleanupFailure) {
          cleanupError = cleanupFailure;
        }
        this.recoveryReady = true;
        console.warn(
          "RecordingSession: discarded invalid recovery checkpoint",
          error,
        );
        this.recoveryError = new Error(
          `recording recovery checkpoint is invalid${
            cleanupError
              ? ` and cleanup failed: ${String((cleanupError as Error)?.message || cleanupError)}`
              : ""
          }`,
        );
        throw this.recoveryError;
      }
      this.recoveredSession = this.state.status !== "idle";
      this.recoveryReady = true;
    })();
    return this.recoveryInitPromise;
  }

  getRecoveryIngestState(): RecordingRecoveryIngestState | null {
    if (!this.recoveryIngestState.sessionId) return null;
    return this.cloneValue(this.recoveryIngestState);
  }

  setActiveTabDocument(tabId: number, documentId: string | undefined): void {
    if (!this.state.activeTabs.has(tabId)) return;
    if (
      typeof documentId === "string" &&
      documentId.length > 0 &&
      documentId.length <= 128
    ) {
      this.activeTabDocuments.set(tabId, documentId);
    } else {
      this.activeTabDocuments.delete(tabId);
    }
  }

  getActiveTabDocument(tabId: number): string | undefined {
    return this.activeTabDocuments.get(tabId);
  }

  matchesActiveTabDocument(tabId: number, documentId: string): boolean {
    const expected = this.activeTabDocuments.get(tabId);
    return !expected || expected === documentId;
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
    this.state.stoppedTabs.delete(tabId);
    this.activeTabDocuments.delete(tabId);
  }

  getActiveTabs(): number[] {
    return Array.from(this.state.activeTabs);
  }

  hasActiveTab(tabId: number): boolean {
    return (
      Number.isInteger(tabId) && tabId >= 0 && this.state.activeTabs.has(tabId)
    );
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

  setLimitHandler(
    handler: ((reason: RecordingLimitReason) => void) | null,
  ): void {
    this.limitHandler = handler;
  }

  async startSession(
    flow: Flow,
    originTabId: number,
    documentId?: string,
  ): Promise<void> {
    // Clear cache for fresh session
    this.nodeIndexMap.clear();
    this.nodeBytesById.clear();
    this.variableBytesByKey.clear();
    this.edgeSeq = 0;
    this.aggregatePayloadBytes = 0;
    this.edgePayloadBytes = 0;
    this.recordingStartedAtMs = Date.now();
    if (this.durationTimer) clearTimeout(this.durationTimer);
    const expectedSessionId = `sess_${this.recordingStartedAtMs}_${this.randomSessionSuffix()}`;
    this.durationTimer = setTimeout(() => {
      if (
        this.state.sessionId === expectedSessionId &&
        this.state.status !== "idle" &&
        !this.limitReached
      ) {
        this.reachLimit("duration", this.limits.maxDurationMs, 0);
      }
    }, this.limits.maxDurationMs);
    this.rateWindowStartedAtMs = this.recordingStartedAtMs;
    this.rateWindowStepCount = 0;
    this.stopRetryCount = 0;
    this.limitReached = null;
    this.automaticStopRequested = false;

    this.state = {
      sessionId: expectedSessionId,
      status: "recording",
      originTabId,
      flow,
      activeTabs: new Set<number>([originTabId]),
      stoppedTabs: new Set<number>(),
    };
    this.activeTabDocuments.clear();
    this.setActiveTabDocument(originTabId, documentId);
    this.recoveryIngestState = {
      sessionId: expectedSessionId,
      sources: [],
      pendingFrameSteps: [],
      lastStepByTab: [],
    };
    this.recoveryRevision = 0;
    this.recoveryCreatedAt = this.recordingStartedAtMs;
    this.recoveryExpiresAt =
      this.recordingStartedAtMs + RECORDING_RECOVERY_TTL_MS;
    this.recoveredSession = false;

    // Initialize caches from existing flow data (supports resume scenarios)
    this.rebuildCaches();
    this.rebuildBudgetAccounting();
    try {
      this.assertInitialFlowWithinBudget();
      await this.persistRecoveryState();
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
    if (this.state.status === "idle") return "";
    if (this.state.status !== "stopping") this.stopRetryCount = 0;
    this.state.status = "stopping";
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
    return this.state.status === "stopping";
  }

  /**
   * Check if we can accept steps (recording or stopping).
   */
  canAcceptSteps(): boolean {
    return (
      !this.limitReached &&
      (this.state.status === "recording" || this.state.status === "stopping")
    );
  }

  /**
   * Transition to paused state.
   */
  pause(): void {
    if (this.state.status === "recording") {
      this.state.status = "paused";
    }
  }

  /**
   * Resume from paused state.
   */
  resume(): void {
    if (this.state.status === "paused") {
      this.state.status = "recording";
    }
  }

  /**
   * Finalize stop and clear session state.
   */
  async stopSession(): Promise<Flow | null> {
    const flow = this.state.flow;
    const sessionId = this.state.sessionId;
    if (this.recoveryStore) {
      await this.enqueuePersistence(() =>
        this.recoveryStore!.clear(sessionId || undefined),
      ).catch((error) => {
        // A saved workflow is already durable at this point. Do not keep a
        // phantom active session solely because stale recovery cleanup failed.
        console.warn(
          "RecordingSession: failed to clear recovery checkpoint",
          error,
        );
      });
    }
    this.resetSessionState();
    return flow;
  }

  async persistRecoveryState(
    ingest?: RecordingRecoveryIngestState,
  ): Promise<void> {
    if (!this.recoveryStore || this.state.status === "idle" || !this.state.flow)
      return;
    if (ingest)
      this.recoveryIngestState = this.normalizeRecoveryIngestState(ingest);

    const now = Date.now();
    const expiresAt = this.recoveryExpiresAt || now + RECORDING_RECOVERY_TTL_MS;
    const durationDeadline =
      this.recordingStartedAtMs + this.limits.maxDurationMs;
    const nextAlarmAt =
      this.state.status === "stopping"
        ? Math.min(
            now +
              Math.min(
                STOP_RECOVERY_RETRY_MAX_MS,
                STOP_RECOVERY_RETRY_BASE_MS *
                  2 ** Math.min(this.stopRetryCount, 6),
              ),
            expiresAt,
          )
        : Math.min(durationDeadline, expiresAt);
    const checkpoint: RecordingRecoveryCheckpoint = {
      id: "active",
      version: RECORDING_RECOVERY_VERSION,
      revision: ++this.recoveryRevision,
      sessionId: this.state.sessionId,
      status: this.state.status,
      originTabId: this.state.originTabId,
      activeTabs: this.getActiveTabs().map((tabId) => ({
        tabId,
        ...(this.activeTabDocuments.get(tabId)
          ? { documentId: this.activeTabDocuments.get(tabId) }
          : {}),
      })),
      stoppedTabs: Array.from(this.state.stoppedTabs),
      flow: this.cloneValue(this.state.flow),
      recordingStartedAtMs: this.recordingStartedAtMs,
      rateWindowStartedAtMs: this.rateWindowStartedAtMs,
      rateWindowStepCount: this.rateWindowStepCount,
      stopRetryCount: this.stopRetryCount,
      limitReached: this.limitReached,
      ingest: this.cloneValue(this.recoveryIngestState),
      createdAt: this.recoveryCreatedAt || now,
      updatedAt: now,
      expiresAt,
      nextAlarmAt,
    };
    await this.enqueuePersistence(() => this.recoveryStore!.save(checkpoint));
  }

  async noteStopPersistenceFailure(): Promise<void> {
    if (this.state.status !== "stopping") return;
    this.stopRetryCount = Math.min(100, this.stopRetryCount + 1);
    await this.persistRecoveryState();
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

  rollbackLastStep(stepId: string): boolean {
    const flow = this.state.flow;
    if (!flow || !Array.isArray(flow.nodes) || !stepId) return false;
    const last = flow.nodes[flow.nodes.length - 1];
    if (!last || last.id !== stepId) return false;
    flow.nodes.pop();
    if (
      Array.isArray(flow.edges) &&
      flow.edges[flow.edges.length - 1]?.to === stepId
    ) {
      flow.edges.pop();
    }
    if (flow.meta) flow.meta.updatedAt = new Date().toISOString();
    this.rebuildCaches();
    this.rebuildBudgetAccounting();
    return true;
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
      return this.reachLimit("duration", this.limits.maxDurationMs, 0);
    }
    if (!this.reserveStepRate(steps.length)) {
      return this.reachLimit("step_rate", this.limits.maxStepsPerSecond, 0);
    }

    // Initialize arrays if missing and refresh the fixed JSON envelope cost.
    const initializedArrays =
      !Array.isArray(f.nodes) || !Array.isArray(f.edges);
    if (!Array.isArray(f.nodes)) f.nodes = [];
    if (!Array.isArray(f.edges)) f.edges = [];
    if (initializedArrays) this.rebuildBudgetAccounting();

    // Legacy compatibility: if flow only has steps, initialize DAG from them once
    if (f.nodes.length === 0 && Array.isArray(f.steps) && f.steps.length > 0) {
      this.rebuildDagFromSteps();
      if (f.nodes.length > this.limits.maxNodes) {
        return this.reachLimit("node_count", this.limits.maxNodes, 0);
      }
      if (this.aggregatePayloadBytes > this.limits.maxPayloadBytes) {
        return this.reachLimit("payload_bytes", this.limits.maxPayloadBytes, 0);
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
        const previousBytes =
          this.nodeBytesById.get(step.id) ?? this.jsonUtf8Bytes(nodes[nodeIdx]);
        const updatedBytes = this.jsonUtf8Bytes(updatedNode);
        const projectedBytes =
          this.aggregatePayloadBytes - previousBytes + updatedBytes;
        if (projectedBytes > this.limits.maxPayloadBytes) {
          this.reachLimit(
            "payload_bytes",
            this.limits.maxPayloadBytes,
            accepted,
          );
          break;
        }
        nodes[nodeIdx] = updatedNode;
        this.nodeBytesById.set(step.id, updatedBytes);
        this.aggregatePayloadBytes = projectedBytes;
        accepted += 1;
      } else {
        // Append: new node
        if (nodes.length >= this.limits.maxNodes) {
          this.reachLimit("node_count", this.limits.maxNodes, accepted);
          break;
        }
        const prevNodeId =
          nodes.length > 0 ? nodes[nodes.length - 1]?.id : undefined;

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
          this.reachLimit(
            "payload_bytes",
            this.limits.maxPayloadBytes,
            accepted,
          );
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
  private toNodeType(stepType: string): NodeBase["type"] {
    if (VALID_NODE_TYPES.has(stepType)) {
      return stepType as NodeBase["type"];
    }
    console.warn(
      `[RecordingSession] Unknown step type "${stepType}", falling back to "script"`,
    );
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
      return this.reachLimit("duration", this.limits.maxDurationMs, 0);
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
            this.variableBytesByKey.get(v.key) ??
            this.jsonUtf8Bytes(f.variables[idx]);
          const updatedBytes = this.jsonUtf8Bytes(v);
          const projectedBytes =
            this.aggregatePayloadBytes - previousBytes + updatedBytes;
          if (projectedBytes > this.limits.maxPayloadBytes) {
            this.reachLimit(
              "payload_bytes",
              this.limits.maxPayloadBytes,
              accepted,
            );
            break;
          }
          f.variables[idx] = v;
          this.variableBytesByKey.set(v.key, updatedBytes);
          this.aggregatePayloadBytes = projectedBytes;
          accepted += 1;
        }
      } else {
        if (f.variables.length >= this.limits.maxVariables) {
          this.reachLimit("variable_count", this.limits.maxVariables, accepted);
          break;
        }
        const variableBytes = this.jsonUtf8Bytes(v);
        const separatorBytes = f.variables.length > 0 ? 1 : 0;
        if (
          this.aggregatePayloadBytes + variableBytes + separatorBytes >
          this.limits.maxPayloadBytes
        ) {
          this.reachLimit(
            "payload_bytes",
            this.limits.maxPayloadBytes,
            accepted,
          );
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
    return typeof value === "number" && Number.isFinite(value) && value > 0
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
    for (const variable of Array.isArray(flow.variables)
      ? flow.variables
      : []) {
      const bytes = this.jsonUtf8Bytes(variable);
      this.variableBytesByKey.set(variable.key, bytes);
    }
    // This is the exact serialized flow size at rebuild points. Incremental
    // mutations below adjust it by their exact JSON element delta, including
    // array separators, so repeated appends never stringify the whole flow.
    this.aggregatePayloadBytes = this.jsonUtf8Bytes(flow);
  }

  private assertInitialFlowWithinBudget(extraPayloadBytes = 0): void {
    const flow = this.state.flow;
    if (!flow) return;
    const nodeCount = Array.isArray(flow.nodes)
      ? flow.nodes.length
      : Array.isArray(flow.steps)
        ? flow.steps.length
        : 0;
    if (nodeCount > this.limits.maxNodes) {
      throw new Error(
        `recording flow exceeds the ${this.limits.maxNodes}-node limit`,
      );
    }
    if ((flow.variables?.length ?? 0) > this.limits.maxVariables) {
      throw new Error(
        `recording flow exceeds the ${this.limits.maxVariables}-variable limit`,
      );
    }
    if (
      this.aggregatePayloadBytes >
      this.limits.maxPayloadBytes + extraPayloadBytes
    ) {
      throw new Error(
        `recording flow exceeds the ${this.limits.maxPayloadBytes}-byte payload limit`,
      );
    }
  }

  private isDurationExceeded(now = Date.now()): boolean {
    return (
      this.recordingStartedAtMs > 0 &&
      now - this.recordingStartedAtMs > this.limits.maxDurationMs
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
    if (this.rateWindowStepCount + count > this.limits.maxStepsPerSecond)
      return false;
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

  private async restoreRecoveryCheckpoint(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("checkpoint must be an object");
    }
    const checkpoint = raw as Partial<RecordingRecoveryCheckpoint>;
    const now = Date.now();
    if (
      checkpoint.version !== RECORDING_RECOVERY_VERSION ||
      checkpoint.id !== "active"
    ) {
      throw new Error("checkpoint version is unsupported");
    }
    if (
      typeof checkpoint.sessionId !== "string" ||
      checkpoint.sessionId.length === 0 ||
      checkpoint.sessionId.length > 128
    ) {
      throw new Error("checkpoint sessionId is invalid");
    }
    if (
      checkpoint.status !== "recording" &&
      checkpoint.status !== "paused" &&
      checkpoint.status !== "stopping"
    ) {
      throw new Error("checkpoint status is invalid");
    }
    if (
      !Number.isFinite(checkpoint.expiresAt) ||
      !Number.isFinite(checkpoint.createdAt) ||
      !Number.isFinite(checkpoint.updatedAt) ||
      checkpoint.expiresAt! <= now ||
      checkpoint.createdAt! > now + 60_000 ||
      checkpoint.updatedAt! > now + 60_000
    ) {
      throw new Error("checkpoint lifetime is invalid or expired");
    }
    if (
      !Number.isSafeInteger(checkpoint.revision) ||
      checkpoint.revision! < 0 ||
      !Number.isFinite(checkpoint.recordingStartedAtMs) ||
      checkpoint.recordingStartedAtMs! <= 0 ||
      checkpoint.recordingStartedAtMs! > now + 60_000
    ) {
      throw new Error("checkpoint counters are invalid");
    }
    if (
      !checkpoint.flow ||
      typeof checkpoint.flow !== "object" ||
      Array.isArray(checkpoint.flow)
    ) {
      throw new Error("checkpoint flow is invalid");
    }
    this.assertRecoveryFlowShape(checkpoint.flow);
    if (
      !Array.isArray(checkpoint.activeTabs) ||
      checkpoint.activeTabs.length > MAX_RECORDING_ACTIVE_TABS
    ) {
      throw new Error("checkpoint activeTabs is invalid");
    }
    if (
      !Array.isArray(checkpoint.stoppedTabs) ||
      checkpoint.stoppedTabs.length > MAX_RECORDING_ACTIVE_TABS
    ) {
      throw new Error("checkpoint stoppedTabs is invalid");
    }

    const tabIdentities = new Map<number, string | undefined>();
    for (const identity of checkpoint.activeTabs) {
      if (
        !identity ||
        !Number.isInteger(identity.tabId) ||
        identity.tabId < 0 ||
        tabIdentities.has(identity.tabId) ||
        (identity.documentId !== undefined &&
          (typeof identity.documentId !== "string" ||
            identity.documentId.length === 0 ||
            identity.documentId.length > 128))
      ) {
        throw new Error("checkpoint tab identity is invalid");
      }
      tabIdentities.set(identity.tabId, identity.documentId);
    }

    const liveTabs = new Set<number>();
    const liveDocuments = new Map<number, string>();
    for (const [tabId, expectedDocumentId] of tabIdentities) {
      try {
        await chrome.tabs.get(tabId);
        // A tab id alone is not a durable authority boundary. If the exact
        // top-frame document was unavailable at checkpoint time, preserve the
        // draft but interrupt capture rather than attach it to a replacement.
        if (!expectedDocumentId) continue;
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        const top = Array.isArray(frames)
          ? frames.find((frame) => frame.frameId === 0)
          : undefined;
        const currentDocumentId =
          typeof top?.documentId === "string" && top.documentId.length <= 128
            ? top.documentId
            : undefined;
        if (!currentDocumentId || currentDocumentId !== expectedDocumentId)
          continue;
        liveTabs.add(tabId);
        if (currentDocumentId) liveDocuments.set(tabId, currentDocumentId);
      } catch {
        // Closed tabs and replaced documents cannot retain recording authority.
      }
    }

    const originTabId =
      checkpoint.originTabId === null
        ? null
        : Number.isInteger(checkpoint.originTabId) &&
            checkpoint.originTabId! >= 0
          ? checkpoint.originTabId!
          : (() => {
              throw new Error("checkpoint originTabId is invalid");
            })();
    const stoppedTabs = new Set<number>();
    for (const tabId of checkpoint.stoppedTabs) {
      if (!Number.isInteger(tabId) || tabId < 0) {
        throw new Error("checkpoint stopped tab is invalid");
      }
      if (liveTabs.has(tabId)) stoppedTabs.add(tabId);
    }

    this.state = {
      sessionId: checkpoint.sessionId,
      // With no exact live document, retain the draft but stop accepting events.
      status: liveTabs.size > 0 ? checkpoint.status : "stopping",
      originTabId:
        originTabId !== null && liveTabs.has(originTabId) ? originTabId : null,
      flow: this.cloneValue(checkpoint.flow),
      activeTabs: liveTabs,
      stoppedTabs,
    };
    this.activeTabDocuments = liveDocuments;
    this.recordingStartedAtMs = checkpoint.recordingStartedAtMs!;
    this.rateWindowStartedAtMs =
      Number.isFinite(checkpoint.rateWindowStartedAtMs) &&
      checkpoint.rateWindowStartedAtMs! > 0
        ? checkpoint.rateWindowStartedAtMs!
        : now;
    this.rateWindowStepCount =
      Number.isSafeInteger(checkpoint.rateWindowStepCount) &&
      checkpoint.rateWindowStepCount! >= 0
        ? checkpoint.rateWindowStepCount!
        : 0;
    if (
      !Number.isSafeInteger(checkpoint.stopRetryCount) ||
      checkpoint.stopRetryCount! < 0 ||
      checkpoint.stopRetryCount! > 100
    ) {
      throw new Error("checkpoint stop retry state is invalid");
    }
    this.stopRetryCount = checkpoint.stopRetryCount!;
    this.limitReached =
      checkpoint.limitReached === null || checkpoint.limitReached === undefined
        ? null
        : this.isLimitReason(checkpoint.limitReached)
          ? checkpoint.limitReached
          : (() => {
              throw new Error("checkpoint limit state is invalid");
            })();
    this.automaticStopRequested = this.limitReached !== null;
    this.recoveryRevision = checkpoint.revision!;
    this.recoveryCreatedAt = checkpoint.createdAt!;
    this.recoveryExpiresAt = checkpoint.expiresAt!;
    this.recoveryIngestState = this.normalizeRecoveryIngestState(
      checkpoint.ingest,
      checkpoint.sessionId,
    );

    this.rebuildCaches();
    this.rebuildBudgetAccounting();
    this.assertInitialFlowWithinBudget(
      this.state.status === "stopping"
        ? STOP_RECOVERY_FINALIZATION_OVERHEAD_BYTES
        : 0,
    );
    this.scheduleDurationTimer();
  }

  private normalizeRecoveryIngestState(
    value: RecordingRecoveryIngestState | undefined,
    expectedSessionId = this.state.sessionId,
  ): RecordingRecoveryIngestState {
    if (
      !value ||
      typeof value !== "object" ||
      value.sessionId !== expectedSessionId
    ) {
      if (value === undefined) {
        return {
          sessionId: expectedSessionId,
          sources: [],
          pendingFrameSteps: [],
          lastStepByTab: [],
        };
      }
      throw new Error("checkpoint ingest session is invalid");
    }
    if (
      !Array.isArray(value.sources) ||
      value.sources.length > MAX_RECOVERY_SOURCES ||
      !Array.isArray(value.pendingFrameSteps) ||
      value.pendingFrameSteps.length > MAX_RECOVERY_PENDING_FRAME_STEPS ||
      !Array.isArray(value.lastStepByTab) ||
      value.lastStepByTab.length > MAX_RECOVERY_LAST_STEP_TABS
    ) {
      throw new Error("checkpoint ingest capacity is invalid");
    }

    const sources = value.sources.map((source) => {
      if (
        !source ||
        typeof source.sourceKey !== "string" ||
        source.sourceKey.length === 0 ||
        source.sourceKey.length > 512 ||
        !Number.isSafeInteger(source.highWatermarkSeq) ||
        source.highWatermarkSeq < 0 ||
        !Number.isFinite(source.updatedAt)
      ) {
        throw new Error("checkpoint ingest source is invalid");
      }
      return { ...source };
    });
    const pendingFrameSteps = value.pendingFrameSteps.map((pending) => {
      if (
        !pending ||
        !Number.isInteger(pending.tabId) ||
        pending.tabId < 0 ||
        !/^frame_[a-f0-9]{32}$/.test(pending.eventId) ||
        !pending.step ||
        typeof pending.step !== "object" ||
        typeof pending.step.id !== "string" ||
        pending.step.id.length === 0 ||
        typeof pending.step.type !== "string" ||
        typeof pending.href !== "string" ||
        pending.href.length > 16_384 ||
        !Number.isFinite(pending.createdAt)
      ) {
        throw new Error("checkpoint pending frame step is invalid");
      }
      return this.cloneValue(pending);
    });
    const lastStepByTab = value.lastStepByTab.map((entry) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !Number.isInteger(entry[0]) ||
        entry[0] < 0 ||
        typeof entry[1] !== "string" ||
        entry[1].length === 0 ||
        entry[1].length > 256
      ) {
        throw new Error("checkpoint last-step state is invalid");
      }
      return [entry[0], entry[1]] as [number, string];
    });

    const normalized = {
      sessionId: expectedSessionId,
      sources,
      pendingFrameSteps,
      lastStepByTab,
    };
    const bytes = new TextEncoder().encode(
      JSON.stringify(normalized),
    ).byteLength;
    if (bytes > MAX_RECOVERY_INGEST_BYTES) {
      throw new Error("checkpoint ingest state exceeds its byte limit");
    }
    return normalized;
  }

  private assertRecoveryFlowShape(flow: Flow): void {
    if (
      typeof flow.id !== "string" ||
      flow.id.length === 0 ||
      flow.id.length > 256 ||
      typeof flow.name !== "string" ||
      flow.name.length === 0 ||
      flow.name.length > 1_024 ||
      !Number.isFinite(flow.version) ||
      !Array.isArray(flow.nodes) ||
      !Array.isArray(flow.edges) ||
      !Array.isArray(flow.variables)
    ) {
      throw new Error("checkpoint flow envelope is invalid");
    }

    const nodeIds = new Set<string>();
    for (const node of flow.nodes) {
      if (
        !node ||
        typeof node !== "object" ||
        typeof node.id !== "string" ||
        node.id.length === 0 ||
        node.id.length > 256 ||
        nodeIds.has(node.id) ||
        typeof node.type !== "string" ||
        !VALID_NODE_TYPES.has(node.type) ||
        (node.config !== undefined &&
          (!node.config ||
            typeof node.config !== "object" ||
            Array.isArray(node.config)))
      ) {
        throw new Error("checkpoint flow node is invalid");
      }
      nodeIds.add(node.id);
    }
    if (flow.edges.length !== Math.max(0, flow.nodes.length - 1)) {
      throw new Error("checkpoint flow edge count is invalid");
    }
    for (let index = 0; index < flow.edges.length; index += 1) {
      const edge = flow.edges[index];
      if (
        !edge ||
        typeof edge.id !== "string" ||
        edge.id.length === 0 ||
        edge.id.length > 1_024 ||
        edge.from !== flow.nodes[index]?.id ||
        edge.to !== flow.nodes[index + 1]?.id
      ) {
        throw new Error("checkpoint flow edge is invalid");
      }
    }
    const variableKeys = new Set<string>();
    for (const variable of flow.variables) {
      if (
        !variable ||
        typeof variable !== "object" ||
        typeof variable.key !== "string" ||
        variable.key.length === 0 ||
        variable.key.length > 256 ||
        variableKeys.has(variable.key)
      ) {
        throw new Error("checkpoint flow variable is invalid");
      }
      variableKeys.add(variable.key);
    }
    if (
      this.jsonUtf8Bytes(flow) >
      this.limits.maxPayloadBytes + STOP_RECOVERY_FINALIZATION_OVERHEAD_BYTES
    ) {
      throw new Error("checkpoint flow exceeds its byte limit");
    }
  }

  private resetSessionState(): void {
    this.state = {
      sessionId: "",
      status: "idle",
      originTabId: null,
      flow: null,
      activeTabs: new Set<number>(),
      stoppedTabs: new Set<number>(),
    };
    this.nodeIndexMap.clear();
    this.nodeBytesById.clear();
    this.variableBytesByKey.clear();
    this.activeTabDocuments.clear();
    this.edgeSeq = 0;
    this.aggregatePayloadBytes = 0;
    this.edgePayloadBytes = 0;
    this.recordingStartedAtMs = 0;
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = null;
    this.rateWindowStartedAtMs = 0;
    this.rateWindowStepCount = 0;
    this.stopRetryCount = 0;
    this.limitReached = null;
    this.automaticStopRequested = false;
    this.recoveryIngestState = {
      sessionId: "",
      sources: [],
      pendingFrameSteps: [],
      lastStepByTab: [],
    };
    this.recoveryRevision = 0;
    this.recoveryCreatedAt = 0;
    this.recoveryExpiresAt = 0;
    this.recoveredSession = false;
    this.recoveryError = null;
  }

  private scheduleDurationTimer(): void {
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = null;
    if (this.state.status === "idle" || this.state.status === "stopping")
      return;
    const remaining =
      this.recordingStartedAtMs + this.limits.maxDurationMs - Date.now();
    const expectedSessionId = this.state.sessionId;
    this.durationTimer = setTimeout(
      () => {
        if (
          this.state.sessionId === expectedSessionId &&
          this.state.status !== "idle" &&
          !this.limitReached
        ) {
          this.reachLimit("duration", this.limits.maxDurationMs, 0);
        }
      },
      Math.max(0, Math.min(remaining, 2_147_483_647)),
    );
  }

  private isLimitReason(value: unknown): value is RecordingLimitReason {
    return (
      value === "node_count" ||
      value === "payload_bytes" ||
      value === "variable_count" ||
      value === "duration" ||
      value === "step_rate"
    );
  }

  private randomSessionSuffix(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }

  private cloneValue<T>(value: T): T {
    return structuredClone(value);
  }

  private enqueuePersistence(operation: () => Promise<void>): Promise<void> {
    const queued = this.persistenceQueue.catch(() => {}).then(operation);
    this.persistenceQueue = queued.catch(() => {});
    return queued;
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
      const recentNodes = f.nodes.slice(
        Math.max(0, totalSteps - this.limits.timelineWindow),
      );
      const steps = recentNodes.map((n) => {
        const cfg =
          n && typeof n.config === "object" && n.config != null
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
        steps: f.steps.slice(
          Math.max(0, f.steps.length - this.limits.timelineWindow),
        ),
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
export const recordingSession = new RecordingSessionManager(
  {},
  browserRecordingRecoveryStore,
);
