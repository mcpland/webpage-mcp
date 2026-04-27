import { describe, expect, it } from 'vitest';
import type { Flow } from '@/entrypoints/background/record-replay/types';
import { applyFlowParameterSuggestions } from '@/entrypoints/background/tools/flow-parameterization';

function createFlow(): Flow {
  const nowIso = new Date().toISOString();
  return {
    id: 'flow-1',
    name: 'Test Flow',
    version: 2,
    variables: [],
    nodes: [
      {
        id: 'fill-1',
        type: 'fill' as any,
        config: { value: 'alice@example.com', target: { selector: '#email' } },
      },
      {
        id: 'nav-1',
        type: 'navigate' as any,
        config: { url: 'https://example.com/search?q=hello&page=1' },
      },
    ],
    edges: [],
    meta: {
      createdAt: nowIso,
      updatedAt: nowIso,
      recording: {
        parameterSuggestions: [
          {
            nodeId: 'fill-1',
            kind: 'fill',
            suggestedKey: 'email',
            currentValue: 'alice@example.com',
          },
          {
            nodeId: 'nav-1',
            kind: 'navigate',
            suggestedKey: 'q',
            currentValue: 'hello',
          },
        ],
      },
    },
  };
}

describe('flow parameterization suggestions', () => {
  it('applies fill and navigate suggestions, and creates variables', () => {
    const flow = createFlow();

    const result = applyFlowParameterSuggestions(flow);

    expect(result.changed).toBe(true);
    expect(result.applied).toBe(2);
    expect(result.variablesAdded).toBe(2);
    expect((flow.nodes?.find((n) => n.id === 'fill-1')?.config as any).value).toBe('{email}');
    expect((flow.nodes?.find((n) => n.id === 'nav-1')?.config as any).url).toContain('q={q}');
    expect(flow.variables?.some((v) => v.key === 'email')).toBe(true);
    expect(flow.variables?.some((v) => v.key === 'q')).toBe(true);
  });

  it('skips invalid suggestions and reports skipped count', () => {
    const flow = createFlow();
    if (!flow.meta?.recording) throw new Error('recording meta missing in test setup');
    flow.meta.recording.parameterSuggestions = [
      {
        nodeId: 'missing-node',
        kind: 'fill',
        suggestedKey: 'bad',
        currentValue: 'x',
      },
      {
        nodeId: 'fill-1',
        kind: 'fill',
        suggestedKey: 'invalid-key!',
        currentValue: 'x',
      } as any,
    ];

    const result = applyFlowParameterSuggestions(flow);

    expect(result.changed).toBe(false);
    expect(result.applied).toBe(0);
    expect(result.variablesAdded).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('preserves relative navigate urls while replacing query values', () => {
    const flow = createFlow();
    const navNode = flow.nodes?.find((node) => node.id === 'nav-1');
    if (!navNode) throw new Error('navigate node missing in test setup');
    (navNode.config as any).url = 'search?q=hello&page=1';

    const result = applyFlowParameterSuggestions(flow);

    expect(result.changed).toBe(true);
    expect((navNode.config as any).url).toBe('search?q={q}&page=1');
  });

  it('skips recorded suggestions when node values were edited after recording', () => {
    const flow = createFlow();
    const fillNode = flow.nodes?.find((node) => node.id === 'fill-1');
    const navNode = flow.nodes?.find((node) => node.id === 'nav-1');
    if (!fillNode || !navNode) throw new Error('test nodes missing');
    (fillNode.config as any).value = 'bob@example.com';
    (navNode.config as any).url = 'https://example.com/search?q=bye&page=1';

    const result = applyFlowParameterSuggestions(flow);

    expect(result).toEqual({
      changed: false,
      applied: 0,
      variablesAdded: 0,
      skipped: 2,
    });
    expect((fillNode.config as any).value).toBe('bob@example.com');
    expect((navNode.config as any).url).toBe('https://example.com/search?q=bye&page=1');
    expect(flow.variables).toEqual([]);
  });
});
