/**
 * @fileoverview RPC Server Implementation
 * @description Handles RPC requests from UI via chrome.runtime.Port
 */

import type { ISODateTimeString, JsonObject, JsonValue } from '../../domain/json';
import type { EdgeId, FlowId, NodeId, RunId, TriggerId } from '../../domain/ids';
import type { DebuggerCommand } from '../../domain/debug';
import type { RunEvent } from '../../domain/events';
import type { FlowV3, NodeV3, EdgeV3 } from '../../domain/flow';
import { FLOW_SCHEMA_VERSION as CURRENT_FLOW_SCHEMA_VERSION } from '../../domain/flow';
import type { VariableDefinition } from '../../domain/variables';
import type { TriggerKind, TriggerSpec } from '../../domain/triggers';
import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from './events-bus';
import type { DebugController, RunnerRegistry } from '../kernel/debug-controller';
import type { RunScheduler } from '../queue/scheduler';
import type { QueueItemStatus } from '../queue/queue';
import { enqueueRun } from '../queue/enqueue-run';
import type { TriggerManager } from '../triggers/trigger-manager';
import {
  RR_V3_PORT_NAME,
  isRpcRequest,
  createRpcResponseOk,
  createRpcResponseErr,
  createRpcEventMessage,
  type RpcRequest,
} from './rpc';

/**
 * RPC Server Configuration
 */
export interface RpcServerConfig {
  storage: StoragePort;
  events: EventsBus;
  debugController?: DebugController;
  runners?: RunnerRegistry;
  scheduler?: RunScheduler;
  triggerManager?: TriggerManager;
  /** ID Generator (for test injection) */
  generateRunId?: () => RunId;
  /** Time source (for test injection) */
  now?: () => number;
}

/**
 * Active Port connection
 */
interface PortConnection {
  port: chrome.runtime.Port;
  subscriptions: Set<RunId | null>; // null means subscribe to all
}

/**
 * Default RunId generator
 */
function defaultGenerateRunId(): RunId {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Route A scope: disable platform-style trigger/schedule automation surfaces.
const ENABLE_V3_TRIGGERS_AND_SCHEDULES = false;
const TRIGGER_SURFACE_DISABLED_ERROR =
  'Triggers and schedules are disabled in Connector scope.';

/**
 * RPC Server
 * @description Handle RPC requests from the UI
 */
export class RpcServer {
  private readonly storage: StoragePort;
  private readonly events: EventsBus;
  private readonly debugController?: DebugController;
  private readonly runners?: RunnerRegistry;
  private readonly scheduler?: RunScheduler;
  private readonly triggerManager?: TriggerManager;
  private readonly generateRunId: () => RunId;
  private readonly now: () => number;
  private readonly connections = new Map<string, PortConnection>();
  private eventUnsubscribe: (() => void) | null = null;

  constructor(config: RpcServerConfig) {
    this.storage = config.storage;
    this.events = config.events;
    this.debugController = config.debugController;
    this.runners = config.runners;
    this.scheduler = config.scheduler;
    this.triggerManager = config.triggerManager;
    this.generateRunId = config.generateRunId ?? defaultGenerateRunId;
    this.now = config.now ?? Date.now;
  }

  /**
   * Start RPC Server
   */
  start(): void {
    chrome.runtime.onConnect.addListener(this.handleConnect);

    // Subscribe to all events and broadcast to connected ports
    this.eventUnsubscribe = this.events.subscribe((event) => {
      this.broadcastEvent(event);
    });
  }

  /**
   * Stop RPC Server
   */
  stop(): void {
    chrome.runtime.onConnect.removeListener(this.handleConnect);

    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = null;
    }

    // Disconnect all ports
    for (const conn of this.connections.values()) {
      conn.port.disconnect();
    }
    this.connections.clear();
  }

  /**
   * Handle new connections
   */
  private handleConnect = (port: chrome.runtime.Port): void => {
    if (port.name !== RR_V3_PORT_NAME) return;

    const connId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const connection: PortConnection = {
      port,
      subscriptions: new Set(),
    };

    this.connections.set(connId, connection);

    port.onMessage.addListener((msg) => this.handleMessage(connId, msg));
    port.onDisconnect.addListener(() => this.handleDisconnect(connId));
  };

  /**
   * Process messages
   */
  private handleMessage = async (connId: string, msg: unknown): Promise<void> => {
    if (!isRpcRequest(msg)) return;

    const conn = this.connections.get(connId);
    if (!conn) return;

    try {
      const result = await this.handleRequest(msg, conn);
      conn.port.postMessage(createRpcResponseOk(msg.requestId, result));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      conn.port.postMessage(createRpcResponseErr(msg.requestId, error));
    }
  };

  /**
   * Handle disconnection
   */
  private handleDisconnect = (connId: string): void => {
    this.connections.delete(connId);
  };

  /**
   * broadcast event
   */
  private broadcastEvent(event: RunEvent): void {
    const message = createRpcEventMessage(event);

    for (const conn of this.connections.values()) {
      // Check if this connection subscribed to this event
      const subs = conn.subscriptions;
      if (subs.size === 0) continue; // No subscriptions
      if (subs.has(null) || subs.has(event.runId)) {
        try {
          conn.port.postMessage(message);
        } catch {
          // Port may be disconnected
        }
      }
    }
  }

  // ===== Queue Management Handlers =====

  /**
   * Handle enqueueRun requests
   * @description Delegate to the shared enqueueRun service
   */
  private async handleEnqueueRun(params: JsonObject | undefined): Promise<JsonValue> {
    const result = await enqueueRun(
      {
        storage: this.storage,
        events: this.events,
        scheduler: this.scheduler,
        generateRunId: this.generateRunId,
        now: this.now,
      },
      {
        flowId: params?.flowId as FlowId,
        startNodeId: params?.startNodeId as NodeId | undefined,
        priority: params?.priority as number | undefined,
        maxAttempts: params?.maxAttempts as number | undefined,
        args: params?.args as JsonObject | undefined,
        debug: params?.debug as { breakpoints?: string[]; pauseOnStart?: boolean } | undefined,
      },
    );

    return result as unknown as JsonValue;
  }

  /**
   * Handle listQueue requests
   * @description List queue items, sorted by priority DESC + createdAt ASC
   */
  private async handleListQueue(params: JsonObject | undefined): Promise<JsonValue> {
    const rawStatus = params?.status;

    // Verify status whitelist
    let status: QueueItemStatus | undefined;
    if (rawStatus !== undefined) {
      if (rawStatus !== 'queued' && rawStatus !== 'running' && rawStatus !== 'paused') {
        throw new Error('status must be one of: queued, running, paused');
      }
      status = rawStatus;
    }

    const items = await this.storage.queue.list(status);

    // Sort by priority DESC + createdAt ASC
    items.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority; // DESC
      }
      return a.createdAt - b.createdAt; // ASC (FIFO)
    });

    return items as unknown as JsonValue;
  }

  /**
   * Handle cancelQueueItem request
   * @description Cancel the queued queue item, update the Run status, and publish the run.canceled event
   * @note Only items with status=queued are allowed to be canceled; running/paused needs to use rr_v3.cancelRun
   */
  private async handleCancelQueueItem(params: JsonObject | undefined): Promise<JsonValue> {
    const runId = params?.runId as RunId | undefined;
    if (!runId) throw new Error('runId is required');

    const reason = params?.reason as string | undefined;
    const now = this.now();

    // 1. Check queue item exists
    const queueItem = await this.storage.queue.get(runId);
    if (!queueItem) {
      throw new Error(`Queue item "${runId}" not found`);
    }

    // 2. Only the queued state is allowed to be canceled (running/paused needs to use rr_v3.cancelRun)
    if (queueItem.status !== 'queued') {
      throw new Error(
        `Cannot cancel queue item "${runId}" with status "${queueItem.status}"; use rr_v3.cancelRun for running/paused runs`,
      );
    }

    // 3. Remove from queue
    await this.storage.queue.cancel(runId, now, reason);

    // 4. Update Run record status
    await this.storage.runs.patch(runId, {
      status: 'canceled',
      updatedAt: now,
      finishedAt: now,
    });

    // 5. Publish the run.canceled event (via EventsBus to ensure broadcasting)
    await this.events.append({
      runId,
      type: 'run.canceled',
      reason,
    });

    return { ok: true, runId };
  }

  /**
   * Handle RPC requests
   */
  private async handleRequest(request: RpcRequest, conn: PortConnection): Promise<JsonValue> {
    const { method, params } = request;

    switch (method) {
      case 'rr_v3.listRuns': {
        const runs = await this.storage.runs.list();
        return runs as unknown as JsonValue;
      }

      case 'rr_v3.getRun': {
        const runId = params?.runId as RunId | undefined;
        if (!runId) throw new Error('runId is required');
        const run = await this.storage.runs.get(runId);
        return run as unknown as JsonValue;
      }

      case 'rr_v3.getEvents': {
        const runId = params?.runId as RunId | undefined;
        if (!runId) throw new Error('runId is required');
        const fromSeq = params?.fromSeq as number | undefined;
        const limit = params?.limit as number | undefined;
        const events = await this.storage.events.list(runId, { fromSeq, limit });
        return events as unknown as JsonValue;
      }

      case 'rr_v3.getFlow': {
        const flowId = params?.flowId as FlowId | undefined;
        if (!flowId) throw new Error('flowId is required');
        const flow = await this.storage.flows.get(flowId);
        return flow as unknown as JsonValue;
      }

      case 'rr_v3.listFlows': {
        const flows = await this.storage.flows.list();
        return flows as unknown as JsonValue;
      }

      case 'rr_v3.saveFlow': {
        return this.handleSaveFlow(params);
      }

      case 'rr_v3.deleteFlow': {
        return this.handleDeleteFlow(params);
      }

      // ===== Trigger APIs =====

      case 'rr_v3.createTrigger':
      case 'rr_v3.updateTrigger':
      case 'rr_v3.deleteTrigger':
      case 'rr_v3.getTrigger':
      case 'rr_v3.listTriggers':
      case 'rr_v3.enableTrigger':
      case 'rr_v3.disableTrigger':
      case 'rr_v3.fireTrigger':
        return this.handleTriggerRequest(method, params);

      // ===== Queue Management APIs =====

      case 'rr_v3.enqueueRun': {
        return this.handleEnqueueRun(params);
      }

      case 'rr_v3.listQueue': {
        return this.handleListQueue(params);
      }

      case 'rr_v3.cancelQueueItem': {
        return this.handleCancelQueueItem(params);
      }

      case 'rr_v3.subscribe': {
        const runId = (params?.runId as RunId | undefined) ?? null;
        conn.subscriptions.add(runId);
        return { subscribed: true, runId };
      }

      case 'rr_v3.unsubscribe': {
        const runId = (params?.runId as RunId | undefined) ?? null;
        conn.subscriptions.delete(runId);
        return { unsubscribed: true, runId };
      }

      // Debug method - route to DebugController
      case 'rr_v3.debug': {
        if (!this.debugController) {
          throw new Error('DebugController not configured');
        }
        const cmd = params as unknown as DebuggerCommand;
        if (!cmd || !cmd.type) {
          throw new Error('Invalid debug command');
        }
        const response = await this.debugController.handle(cmd);
        return response as unknown as JsonValue;
      }

      // Control methods
      case 'rr_v3.startRun':
        // startRun is essentially enqueueRun - the run starts when claimed by scheduler
        return this.handleEnqueueRun(params);

      case 'rr_v3.pauseRun':
        return this.handlePauseRun(params);

      case 'rr_v3.resumeRun':
        return this.handleResumeRun(params);

      case 'rr_v3.cancelRun':
        return this.handleCancelRun(params);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ===== Flow Management Handlers =====

  /**
   * Handling saveFlow requests
   * @description Save or update the flow to perform complete structural verification
   */
  private async handleSaveFlow(params: JsonObject | undefined): Promise<JsonValue> {
    const rawFlow = params?.flow;
    if (!rawFlow || typeof rawFlow !== 'object' || Array.isArray(rawFlow)) {
      throw new Error('flow is required');
    }

    // Check whether the existing flow is being updated (use the trimmed ID query)
    const rawId = (rawFlow as JsonObject).id;
    let existingFlow: FlowV3 | null = null;
    if (typeof rawId === 'string' && rawId.trim()) {
      existingFlow = await this.storage.flows.get(rawId.trim() as FlowId);
    }

    // Normalize flow, pass in existingFlow to inherit createdAt
    const flow = this.normalizeFlowSpec(rawFlow, existingFlow);

    // Save to storage (the storage layer will perform two-step verification)
    await this.storage.flows.save(flow);

    return flow as unknown as JsonValue;
  }

  /**
   * Handling deleteFlow requests
   * @description To delete a Flow, first check whether there are associated Triggers and queued runs.
   */
  private async handleDeleteFlow(params: JsonObject | undefined): Promise<JsonValue> {
    const flowId = params?.flowId as FlowId | undefined;
    if (!flowId) throw new Error('flowId is required');

    // Check if Flow exists
    const existing = await this.storage.flows.get(flowId);
    if (!existing) {
      throw new Error(`Flow "${flowId}" not found`);
    }

    // Check if there is an associated Trigger
    const triggers = await this.storage.triggers.list();
    const linkedTriggers = triggers.filter((t) => t.flowId === flowId);
    if (linkedTriggers.length > 0) {
      const triggerIds = linkedTriggers.map((t) => t.id).join(', ');
      throw new Error(
        `Cannot delete flow "${flowId}": it has ${linkedTriggers.length} linked trigger(s): ${triggerIds}. ` +
          `Delete the trigger(s) first.`,
      );
    }

    // Check if there are queued runs (unexecuted runs will fail after deletion)
    const queuedItems = await this.storage.queue.list('queued');
    const linkedQueuedRuns = queuedItems.filter((item) => item.flowId === flowId);
    if (linkedQueuedRuns.length > 0) {
      const runIds = linkedQueuedRuns.map((r) => r.id).join(', ');
      throw new Error(
        `Cannot delete flow "${flowId}": it has ${linkedQueuedRuns.length} queued run(s): ${runIds}. ` +
          `Cancel the run(s) first or wait for them to complete.`,
      );
    }

    // Delete Flow
    await this.storage.flows.delete(flowId);

    return { ok: true, flowId };
  }

  /**
   * Normalize FlowV3 input
   * @description Validate and transform input into complete FlowV3 structure
   * @param value original input
   * @param existingFlow Existing flow (used to inherit createdAt)
   */
  private normalizeFlowSpec(value: unknown, existingFlow: FlowV3 | null = null): FlowV3 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('flow is required');
    }
    const raw = value as JsonObject;

    // id Verify and generate
    let id: FlowId;
    if (raw.id === undefined || raw.id === null) {
      id = `flow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` as FlowId;
    } else {
      if (typeof raw.id !== 'string' || !raw.id.trim()) {
        throw new Error('flow.id must be a non-empty string');
      }
      id = raw.id.trim() as FlowId;
    }

    // name Verification
    if (!raw.name || typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new Error('flow.name is required');
    }
    const name = raw.name.trim();

    // description Verification
    let description: string | undefined;
    if (raw.description !== undefined && raw.description !== null) {
      if (typeof raw.description !== 'string') {
        throw new Error('flow.description must be a string');
      }
      description = raw.description;
    }

    // entryNodeId Verification
    if (!raw.entryNodeId || typeof raw.entryNodeId !== 'string' || !raw.entryNodeId.trim()) {
      throw new Error('flow.entryNodeId is required');
    }
    const entryNodeId = raw.entryNodeId.trim() as NodeId;

    // nodes Verification
    if (!Array.isArray(raw.nodes)) {
      throw new Error('flow.nodes must be an array');
    }
    const nodes = raw.nodes.map((n, i) => this.normalizeNode(n, i));

    // Verify node ID uniqueness
    const nodeIdSet = new Set<string>();
    for (const node of nodes) {
      if (nodeIdSet.has(node.id)) {
        throw new Error(`Duplicate node ID: "${node.id}"`);
      }
      nodeIdSet.add(node.id);
    }

    // edges Verification
    let edges: EdgeV3[] = [];
    if (raw.edges !== undefined && raw.edges !== null) {
      if (!Array.isArray(raw.edges)) {
        throw new Error('flow.edges must be an array');
      }
      edges = raw.edges.map((e, i) => this.normalizeEdge(e, i));
    }

    // Verify edge ID uniqueness
    const edgeIdSet = new Set<string>();
    for (const edge of edges) {
      if (edgeIdSet.has(edge.id)) {
        throw new Error(`Duplicate edge ID: "${edge.id}"`);
      }
      edgeIdSet.add(edge.id);
    }

    // Verify entryNodeId exists
    if (!nodeIdSet.has(entryNodeId)) {
      throw new Error(`Entry node "${entryNodeId}" does not exist in flow`);
    }

    // Validate edge references
    for (const edge of edges) {
      if (!nodeIdSet.has(edge.from)) {
        throw new Error(`Edge "${edge.id}" references non-existent source node "${edge.from}"`);
      }
      if (!nodeIdSet.has(edge.to)) {
        throw new Error(`Edge "${edge.id}" references non-existent target node "${edge.to}"`);
      }
    }

    // Timestamp: inherit existingFlow.createdAt when updating, use the current time when creating a new one
    const now = new Date(this.now()).toISOString() as ISODateTimeString;
    const createdAt = existingFlow?.createdAt ?? now;
    const updatedAt = now;

    // Build the complete FlowV3
    const flow: FlowV3 = {
      schemaVersion: CURRENT_FLOW_SCHEMA_VERSION,
      id,
      name,
      createdAt,
      updatedAt,
      entryNodeId,
      nodes,
      edges,
    };

    // optional fields
    if (description !== undefined) {
      flow.description = description;
    }

    // variables Verification: Each item must be an object and have a name field
    if (raw.variables !== undefined && raw.variables !== null) {
      if (!Array.isArray(raw.variables)) {
        throw new Error('flow.variables must be an array');
      }
      const variables: VariableDefinition[] = [];
      const varNameSet = new Set<string>();
      for (let i = 0; i < raw.variables.length; i++) {
        const v = raw.variables[i];
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          throw new Error(`flow.variables[${i}] must be an object`);
        }
        const varObj = v as JsonObject;
        if (!varObj.name || typeof varObj.name !== 'string' || !varObj.name.trim()) {
          throw new Error(`flow.variables[${i}].name is required`);
        }
        const varName = varObj.name.trim();
        if (varNameSet.has(varName)) {
          throw new Error(`Duplicate variable name: "${varName}"`);
        }
        varNameSet.add(varName);
        // Use trimmed name
        variables.push({ ...varObj, name: varName } as unknown as VariableDefinition);
      }
      if (variables.length > 0) {
        flow.variables = variables;
      }
    }

    if (raw.policy !== undefined && raw.policy !== null) {
      if (typeof raw.policy !== 'object' || Array.isArray(raw.policy)) {
        throw new Error('flow.policy must be an object');
      }
      flow.policy = raw.policy as FlowV3['policy'];
    }
    if (raw.meta !== undefined && raw.meta !== null) {
      if (typeof raw.meta !== 'object' || Array.isArray(raw.meta)) {
        throw new Error('flow.meta must be an object');
      }
      flow.meta = raw.meta as FlowV3['meta'];
    }

    return flow;
  }

  /**
   * Normalize Node input
   */
  private normalizeNode(value: unknown, index: number): NodeV3 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`flow.nodes[${index}] must be an object`);
    }
    const raw = value as JsonObject;

    // id Check (not empty + trim)
    if (!raw.id || typeof raw.id !== 'string' || !raw.id.trim()) {
      throw new Error(`flow.nodes[${index}].id is required`);
    }
    const nodeId = raw.id.trim() as NodeId;

    // kind Check (not empty + trim)
    if (!raw.kind || typeof raw.kind !== 'string' || !raw.kind.trim()) {
      throw new Error(`flow.nodes[${index}].kind is required`);
    }
    const kind = raw.kind.trim();

    // config Verification
    if (raw.config !== undefined && raw.config !== null) {
      if (typeof raw.config !== 'object' || Array.isArray(raw.config)) {
        throw new Error(`flow.nodes[${index}].config must be an object`);
      }
    }

    const node: NodeV3 = {
      id: nodeId,
      kind,
      config: (raw.config as JsonObject) ?? {},
    };

    // optional fields
    if (raw.name !== undefined && raw.name !== null) {
      if (typeof raw.name !== 'string') {
        throw new Error(`flow.nodes[${index}].name must be a string`);
      }
      node.name = raw.name;
    }
    if (raw.disabled !== undefined && raw.disabled !== null) {
      if (typeof raw.disabled !== 'boolean') {
        throw new Error(`flow.nodes[${index}].disabled must be a boolean`);
      }
      node.disabled = raw.disabled;
    }
    if (raw.policy !== undefined && raw.policy !== null) {
      if (typeof raw.policy !== 'object' || Array.isArray(raw.policy)) {
        throw new Error(`flow.nodes[${index}].policy must be an object`);
      }
      node.policy = raw.policy as NodeV3['policy'];
    }
    if (raw.ui !== undefined && raw.ui !== null) {
      if (typeof raw.ui !== 'object' || Array.isArray(raw.ui)) {
        throw new Error(`flow.nodes[${index}].ui must be an object`);
      }
      node.ui = raw.ui as NodeV3['ui'];
    }

    return node;
  }

  /**
   * Normalize Edge input
   */
  private normalizeEdge(value: unknown, index: number): EdgeV3 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`flow.edges[${index}] must be an object`);
    }
    const raw = value as JsonObject;

    // id Check or generate (not empty + trim)
    let id: EdgeId;
    if (raw.id === undefined || raw.id === null) {
      id = `edge_${index}_${Math.random().toString(36).slice(2, 8)}` as EdgeId;
    } else {
      if (typeof raw.id !== 'string' || !raw.id.trim()) {
        throw new Error(`flow.edges[${index}].id must be a non-empty string`);
      }
      id = raw.id.trim() as EdgeId;
    }

    // from Check (not empty + trim)
    if (!raw.from || typeof raw.from !== 'string' || !raw.from.trim()) {
      throw new Error(`flow.edges[${index}].from is required`);
    }
    const from = raw.from.trim() as NodeId;

    // to Check (not empty + trim)
    if (!raw.to || typeof raw.to !== 'string' || !raw.to.trim()) {
      throw new Error(`flow.edges[${index}].to is required`);
    }
    const to = raw.to.trim() as NodeId;

    const edge: EdgeV3 = {
      id,
      from,
      to,
    };

    // label Optional
    if (raw.label !== undefined && raw.label !== null) {
      if (typeof raw.label !== 'string') {
        throw new Error(`flow.edges[${index}].label must be a string`);
      }
      edge.label = raw.label as EdgeV3['label'];
    }

    return edge;
  }

  // ===== Trigger Management Handlers =====

  private async handleTriggerRequest(
    method:
      | 'rr_v3.createTrigger'
      | 'rr_v3.updateTrigger'
      | 'rr_v3.deleteTrigger'
      | 'rr_v3.getTrigger'
      | 'rr_v3.listTriggers'
      | 'rr_v3.enableTrigger'
      | 'rr_v3.disableTrigger'
      | 'rr_v3.fireTrigger',
    params: JsonObject | undefined,
  ): Promise<JsonValue> {
    if (!ENABLE_V3_TRIGGERS_AND_SCHEDULES) {
      if (method === 'rr_v3.listTriggers') {
        return [] as unknown as JsonValue;
      }
      if (method === 'rr_v3.getTrigger') {
        return null;
      }
      throw new Error(TRIGGER_SURFACE_DISABLED_ERROR);
    }

    switch (method) {
      case 'rr_v3.createTrigger':
        return this.handleCreateTrigger(params);
      case 'rr_v3.updateTrigger':
        return this.handleUpdateTrigger(params);
      case 'rr_v3.deleteTrigger':
        return this.handleDeleteTrigger(params);
      case 'rr_v3.getTrigger':
        return this.handleGetTrigger(params);
      case 'rr_v3.listTriggers':
        return this.handleListTriggers(params);
      case 'rr_v3.enableTrigger':
        return this.handleEnableTrigger(params);
      case 'rr_v3.disableTrigger':
        return this.handleDisableTrigger(params);
      case 'rr_v3.fireTrigger':
        return this.handleFireTrigger(params);
      default:
        throw new Error(`Unknown trigger method: ${method}`);
    }
  }

  private requireTriggerManager(): TriggerManager {
    if (!this.triggerManager) {
      throw new Error('TriggerManager not configured');
    }
    return this.triggerManager;
  }

  private async handleCreateTrigger(params: JsonObject | undefined): Promise<JsonValue> {
    const trigger = this.normalizeTriggerSpec(params?.trigger, { requireId: false });

    const existing = await this.storage.triggers.get(trigger.id);
    if (existing) {
      throw new Error(`Trigger "${trigger.id}" already exists`);
    }

    const flow = await this.storage.flows.get(trigger.flowId);
    if (!flow) {
      throw new Error(`Flow "${trigger.flowId}" not found`);
    }

    await this.storage.triggers.save(trigger);
    await this.requireTriggerManager().refresh();
    return trigger as unknown as JsonValue;
  }

  private async handleUpdateTrigger(params: JsonObject | undefined): Promise<JsonValue> {
    const trigger = this.normalizeTriggerSpec(params?.trigger, { requireId: true });

    const existing = await this.storage.triggers.get(trigger.id);
    if (!existing) {
      throw new Error(`Trigger "${trigger.id}" not found`);
    }

    const flow = await this.storage.flows.get(trigger.flowId);
    if (!flow) {
      throw new Error(`Flow "${trigger.flowId}" not found`);
    }

    await this.storage.triggers.save(trigger);
    await this.requireTriggerManager().refresh();
    return trigger as unknown as JsonValue;
  }

  private async handleDeleteTrigger(params: JsonObject | undefined): Promise<JsonValue> {
    const triggerId = params?.triggerId as TriggerId | undefined;
    if (!triggerId) throw new Error('triggerId is required');

    await this.storage.triggers.delete(triggerId);
    await this.requireTriggerManager().refresh();
    return { ok: true, triggerId };
  }

  private async handleGetTrigger(params: JsonObject | undefined): Promise<JsonValue> {
    const triggerId = params?.triggerId as TriggerId | undefined;
    if (!triggerId) throw new Error('triggerId is required');
    const trigger = await this.storage.triggers.get(triggerId);
    return trigger as unknown as JsonValue;
  }

  private async handleListTriggers(params: JsonObject | undefined): Promise<JsonValue> {
    const flowIdValue = params?.flowId;
    let flowId: FlowId | undefined;
    if (flowIdValue !== undefined && flowIdValue !== null) {
      if (typeof flowIdValue !== 'string') {
        throw new Error('flowId must be a string');
      }
      flowId = flowIdValue as FlowId;
    }

    const triggers = await this.storage.triggers.list();
    const filtered = flowId ? triggers.filter((t) => t.flowId === flowId) : triggers;
    return filtered as unknown as JsonValue;
  }

  private async handleEnableTrigger(params: JsonObject | undefined): Promise<JsonValue> {
    const triggerId = params?.triggerId as TriggerId | undefined;
    if (!triggerId) throw new Error('triggerId is required');

    const trigger = await this.storage.triggers.get(triggerId);
    if (!trigger) {
      throw new Error(`Trigger "${triggerId}" not found`);
    }

    const updated: TriggerSpec = { ...trigger, enabled: true };
    await this.storage.triggers.save(updated);
    await this.requireTriggerManager().refresh();
    return updated as unknown as JsonValue;
  }

  private async handleDisableTrigger(params: JsonObject | undefined): Promise<JsonValue> {
    const triggerId = params?.triggerId as TriggerId | undefined;
    if (!triggerId) throw new Error('triggerId is required');

    const trigger = await this.storage.triggers.get(triggerId);
    if (!trigger) {
      throw new Error(`Trigger "${triggerId}" not found`);
    }

    const updated: TriggerSpec = { ...trigger, enabled: false };
    await this.storage.triggers.save(updated);
    await this.requireTriggerManager().refresh();
    return updated as unknown as JsonValue;
  }

  private async handleFireTrigger(params: JsonObject | undefined): Promise<JsonValue> {
    const triggerId = params?.triggerId as TriggerId | undefined;
    if (!triggerId) throw new Error('triggerId is required');

    const trigger = await this.storage.triggers.get(triggerId);
    if (!trigger) {
      throw new Error(`Trigger "${triggerId}" not found`);
    }
    if (trigger.kind !== 'manual') {
      throw new Error(`fireTrigger only supports manual triggers (got kind="${trigger.kind}")`);
    }
    if (!trigger.enabled) {
      throw new Error(`Trigger "${triggerId}" is disabled`);
    }

    let sourceTabId: number | undefined;
    if (params?.sourceTabId !== undefined && params?.sourceTabId !== null) {
      if (typeof params.sourceTabId !== 'number' || !Number.isFinite(params.sourceTabId)) {
        throw new Error('sourceTabId must be a finite number');
      }
      sourceTabId = Math.floor(params.sourceTabId);
    }

    let sourceUrl: string | undefined;
    if (params?.sourceUrl !== undefined && params?.sourceUrl !== null) {
      if (typeof params.sourceUrl !== 'string') {
        throw new Error('sourceUrl must be a string');
      }
      sourceUrl = params.sourceUrl;
    }

    const result = await this.requireTriggerManager().fire(triggerId, {
      sourceTabId,
      sourceUrl,
    });
    return result as unknown as JsonValue;
  }

  /**
   * Normalize TriggerSpec input
   */
  private normalizeTriggerSpec(value: unknown, opts: { requireId: boolean }): TriggerSpec {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('trigger is required');
    }
    const raw = value as JsonObject;

    // kind Verification
    const kind = raw.kind;
    if (!kind || typeof kind !== 'string') {
      throw new Error('trigger.kind is required');
    }

    // flowId Verification
    const flowId = raw.flowId;
    if (!flowId || typeof flowId !== 'string') {
      throw new Error('trigger.flowId is required');
    }

    // id Verification
    let id: TriggerId;
    if (raw.id === undefined || raw.id === null) {
      if (opts.requireId) {
        throw new Error('trigger.id is required');
      }
      id = `trg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` as TriggerId;
    } else {
      if (typeof raw.id !== 'string' || !raw.id.trim()) {
        throw new Error('trigger.id must be a non-empty string');
      }
      id = raw.id as TriggerId;
    }

    // enabled Verification
    let enabled = true;
    if (raw.enabled !== undefined && raw.enabled !== null) {
      if (typeof raw.enabled !== 'boolean') {
        throw new Error('trigger.enabled must be a boolean');
      }
      enabled = raw.enabled;
    }

    // args Verification
    let args: JsonObject | undefined;
    if (raw.args !== undefined && raw.args !== null) {
      if (typeof raw.args !== 'object' || Array.isArray(raw.args)) {
        throw new Error('trigger.args must be an object');
      }
      args = raw.args as JsonObject;
    }

    // Basic fields
    const base = { id, kind: kind as TriggerKind, enabled, flowId: flowId as FlowId, args };

    // Add specific fields based on kind
    switch (kind) {
      case 'manual':
        return base as TriggerSpec;

      case 'url': {
        let match: unknown[] = [];
        if (raw.match !== undefined && raw.match !== null) {
          if (!Array.isArray(raw.match)) {
            throw new Error('trigger.match must be an array');
          }
          match = raw.match;
        }
        return { ...base, match } as TriggerSpec;
      }

      case 'cron': {
        if (!raw.cron || typeof raw.cron !== 'string') {
          throw new Error('trigger.cron is required for cron triggers');
        }
        let timezone: string | undefined;
        if (raw.timezone !== undefined && raw.timezone !== null) {
          if (typeof raw.timezone !== 'string') {
            throw new Error('trigger.timezone must be a string');
          }
          timezone = raw.timezone.trim() || undefined;
        }
        return { ...base, cron: raw.cron, timezone } as TriggerSpec;
      }

      case 'interval': {
        if (raw.periodMinutes === undefined || raw.periodMinutes === null) {
          throw new Error('trigger.periodMinutes is required for interval triggers');
        }
        if (typeof raw.periodMinutes !== 'number' || !Number.isFinite(raw.periodMinutes)) {
          throw new Error('trigger.periodMinutes must be a finite number');
        }
        if (raw.periodMinutes < 1) {
          throw new Error('trigger.periodMinutes must be >= 1');
        }
        return { ...base, periodMinutes: raw.periodMinutes } as TriggerSpec;
      }

      case 'once': {
        if (raw.whenMs === undefined || raw.whenMs === null) {
          throw new Error('trigger.whenMs is required for once triggers');
        }
        if (typeof raw.whenMs !== 'number' || !Number.isFinite(raw.whenMs)) {
          throw new Error('trigger.whenMs must be a finite number');
        }
        return { ...base, whenMs: Math.floor(raw.whenMs) } as TriggerSpec;
      }

      case 'command': {
        if (!raw.commandKey || typeof raw.commandKey !== 'string') {
          throw new Error('trigger.commandKey is required for command triggers');
        }
        return { ...base, commandKey: raw.commandKey } as TriggerSpec;
      }

      case 'contextMenu': {
        if (!raw.title || typeof raw.title !== 'string') {
          throw new Error('trigger.title is required for contextMenu triggers');
        }
        let contexts: string[] | undefined;
        if (raw.contexts !== undefined && raw.contexts !== null) {
          if (!Array.isArray(raw.contexts) || !raw.contexts.every((c) => typeof c === 'string')) {
            throw new Error('trigger.contexts must be an array of strings');
          }
          contexts = raw.contexts as string[];
        }
        return { ...base, title: raw.title, contexts } as TriggerSpec;
      }

      case 'dom': {
        if (!raw.selector || typeof raw.selector !== 'string') {
          throw new Error('trigger.selector is required for dom triggers');
        }
        let appear: boolean | undefined;
        if (raw.appear !== undefined && raw.appear !== null) {
          if (typeof raw.appear !== 'boolean') {
            throw new Error('trigger.appear must be a boolean');
          }
          appear = raw.appear;
        }
        let once: boolean | undefined;
        if (raw.once !== undefined && raw.once !== null) {
          if (typeof raw.once !== 'boolean') {
            throw new Error('trigger.once must be a boolean');
          }
          once = raw.once;
        }
        let debounceMs: number | undefined;
        if (raw.debounceMs !== undefined && raw.debounceMs !== null) {
          if (typeof raw.debounceMs !== 'number' || !Number.isFinite(raw.debounceMs)) {
            throw new Error('trigger.debounceMs must be a finite number');
          }
          debounceMs = raw.debounceMs;
        }
        return { ...base, selector: raw.selector, appear, once, debounceMs } as TriggerSpec;
      }

      default:
        throw new Error(
          `trigger.kind must be one of: manual, url, cron, interval, once, command, contextMenu, dom`,
        );
    }
  }

  // ===== Run Control Handlers =====

  private async handlePauseRun(params: JsonObject | undefined): Promise<JsonValue> {
    const runId = params?.runId as RunId | undefined;
    if (!runId) throw new Error('runId is required');

    if (!this.runners) {
      throw new Error('RunnerRegistry not configured');
    }

    const runner = this.runners.get(runId);
    if (!runner) {
      throw new Error(`Runner for "${runId}" not found (run may not be executing)`);
    }

    const queueItem = await this.storage.queue.get(runId);
    if (!queueItem) {
      throw new Error(`Queue item "${runId}" not found`);
    }
    if (queueItem.status === 'queued') {
      throw new Error(`Cannot pause run "${runId}" while status=queued`);
    }

    const ownerId = queueItem.lease?.ownerId;
    if (!ownerId) {
      throw new Error(`Queue item "${runId}" has no lease ownerId`);
    }

    const now = this.now();
    await this.storage.queue.markPaused(runId, ownerId, now);
    runner.pause();

    return { ok: true, runId };
  }

  private async handleResumeRun(params: JsonObject | undefined): Promise<JsonValue> {
    const runId = params?.runId as RunId | undefined;
    if (!runId) throw new Error('runId is required');

    if (!this.runners) {
      throw new Error('RunnerRegistry not configured');
    }

    const runner = this.runners.get(runId);
    if (!runner) {
      throw new Error(`Runner for "${runId}" not found (run may not be executing)`);
    }

    const queueItem = await this.storage.queue.get(runId);
    if (!queueItem) {
      throw new Error(`Queue item "${runId}" not found`);
    }
    if (queueItem.status !== 'paused') {
      throw new Error(`Cannot resume run "${runId}" with status=${queueItem.status}`);
    }

    const ownerId = queueItem.lease?.ownerId;
    if (!ownerId) {
      throw new Error(`Queue item "${runId}" has no lease ownerId`);
    }

    const now = this.now();
    await this.storage.queue.markRunning(runId, ownerId, now);
    runner.resume();

    return { ok: true, runId };
  }

  private async handleCancelRun(params: JsonObject | undefined): Promise<JsonValue> {
    const runId = params?.runId as RunId | undefined;
    if (!runId) throw new Error('runId is required');

    const reason = (params?.reason as string) ?? 'Canceled by user';
    const queueItem = await this.storage.queue.get(runId);

    // If still queued (not yet claimed), cancel via queue
    if (queueItem?.status === 'queued') {
      return this.handleCancelQueueItem({ runId, reason } as unknown as JsonObject);
    }

    // If running/paused, cancel via runner
    if (!this.runners) {
      throw new Error('RunnerRegistry not configured');
    }

    const runner = this.runners.get(runId);
    if (!runner) {
      // Run may have already finished
      throw new Error(`Runner for "${runId}" not found (run may have already finished)`);
    }

    runner.cancel(reason);
    return { ok: true, runId };
  }
}

/**
 * Create and start RPC Server
 */
export function createRpcServer(config: RpcServerConfig): RpcServer {
  const server = new RpcServer(config);
  server.start();
  return server;
}
