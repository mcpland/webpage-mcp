/**
 * Session DAG Sync Contract Tests
 *
 * Verifies that RecordingSessionManager correctly maintains flow.nodes/edges
 * during recording:
 * - New step → create node + edge from previous node
 * - Upsert step → update node.config and node.type
 * - Invariant violation → fallback to linear DAG rebuild
 *
 * Note: flow.steps is no longer written. Nodes are the source of truth.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { RecordingSessionManager } from '@/entrypoints/background/record-replay/recording/session-manager';
import type { Flow, Step } from '@/entrypoints/background/record-replay/types';

function createTestFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: `test_flow_${Date.now()}`,
    name: 'Test Flow',
    version: 1,
    steps: [],
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function createTestStep(type: string, id?: string, overrides: Record<string, unknown> = {}): Step {
  return {
    id: id || `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    ...overrides,
  } as Step;
}

describe('RecordingSessionManager DAG sync', () => {
  let manager: RecordingSessionManager;

  beforeEach(async () => {
    manager = new RecordingSessionManager();
  });

  describe('appendSteps creates nodes/edges', () => {
    it('creates node for first step without edge', async () => {
      const flow = createTestFlow();
      await manager.startSession(flow, 1);

      manager.appendSteps([createTestStep('click', 'step1')]);

      const f = manager.getFlow()!;
      expect(f.nodes).toHaveLength(1);
      expect(f.nodes![0].id).toBe('step1');
      expect(f.nodes![0].type).toBe('click');
      expect(f.edges).toHaveLength(0); // No edge for first step
    });

    it('creates node and edge for subsequent steps', async () => {
      const flow = createTestFlow();
      await manager.startSession(flow, 1);

      manager.appendSteps([createTestStep('click', 'step1')]);
      manager.appendSteps([createTestStep('fill', 'step2', { value: 'hello' })]);

      const f = manager.getFlow()!;
      expect(f.nodes).toHaveLength(2);
      expect(f.nodes![1].id).toBe('step2');
      expect(f.nodes![1].type).toBe('fill');

      expect(f.edges).toHaveLength(1);
      expect(f.edges![0].from).toBe('step1');
      expect(f.edges![0].to).toBe('step2');
    });

    it('creates correct chain for multiple steps in single batch', async () => {
      const flow = createTestFlow();
      await manager.startSession(flow, 1);

      manager.appendSteps([
        createTestStep('navigate', 'step1', { url: 'https://example.com' }),
        createTestStep('click', 'step2'),
        createTestStep('fill', 'step3', { value: 'test' }),
      ]);

      const f = manager.getFlow()!;
      // Note: flow.steps is no longer written, nodes are the source of truth
      expect(f.nodes).toHaveLength(3);
      expect(f.edges).toHaveLength(2);

      // Verify chain: step1 → step2 → step3
      expect(f.edges![0].from).toBe('step1');
      expect(f.edges![0].to).toBe('step2');
      expect(f.edges![1].from).toBe('step2');
      expect(f.edges![1].to).toBe('step3');
    });
  });

  describe('upsert updates node config', () => {
    it('updates node config when step is upserted', async () => {
      const flow = createTestFlow();
      await manager.startSession(flow, 1);

      // Initial step
      manager.appendSteps([createTestStep('fill', 'step1', { value: 'initial' })]);

      // Upsert with new value
      manager.appendSteps([createTestStep('fill', 'step1', { value: 'updated' })]);

      const f = manager.getFlow()!;
      // Note: flow.steps is no longer written, nodes are the source of truth
      expect(f.nodes).toHaveLength(1);
      expect(f.nodes![0].config?.value).toBe('updated');
    });

    it('preserves edges when upserting', async () => {
      const flow = createTestFlow();
      await manager.startSession(flow, 1);

      manager.appendSteps([
        createTestStep('click', 'step1'),
        createTestStep('fill', 'step2', { value: 'initial' }),
      ]);

      // Upsert step2
      manager.appendSteps([createTestStep('fill', 'step2', { value: 'updated' })]);

      const f = manager.getFlow()!;
      expect(f.edges).toHaveLength(1);
      expect(f.edges![0].from).toBe('step1');
      expect(f.edges![0].to).toBe('step2');
    });
  });

  describe('invariant handling', () => {
    it('rebuilds DAG from legacy steps when nodes missing', async () => {
      // Create flow with steps but no nodes (legacy scenario)
      const flow = createTestFlow({
        steps: [
          { id: 'existing1', type: 'click' } as any,
          { id: 'existing2', type: 'fill', value: 'test' } as any,
        ],
        nodes: undefined,
        edges: undefined,
      });
      await manager.startSession(flow, 1);

      // Append new step - should trigger rebuild from legacy steps first
      manager.appendSteps([createTestStep('navigate', 'step3', { url: 'https://test.com' })]);

      const f = manager.getFlow()!;
      // Should have rebuilt: 2 existing (from legacy steps) + 1 new = 3
      expect(f.nodes).toHaveLength(3);
      expect(f.edges).toHaveLength(2);
    });

    it('handles empty flow gracefully', async () => {
      const flow = createTestFlow();
      await manager.startSession(flow, 1);

      // Empty appendSteps should be no-op
      manager.appendSteps([]);

      const f = manager.getFlow()!;
      // nodes/edges may be undefined when no steps added, that's valid
      expect(f.nodes?.length ?? 0).toBe(0);
      expect(f.edges?.length ?? 0).toBe(0);
    });
  });

  describe('session lifecycle', () => {
    it('clears caches on session stop', async () => {
      const flow = createTestFlow();
      await manager.startSession(flow, 1);

      manager.appendSteps([createTestStep('click', 'step1')]);

      const stoppedFlow = await manager.stopSession();

      expect(stoppedFlow).not.toBeNull();
      expect(stoppedFlow!.nodes).toHaveLength(1);

      // After stop, manager should have no flow
      expect(manager.getFlow()).toBeNull();
    });

    it('reinitializes caches on new session', async () => {
      // First session
      const flow1 = createTestFlow({ id: 'flow1' });
      await manager.startSession(flow1, 1);
      manager.appendSteps([createTestStep('click', 'step1')]);
      await manager.stopSession();

      // Second session - should have fresh state
      const flow2 = createTestFlow({ id: 'flow2' });
      await manager.startSession(flow2, 2);
      manager.appendSteps([createTestStep('fill', 'step2')]);

      const f = manager.getFlow()!;
      expect(f.id).toBe('flow2');
      // Note: flow.steps is no longer written, nodes are the source of truth
      expect(f.nodes).toHaveLength(1);
      expect(f.nodes![0].id).toBe('step2');
    });
  });

  describe('node type conversion', () => {
    it('converts valid step types to node types', async () => {
      const flow = createTestFlow();
      await manager.startSession(flow, 1);

      manager.appendSteps([
        createTestStep('click', 'step1'),
        createTestStep('fill', 'step2'),
        createTestStep('navigate', 'step3'),
        createTestStep('scroll', 'step4'),
      ]);

      const f = manager.getFlow()!;
      expect(f.nodes![0].type).toBe('click');
      expect(f.nodes![1].type).toBe('fill');
      expect(f.nodes![2].type).toBe('navigate');
      expect(f.nodes![3].type).toBe('scroll');
    });

    it('falls back to script for unknown types', async () => {
      const flow = createTestFlow();
      await manager.startSession(flow, 1);

      manager.appendSteps([createTestStep('unknown_type_xyz', 'step1')]);

      const f = manager.getFlow()!;
      expect(f.nodes![0].type).toBe('script');
    });
  });

  describe('edge id uniqueness', () => {
    it('generates unique edge ids', async () => {
      const flow = createTestFlow();
      await manager.startSession(flow, 1);

      manager.appendSteps([
        createTestStep('click', 's1'),
        createTestStep('click', 's2'),
        createTestStep('click', 's3'),
        createTestStep('click', 's4'),
      ]);

      const f = manager.getFlow()!;
      const edgeIds = f.edges!.map((e) => e.id);
      const uniqueIds = new Set(edgeIds);

      expect(uniqueIds.size).toBe(edgeIds.length);
    });

    it('uses monotonic sequence for edge ids', async () => {
      const flow = createTestFlow();
      await manager.startSession(flow, 1);

      // Add steps in multiple batches
      manager.appendSteps([createTestStep('click', 's1')]);
      manager.appendSteps([createTestStep('click', 's2')]);
      manager.appendSteps([createTestStep('click', 's3')]);

      const f = manager.getFlow()!;
      // Edge ids should contain sequential numbers
      expect(f.edges![0].id).toMatch(/^e_0_/);
      expect(f.edges![1].id).toMatch(/^e_1_/);
    });
  });

  describe('edge invariant handling', () => {
    it('rechains edges when edges are missing', async () => {
      // Create flow with nodes but missing edges
      const flow = createTestFlow({
        nodes: [
          { id: 's1', type: 'click', config: {} },
          { id: 's2', type: 'fill', config: {} },
        ],
        edges: [], // Missing edges!
      });
      await manager.startSession(flow, 1);

      // Append should trigger rechain due to edge invariant violation
      manager.appendSteps([createTestStep('navigate', 's3')]);

      const f = manager.getFlow()!;
      expect(f.nodes).toHaveLength(3);
      // Should have rechained edges: s1→s2→s3
      expect(f.edges).toHaveLength(2);
    });

    it('rechains edges when last edge points to wrong node', async () => {
      // Create flow with corrupted edge pointing to wrong target
      const flow = createTestFlow({
        nodes: [
          { id: 's1', type: 'click', config: {} },
          { id: 's2', type: 'fill', config: {} },
        ],
        edges: [{ id: 'e_0', from: 's1', to: 'wrong_id' }], // Wrong target!
      });
      await manager.startSession(flow, 1);

      // Append should trigger rechain due to edge invariant violation
      manager.appendSteps([createTestStep('navigate', 's3')]);

      const f = manager.getFlow()!;
      expect(f.edges).toHaveLength(2);
      // Last edge should point to last node
      expect(f.edges![1].to).toBe('s3');
    });
  });
});
