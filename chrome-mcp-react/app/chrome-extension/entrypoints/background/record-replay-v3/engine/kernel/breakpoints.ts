/**
 * @fileoverview 断点管理器
 * @description 管理调试断点的添加、删除和命中检测
 */

import type { NodeId, RunId } from '../../domain/ids';
import type { Breakpoint, DebuggerState } from '../../domain/debug';

/**
 * 断点管理器
 * @description 管理单个 Run 的断点
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
   * 添加断点
   */
  add(nodeId: NodeId): void {
    this.breakpoints.set(nodeId, { nodeId, enabled: true });
  }

  /**
   * 删除断点
   */
  remove(nodeId: NodeId): void {
    this.breakpoints.delete(nodeId);
  }

  /**
   * 设置断点列表（替换所有现有断点）
   */
  setAll(nodeIds: NodeId[]): void {
    this.breakpoints.clear();
    for (const nodeId of nodeIds) {
      this.add(nodeId);
    }
  }

  /**
   * 启用断点
   */
  enable(nodeId: NodeId): void {
    const bp = this.breakpoints.get(nodeId);
    if (bp) {
      bp.enabled = true;
    }
  }

  /**
   * 禁用断点
   */
  disable(nodeId: NodeId): void {
    const bp = this.breakpoints.get(nodeId);
    if (bp) {
      bp.enabled = false;
    }
  }

  /**
   * 检查节点是否有启用的断点
   */
  hasBreakpoint(nodeId: NodeId): boolean {
    const bp = this.breakpoints.get(nodeId);
    return bp?.enabled ?? false;
  }

  /**
   * 检查是否应该在节点处暂停
   * @description 考虑断点和单步模式
   */
  shouldPauseAt(nodeId: NodeId): boolean {
    // 如果在单步模式，总是暂停
    if (this.stepMode === 'stepOver') {
      return true;
    }
    // 否则检查断点
    return this.hasBreakpoint(nodeId);
  }

  /**
   * 获取所有断点
   */
  getAll(): Breakpoint[] {
    return Array.from(this.breakpoints.values());
  }

  /**
   * 获取启用的断点
   */
  getEnabled(): Breakpoint[] {
    return this.getAll().filter((bp) => bp.enabled);
  }

  /**
   * 设置单步模式
   */
  setStepMode(mode: 'none' | 'stepOver'): void {
    this.stepMode = mode;
  }

  /**
   * 获取单步模式
   */
  getStepMode(): 'none' | 'stepOver' {
    return this.stepMode;
  }

  /**
   * 清除所有断点
   */
  clear(): void {
    this.breakpoints.clear();
    this.stepMode = 'none';
  }
}

/**
 * 断点管理器注册表
 * @description 管理多个 Run 的断点管理器
 */
export class BreakpointRegistry {
  private managers = new Map<RunId, BreakpointManager>();

  /**
   * 获取或创建断点管理器
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
   * 获取断点管理器
   */
  get(runId: RunId): BreakpointManager | undefined {
    return this.managers.get(runId);
  }

  /**
   * 删除断点管理器
   */
  remove(runId: RunId): void {
    this.managers.delete(runId);
  }

  /**
   * 清空所有
   */
  clear(): void {
    this.managers.clear();
  }
}

/** 全局断点注册表 */
let globalBreakpointRegistry: BreakpointRegistry | null = null;

/**
 * 获取全局断点注册表
 */
export function getBreakpointRegistry(): BreakpointRegistry {
  if (!globalBreakpointRegistry) {
    globalBreakpointRegistry = new BreakpointRegistry();
  }
  return globalBreakpointRegistry;
}

/**
 * 重置全局断点注册表
 * @description 主要用于测试
 */
export function resetBreakpointRegistry(): void {
  globalBreakpointRegistry = null;
}
