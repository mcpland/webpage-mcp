/**
 * Test helpers for record-replay contract tests.
 *
 * Provides minimal factories and mocks for testing the execution pipeline
 * without requiring real browser or tool dependencies.
 */

import { vi } from 'vitest';
import type { ExecCtx } from '@/entrypoints/background/record-replay/nodes/types';
import type { ActionExecutionContext } from '@/entrypoints/background/record-replay/actions/types';

/**
 * Create a minimal ExecCtx for testing
 */
export function createMockExecCtx(overrides: Partial<ExecCtx> = {}): ExecCtx {
  return {
    vars: {},
    logger: vi.fn(),
    ...overrides,
  };
}

/**
 * Create a minimal ActionExecutionContext for testing
 */
export function createMockActionCtx(
  overrides: Partial<ActionExecutionContext> = {},
): ActionExecutionContext {
  return {
    vars: {},
    tabId: 1,
    log: vi.fn(),
    ...overrides,
  };
}

/**
 * Create a minimal Step for testing
 */
export function createMockStep(type: string, overrides: Record<string, unknown> = {}): any {
  return {
    id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    ...overrides,
  };
}

/**
 * Create a minimal Flow for testing (with nodes/edges for scheduler)
 */
export function createMockFlow(overrides: Record<string, unknown> = {}): any {
  const id = `flow_${Date.now()}`;
  return {
    id,
    name: 'Test Flow',
    version: 1,
    steps: [],
    nodes: [],
    edges: [],
    variables: [],
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

/**
 * Create a mock ActionRegistry for testing
 */
export function createMockRegistry(handlers: Map<string, any> = new Map()) {
  const executeFn = vi.fn(async () => ({ status: 'success' as const }));

  return {
    get: vi.fn((type: string) => handlers.get(type) || { type }),
    execute: executeFn,
    register: vi.fn(),
    has: vi.fn((type: string) => handlers.has(type)),
    _executeFn: executeFn, // Expose for assertions
  };
}
