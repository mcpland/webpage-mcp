/**
 * @fileoverview V2 to V3 Flow Conversion Tests
 * @description 测试 V2→V3 转换逻辑，特别是 entryNodeId 计算
 */

import { describe, it, expect } from 'vitest';
import {
  convertFlowV2ToV3,
  convertFlowV3ToV2,
} from '@/entrypoints/background/record-replay-v3/storage/import/v2-to-v3';

// ==================== Test Helpers ====================

function createV2Flow(overrides: Partial<Parameters<typeof convertFlowV2ToV3>[0]> = {}) {
  return {
    id: 'test-flow',
    name: 'Test Flow',
    version: 2,
    nodes: [],
    edges: [],
    ...overrides,
  };
}

// ==================== entryNodeId Calculation Tests ====================

describe('convertFlowV2ToV3 - entryNodeId calculation', () => {
  describe('basic scenarios', () => {
    it('selects the only executable node as entry', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [{ id: 'nav-1', type: 'navigate' }],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      expect(result.data?.entryNodeId).toBe('nav-1');
      expect(result.warnings).toHaveLength(0);
    });

    it('selects node with inDegree=0 as entry', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'nav-1', type: 'navigate' },
            { id: 'click-1', type: 'click' },
          ],
          edges: [{ id: 'e1', from: 'nav-1', to: 'click-1' }],
        }),
      );

      expect(result.success).toBe(true);
      expect(result.data?.entryNodeId).toBe('nav-1');
    });
  });

  describe('trigger node handling', () => {
    it('ignores trigger node when selecting entry', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'trigger-1', type: 'trigger' },
            { id: 'nav-1', type: 'navigate' },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      expect(result.data?.entryNodeId).toBe('nav-1');
    });

    it('ignores edges from trigger node when calculating inDegree', () => {
      // Scenario: trigger → navigate → click
      // Without this fix, navigate would have inDegree=1 and not be selected
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'trigger-1', type: 'trigger' },
            { id: 'nav-1', type: 'navigate' },
            { id: 'click-1', type: 'click' },
          ],
          edges: [
            { id: 'e1', from: 'trigger-1', to: 'nav-1' },
            { id: 'e2', from: 'nav-1', to: 'click-1' },
          ],
        }),
      );

      expect(result.success).toBe(true);
      // navigate should be entry because trigger edges are ignored
      expect(result.data?.entryNodeId).toBe('nav-1');
    });

    it('returns error when only trigger nodes exist', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [{ id: 'trigger-1', type: 'trigger' }],
          edges: [],
        }),
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Could not determine entry node. No valid root node found.');
    });
  });

  describe('multiple root nodes - stable selection', () => {
    it('warns and selects by UI coordinates (leftmost, then topmost)', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'nav-b', type: 'navigate', ui: { x: 200, y: 100 } },
            { id: 'nav-a', type: 'navigate', ui: { x: 100, y: 200 } },
            { id: 'nav-c', type: 'navigate', ui: { x: 100, y: 100 } },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // nav-c has smallest x, and smallest y at that x
      expect(result.data?.entryNodeId).toBe('nav-c');
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes('Multiple inDegree=0'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('ui(x=100, y=100)'))).toBe(true);
    });

    it('selects by ID when no UI coordinates available', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'nav-b', type: 'navigate' },
            { id: 'nav-a', type: 'navigate' },
            { id: 'nav-c', type: 'navigate' },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // nav-a comes first alphabetically
      expect(result.data?.entryNodeId).toBe('nav-a');
      expect(result.warnings.some((w) => w.includes('by id'))).toBe(true);
    });

    it('uses UI for nodes that have it, ignoring nodes without UI', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'nav-a', type: 'navigate' }, // no UI
            { id: 'nav-b', type: 'navigate', ui: { x: 50, y: 50 } },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // nav-b has UI coordinates, so it's preferred
      expect(result.data?.entryNodeId).toBe('nav-b');
    });
  });

  describe('cycle detection', () => {
    it('falls back using stable selection when graph has cycle (no inDegree=0)', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'nav-1', type: 'navigate' },
            { id: 'click-1', type: 'click' },
          ],
          edges: [
            { id: 'e1', from: 'nav-1', to: 'click-1' },
            { id: 'e2', from: 'click-1', to: 'nav-1' },
          ],
        }),
      );

      expect(result.success).toBe(true);
      expect(result.data?.entryNodeId).toBeTruthy();
      expect(result.warnings.some((w) => w.includes('cycles'))).toBe(true);
    });

    it('uses stable selection (by id) for cycle fallback', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'z-node', type: 'navigate' },
            { id: 'a-node', type: 'click' },
          ],
          edges: [
            { id: 'e1', from: 'z-node', to: 'a-node' },
            { id: 'e2', from: 'a-node', to: 'z-node' },
          ],
        }),
      );

      expect(result.success).toBe(true);
      // Should select 'a-node' as it comes first alphabetically
      expect(result.data?.entryNodeId).toBe('a-node');
      expect(result.warnings.some((w) => w.includes('by id'))).toBe(true);
    });

    it('uses stable selection (by UI) for cycle fallback when UI available', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'a-node', type: 'navigate', ui: { x: 200, y: 100 } },
            { id: 'z-node', type: 'click', ui: { x: 100, y: 100 } },
          ],
          edges: [
            { id: 'e1', from: 'a-node', to: 'z-node' },
            { id: 'e2', from: 'z-node', to: 'a-node' },
          ],
        }),
      );

      expect(result.success).toBe(true);
      // Should select 'z-node' as it has smaller x coordinate
      expect(result.data?.entryNodeId).toBe('z-node');
      expect(result.warnings.some((w) => w.includes('ui(x=100'))).toBe(true);
    });
  });

  describe('UI coordinate edge cases', () => {
    it('treats NaN coordinates as invalid UI', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'nav-a', type: 'navigate', ui: { x: NaN, y: 100 } },
            { id: 'nav-b', type: 'navigate' },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // Both nodes have no valid UI, should use ID sorting
      expect(result.data?.entryNodeId).toBe('nav-a');
      expect(result.warnings.some((w) => w.includes('by id'))).toBe(true);
    });

    it('treats Infinity coordinates as invalid UI', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'nav-a', type: 'navigate', ui: { x: Infinity, y: 100 } },
            { id: 'nav-b', type: 'navigate', ui: { x: 50, y: 50 } },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // Only nav-b has valid UI
      expect(result.data?.entryNodeId).toBe('nav-b');
    });

    it('uses id as tie-breaker when UI coordinates are equal', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [
            { id: 'nav-z', type: 'navigate', ui: { x: 100, y: 100 } },
            { id: 'nav-a', type: 'navigate', ui: { x: 100, y: 100 } },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // Same coordinates, should use ID as tie-breaker
      expect(result.data?.entryNodeId).toBe('nav-a');
    });
  });

  describe('empty and error cases', () => {
    it('returns error when no nodes exist', () => {
      const result = convertFlowV2ToV3(
        createV2Flow({
          nodes: [],
          edges: [],
        }),
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain('V2 Flow has no nodes');
    });
  });
});

// ==================== Roundtrip Tests ====================

describe('V2 <-> V3 roundtrip conversion', () => {
  it('preserves basic flow structure through roundtrip', () => {
    const original = createV2Flow({
      name: 'Roundtrip Test',
      description: 'Test description',
      nodes: [
        { id: 'nav-1', type: 'navigate', config: { url: 'https://example.com' } },
        { id: 'click-1', type: 'click', config: { selector: '#btn' } },
      ],
      edges: [{ id: 'e1', from: 'nav-1', to: 'click-1' }],
    });

    const toV3 = convertFlowV2ToV3(original);
    expect(toV3.success).toBe(true);

    const backToV2 = convertFlowV3ToV2(toV3.data!);
    expect(backToV2.success).toBe(true);

    // Check structure preserved
    expect(backToV2.data?.name).toBe(original.name);
    expect(backToV2.data?.description).toBe(original.description);
    expect(backToV2.data?.nodes).toHaveLength(2);
    expect(backToV2.data?.edges).toHaveLength(1);
  });

  it('preserves node configs through roundtrip', () => {
    const original = createV2Flow({
      nodes: [
        {
          id: 'nav-1',
          type: 'navigate',
          name: 'Go to site',
          disabled: true,
          config: { url: 'https://example.com', waitUntil: 'load' },
          ui: { x: 100, y: 200 },
        },
      ],
      edges: [],
    });

    const toV3 = convertFlowV2ToV3(original);
    const backToV2 = convertFlowV3ToV2(toV3.data!);

    const node = backToV2.data?.nodes?.[0];
    expect(node?.type).toBe('navigate');
    expect(node?.name).toBe('Go to site');
    expect(node?.disabled).toBe(true);
    expect(node?.config).toEqual({ url: 'https://example.com', waitUntil: 'load' });
    expect(node?.ui).toEqual({ x: 100, y: 200 });
  });
});
