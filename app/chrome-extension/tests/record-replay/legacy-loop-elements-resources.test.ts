import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loopElementsNode } from '@/entrypoints/background/record-replay/nodes/download-screenshot-attr-event-frame-loop';
import {
  boundedLoopElementIterations,
  collectLoopElementPaths,
  LOOP_ELEMENTS_RESOURCE_LIMITS,
} from '@/entrypoints/background/record-replay/nodes/loop-elements-resources';

describe('legacy loopElements resource limits', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId })),
      },
      scripting: {
        executeScript: vi.fn(async ({ func, args }) => [{ result: func(...args) }]),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes maxIterations to a finite engine-wide ceiling', () => {
    expect(boundedLoopElementIterations(3.9)).toBe(3);
    expect(boundedLoopElementIterations(0)).toBe(1);
    expect(boundedLoopElementIterations(Number.MAX_SAFE_INTEGER)).toBe(
      LOOP_ELEMENTS_RESOURCE_LIMITS.maxIterations,
    );
    expect(boundedLoopElementIterations(Infinity)).toBe(
      LOOP_ELEMENTS_RESOURCE_LIMITS.defaultIterations,
    );
  });

  it('collects only maxIterations paths without querySelectorAll snapshots', () => {
    const parent = document.createElement('div');
    for (let index = 0; index < 10; index++) {
      const child = document.createElement('button');
      child.className = 'match';
      parent.append(child);
    }
    document.body.append(parent);

    Object.defineProperty(document, 'querySelectorAll', {
      configurable: true,
      value: () => {
        throw new Error('querySelectorAll must not be used');
      },
    });
    try {
      const paths = collectLoopElementPaths('.match', 3, LOOP_ELEMENTS_RESOURCE_LIMITS);
      expect(paths).toHaveLength(3);
      expect(paths.every((path) => document.querySelector(path)?.classList.contains('match'))).toBe(
        true,
      );
    } finally {
      Reflect.deleteProperty(document, 'querySelectorAll');
    }
  });

  it('stops when the shared DOM-visit budget is exhausted', () => {
    document.body.innerHTML = '<button class="match"></button>';

    expect(
      collectLoopElementPaths('.match', 1, {
        ...LOOP_ELEMENTS_RESOURCE_LIMITS,
        maxDomVisits: 2,
      }),
    ).toEqual([]);
  });

  it('drops paths whose sibling scan cannot finish within its cap', () => {
    document.body.innerHTML =
      '<div><span></span><span></span><span class="match"></span></div>';

    expect(
      collectLoopElementPaths('.match', 1, {
        ...LOOP_ELEMENTS_RESOURCE_LIMITS,
        maxDirectSiblings: 2,
      }),
    ).toEqual([]);
  });

  it('wires maxIterations into the legacy foreach control result', async () => {
    document.body.innerHTML = '<button></button><button></button><button></button>';
    const vars: Record<string, unknown> = {};

    const result = await loopElementsNode.run(
      { vars, logger: vi.fn(), tabId: 7 },
      {
        id: 'loop-1',
        type: 'loopElements',
        selector: 'button',
        maxIterations: 2,
        saveAs: 'buttons',
        itemVar: 'button',
        subflowId: 'child-flow',
      } as any,
    );

    expect(vars.buttons).toHaveLength(2);
    expect(result).toMatchObject({
      control: {
        kind: 'foreach',
        listVar: 'buttons',
        itemVar: 'button',
        subflowId: 'child-flow',
      },
    });
  });
});
