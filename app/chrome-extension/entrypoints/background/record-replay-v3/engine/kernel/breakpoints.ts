/**
 * @fileoverview breakpoint manager
 * @description Manage the addition, deletion and hit detection of debug breakpoints
 */

import type { NodeId, RunId } from '../../domain/ids';
import type { Breakpoint, DebuggerState } from '../../domain/debug';

/**
 * breakpoint manager
 * @description Manage breakpoints for a single Run
 */
export class BreakpointManager {
  private breakpoints = new Map<NodeId, Breakpoint>();
  private stepMode: 'none' | 'stepOver' = 'none';

  constructor(initialBreakpoints?: NodeId[]) {
    if (initialBreakpoints) {
      for (const nodeId of initialBreakpoints) {
        this.add(nodeId);
      }
    }
  }

  /**
   * Add breakpoint
   */
  add(nodeId: NodeId): void {
    this.breakpoints.set(nodeId, { nodeId, enabled: true });
  }

  /**
   * Delete breakpoint
   */
  remove(nodeId: NodeId): void {
    this.breakpoints.delete(nodeId);
  }

  /**
   * Set breakpoint list (replaces all existing breakpoints)
   */
  setAll(nodeIds: NodeId[]): void {
    this.breakpoints.clear();
    for (const nodeId of nodeIds) {
      this.add(nodeId);
    }
  }

  /**
   * Enable breakpoints
   */
  enable(nodeId: NodeId): void {
    const bp = this.breakpoints.get(nodeId);
    if (bp) {
      bp.enabled = true;
    }
  }

  /**
   * Disable breakpoints
   */
  disable(nodeId: NodeId): void {
    const bp = this.breakpoints.get(nodeId);
    if (bp) {
      bp.enabled = false;
    }
  }

  /**
   * Check if the node has breakpoints enabled
   */
  hasBreakpoint(nodeId: NodeId): boolean {
    const bp = this.breakpoints.get(nodeId);
    return bp?.enabled ?? false;
  }

  /**
   * Check if it should be paused at a node
   * @description Consider breakpoints and single-step mode
   */
  shouldPauseAt(nodeId: NodeId): boolean {
    // If in single-step mode, always pause
    if (this.stepMode === 'stepOver') {
      return true;
    }
    // Otherwise check breakpoint
    return this.hasBreakpoint(nodeId);
  }

  /**
   * Get all breakpoints
   */
  getAll(): Breakpoint[] {
    return Array.from(this.breakpoints.values());
  }

  /**
   * Get enabled breakpoints
   */
  getEnabled(): Breakpoint[] {
    return this.getAll().filter((bp) => bp.enabled);
  }

  /**
   * Set single step mode
   */
  setStepMode(mode: 'none' | 'stepOver'): void {
    this.stepMode = mode;
  }

  /**
   * Get single step mode
   */
  getStepMode(): 'none' | 'stepOver' {
    return this.stepMode;
  }

  /**
   * Clear all breakpoints
   */
  clear(): void {
    this.breakpoints.clear();
    this.stepMode = 'none';
  }
}

/**
 * Breakpoint Manager Registry
 * @description Breakpoint manager to manage multiple Runs
 */
export class BreakpointRegistry {
  private managers = new Map<RunId, BreakpointManager>();

  /**
   * Get or create a breakpoint manager
   */
  getOrCreate(runId: RunId, initialBreakpoints?: NodeId[]): BreakpointManager {
    let manager = this.managers.get(runId);
    if (!manager) {
      manager = new BreakpointManager(initialBreakpoints);
      this.managers.set(runId, manager);
    }
    return manager;
  }

  /**
   * Get breakpoint manager
   */
  get(runId: RunId): BreakpointManager | undefined {
    return this.managers.get(runId);
  }

  /**
   * Remove breakpoint manager
   */
  remove(runId: RunId): void {
    this.managers.delete(runId);
  }

  /**
   * Clear all
   */
  clear(): void {
    this.managers.clear();
  }
}

/** Global breakpoint registry */
let globalBreakpointRegistry: BreakpointRegistry | null = null;

/**
 * Get the global breakpoint registry
 */
export function getBreakpointRegistry(): BreakpointRegistry {
  if (!globalBreakpointRegistry) {
    globalBreakpointRegistry = new BreakpointRegistry();
  }
  return globalBreakpointRegistry;
}

/**
 * Reset global breakpoint registry
 * @description Mainly used for testing
 */
export function resetBreakpointRegistry(): void {
  globalBreakpointRegistry = null;
}
