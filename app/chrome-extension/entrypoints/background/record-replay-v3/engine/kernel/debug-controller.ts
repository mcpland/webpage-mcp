/**
 * @fileoverview Debug Controller
 * @description Central control plane for debugging - command routing, state aggregation, and UI push
 */

import type { NodeId, RunId } from '../../domain/ids';
import type { JsonValue } from '../../domain/json';
import type { PauseReason, RunEvent, Unsubscribe } from '../../domain/events';
import type {
  DebuggerCommand,
  DebuggerResponse,
  DebuggerState,
  Breakpoint,
} from '../../domain/debug';
import { createInitialDebuggerState } from '../../domain/debug';

import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';
import type { RunRunner } from './runner';
import { BreakpointManager, getBreakpointRegistry } from './breakpoints';

/**
 * Runner registry for managing active runners
 */
export interface RunnerRegistry {
  get(runId: RunId): RunRunner | undefined;
  register(runId: RunId, runner: RunRunner): void;
  unregister(runId: RunId): void;
  list(): RunId[];
}

/**
 * Create a simple runner registry
 */
export function createRunnerRegistry(): RunnerRegistry {
  const runners = new Map<RunId, RunRunner>();
  return {
    get: (runId) => runners.get(runId),
    register: (runId, runner) => runners.set(runId, runner),
    unregister: (runId) => runners.delete(runId),
    list: () => Array.from(runners.keys()),
  };
}

/**
 * Debug session state (per-run)
 */
interface DebugSession {
  runId: RunId;
  attached: boolean;
  lastPauseReason?: PauseReason;
  lastKnownNodeId?: NodeId;
  lastKnownExecution: 'running' | 'paused';
}

/**
 * Debug state listener
 */
type DebugStateListener = (state: DebuggerState) => void;

/**
 * Debug Controller Configuration
 */
export interface DebugControllerConfig {
  storage: StoragePort;
  events: EventsBus;
  runners: RunnerRegistry;
}

/**
 * Debug Controller
 * @description Single entry point for all debug operations
 */
export class DebugController {
  private readonly storage: StoragePort;
  private readonly events: EventsBus;
  private readonly runners: RunnerRegistry;

  private readonly sessions = new Map<RunId, DebugSession>();
  private readonly listeners = new Map<RunId | null, Set<DebugStateListener>>();
  private eventUnsubscribe: Unsubscribe | null = null;

  constructor(config: DebugControllerConfig) {
    this.storage = config.storage;
    this.events = config.events;
    this.runners = config.runners;
  }

  /**
   * Start the debug controller
   */
  start(): void {
    // Subscribe to all events to track pause/resume state
    this.eventUnsubscribe = this.events.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  /**
   * Stop the debug controller
   */
  stop(): void {
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = null;
    }
    this.sessions.clear();
    this.listeners.clear();
  }

  /**
   * Handle a debug command
   */
  async handle(cmd: DebuggerCommand): Promise<DebuggerResponse> {
    try {
      switch (cmd.type) {
        case 'debug.attach':
          return this.handleAttach(cmd.runId);

        case 'debug.detach':
          return this.handleDetach(cmd.runId);

        case 'debug.pause':
          return this.handlePause(cmd.runId);

        case 'debug.resume':
          return this.handleResume(cmd.runId);

        case 'debug.stepOver':
          return this.handleStepOver(cmd.runId);

        case 'debug.setBreakpoints':
          return this.handleSetBreakpoints(cmd.runId, cmd.nodeIds);

        case 'debug.addBreakpoint':
          return this.handleAddBreakpoint(cmd.runId, cmd.nodeId);

        case 'debug.removeBreakpoint':
          return this.handleRemoveBreakpoint(cmd.runId, cmd.nodeId);

        case 'debug.getState':
          return this.handleGetState(cmd.runId);

        case 'debug.getVar':
          return this.handleGetVar(cmd.runId, cmd.name);

        case 'debug.setVar':
          return this.handleSetVar(cmd.runId, cmd.name, cmd.value);

        default:
          return { ok: false, error: `Unknown debug command: ${(cmd as { type: string }).type}` };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  }

  /**
   * Subscribe to debug state changes
   */
  subscribe(listener: DebugStateListener, filter?: { runId?: RunId }): Unsubscribe {
    const key = filter?.runId ?? null;
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);

    return () => {
      set?.delete(listener);
      if (set?.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  /**
   * Get current debug state for a run
   */
  async getState(runId: RunId): Promise<DebuggerState> {
    const session = this.sessions.get(runId);
    const run = await this.storage.runs.get(runId);
    const bpManager = getBreakpointRegistry().get(runId);

    const state: DebuggerState = {
      runId,
      status: session?.attached ? 'attached' : 'detached',
      execution: session?.lastKnownExecution ?? (run?.status === 'paused' ? 'paused' : 'running'),
      pauseReason: session?.lastPauseReason,
      currentNodeId: session?.lastKnownNodeId ?? run?.currentNodeId,
      breakpoints: bpManager?.getAll() ?? [],
      stepMode: bpManager?.getStepMode() ?? 'none',
    };

    return state;
  }

  // ==================== Command Handlers ====================

  private async handleAttach(runId: RunId): Promise<DebuggerResponse> {
    const run = await this.storage.runs.get(runId);
    if (!run) {
      return { ok: false, error: `Run "${runId}" not found` };
    }

    // Create or update session
    let session = this.sessions.get(runId);
    if (!session) {
      session = {
        runId,
        attached: true,
        lastKnownExecution: run.status === 'paused' ? 'paused' : 'running',
        lastKnownNodeId: run.currentNodeId,
      };
      this.sessions.set(runId, session);
    } else {
      session.attached = true;
    }

    // Get or create breakpoint manager
    getBreakpointRegistry().getOrCreate(runId, run.debug?.breakpoints);

    const state = await this.getState(runId);
    this.notifyStateChange(runId, state);
    return { ok: true, state };
  }

  private async handleDetach(runId: RunId): Promise<DebuggerResponse> {
    const session = this.sessions.get(runId);
    if (session) {
      session.attached = false;
    }

    const state = await this.getState(runId);
    this.notifyStateChange(runId, state);
    return { ok: true, state };
  }

  private async handlePause(runId: RunId): Promise<DebuggerResponse> {
    const runner = this.runners.get(runId);
    if (!runner) {
      return { ok: false, error: `Runner for "${runId}" not found` };
    }

    runner.pause();
    const state = await this.getState(runId);
    return { ok: true, state };
  }

  private async handleResume(runId: RunId): Promise<DebuggerResponse> {
    const runner = this.runners.get(runId);
    if (!runner) {
      return { ok: false, error: `Runner for "${runId}" not found` };
    }

    runner.resume();
    const state = await this.getState(runId);
    return { ok: true, state };
  }

  private async handleStepOver(runId: RunId): Promise<DebuggerResponse> {
    const runner = this.runners.get(runId);
    if (!runner) {
      return { ok: false, error: `Runner for "${runId}" not found` };
    }

    // Set step mode to stepOver (will pause at next node)
    const bpManager = getBreakpointRegistry().getOrCreate(runId);
    bpManager.setStepMode('stepOver');

    // Resume execution - runner will pause at next node due to stepOver mode
    runner.resume();

    const state = await this.getState(runId);
    return { ok: true, state };
  }

  private async handleSetBreakpoints(runId: RunId, nodeIds: NodeId[]): Promise<DebuggerResponse> {
    const bpManager = getBreakpointRegistry().getOrCreate(runId);
    bpManager.setAll(nodeIds);

    // Persist breakpoints to run record
    await this.persistBreakpoints(runId, bpManager);

    const state = await this.getState(runId);
    this.notifyStateChange(runId, state);
    return { ok: true, state };
  }

  private async handleAddBreakpoint(runId: RunId, nodeId: NodeId): Promise<DebuggerResponse> {
    const bpManager = getBreakpointRegistry().getOrCreate(runId);
    bpManager.add(nodeId);

    await this.persistBreakpoints(runId, bpManager);

    const state = await this.getState(runId);
    this.notifyStateChange(runId, state);
    return { ok: true, state };
  }

  private async handleRemoveBreakpoint(runId: RunId, nodeId: NodeId): Promise<DebuggerResponse> {
    const bpManager = getBreakpointRegistry().getOrCreate(runId);
    bpManager.remove(nodeId);

    await this.persistBreakpoints(runId, bpManager);

    const state = await this.getState(runId);
    this.notifyStateChange(runId, state);
    return { ok: true, state };
  }

  private async handleGetState(runId: RunId): Promise<DebuggerResponse> {
    const state = await this.getState(runId);
    return { ok: true, state };
  }

  private async handleGetVar(runId: RunId, name: string): Promise<DebuggerResponse> {
    // Try to get from active runner first
    const runner = this.runners.get(runId);
    if (runner) {
      const value = runner.getVar(name);
      return { ok: true, value: value ?? null };
    }

    // Fallback: reconstruct from events
    const value = await this.reconstructVar(runId, name);
    return { ok: true, value: value ?? null };
  }

  private async handleSetVar(
    runId: RunId,
    name: string,
    value: JsonValue,
  ): Promise<DebuggerResponse> {
    const runner = this.runners.get(runId);
    if (!runner) {
      return {
        ok: false,
        error: `Runner for "${runId}" not found - cannot set variable on inactive run`,
      };
    }

    runner.setVar(name, value);
    return { ok: true };
  }

  // ==================== Event Handling ====================

  private handleEvent(event: RunEvent): void {
    const { runId } = event;
    let session = this.sessions.get(runId);

    // Track pause/resume state
    if (event.type === 'run.paused') {
      if (!session) {
        session = {
          runId,
          attached: false,
          lastKnownExecution: 'paused',
        };
        this.sessions.set(runId, session);
      }
      session.lastKnownExecution = 'paused';
      session.lastPauseReason = event.reason;
      session.lastKnownNodeId = event.nodeId;
    } else if (event.type === 'run.resumed') {
      if (session) {
        session.lastKnownExecution = 'running';
        session.lastPauseReason = undefined;
      }
    } else if (event.type === 'run.started') {
      if (!session) {
        session = {
          runId,
          attached: false,
          lastKnownExecution: 'running',
        };
        this.sessions.set(runId, session);
      }
    } else if (
      event.type === 'run.succeeded' ||
      event.type === 'run.failed' ||
      event.type === 'run.canceled'
    ) {
      // Run ended - keep session for querying but mark as not running
      if (session) {
        session.lastKnownExecution = 'running'; // Technically ended, but not paused
      }
    } else if (event.type === 'node.started') {
      if (session) {
        session.lastKnownNodeId = event.nodeId;
      }
    }

    // Notify listeners if session is attached
    if (session?.attached) {
      void this.getState(runId).then((state) => {
        this.notifyStateChange(runId, state);
      });
    }
  }

  // ==================== Helpers ====================

  private async persistBreakpoints(runId: RunId, bpManager: BreakpointManager): Promise<void> {
    const breakpoints = bpManager.getEnabled().map((bp) => bp.nodeId);
    try {
      await this.storage.runs.patch(runId, {
        debug: { breakpoints },
      });
    } catch {
      // Run may not exist yet - ignore persistence error
    }
  }

  private async reconstructVar(runId: RunId, name: string): Promise<JsonValue | undefined> {
    // Get flow and run to reconstruct initial vars
    const run = await this.storage.runs.get(runId);
    if (!run) return undefined;

    const flow = await this.storage.flows.get(run.flowId);
    if (!flow) return undefined;

    // Build initial vars
    const vars: Record<string, JsonValue> = { ...(run.args ?? {}) };
    for (const def of flow.variables ?? []) {
      if (vars[def.name] === undefined && def.default !== undefined) {
        vars[def.name] = def.default;
      }
    }

    // Apply all vars.patch events
    const events = await this.storage.events.list(runId);
    for (const event of events) {
      if (event.type === 'vars.patch') {
        for (const op of event.patch) {
          if (op.op === 'set') {
            vars[op.name] = op.value ?? null;
          } else {
            delete vars[op.name];
          }
        }
      }
    }

    return vars[name];
  }

  private notifyStateChange(runId: RunId, state: DebuggerState): void {
    // Notify specific run listeners
    const runListeners = this.listeners.get(runId);
    if (runListeners) {
      for (const listener of runListeners) {
        try {
          listener(state);
        } catch (e) {
          console.error('[DebugController] Listener error:', e);
        }
      }
    }

    // Notify global listeners
    const globalListeners = this.listeners.get(null);
    if (globalListeners) {
      for (const listener of globalListeners) {
        try {
          listener(state);
        } catch (e) {
          console.error('[DebugController] Listener error:', e);
        }
      }
    }
  }
}

/**
 * Create and start a debug controller
 */
export function createDebugController(config: DebugControllerConfig): DebugController {
  const controller = new DebugController(config);
  controller.start();
  return controller;
}
