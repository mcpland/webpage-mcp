import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executePropsOperationInMain } from '@/entrypoints/background/web-editor/props-main-runner';
import { normalizePropsRawResponse } from '@/entrypoints/web-editor/core/props-bridge';

const REACT_HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
const locator = { selectors: ['#target'], fingerprint: '', path: [] };

function request(
  op: 'probe' | 'read' | 'write' | 'reset',
  payload?: Record<string, unknown>,
  targetLocator: Record<string, unknown> = locator,
) {
  return {
    v: 1,
    requestId: `request-${op}`,
    op,
    ...(op === 'probe' ? {} : { locator: targetLocator }),
    ...(payload ? { payload } : {}),
  };
}

function attachReactProps(
  props: Record<string, unknown>,
  existingTarget?: HTMLButtonElement,
) {
  const target = existingTarget ?? document.createElement('button');
  if (!target.id) target.id = 'target';
  if (!target.isConnected) document.body.append(target);
  function Button() {}
  const fiber: any = {
    tag: 0,
    type: Button,
    memoizedProps: props,
    return: null,
  };
  const renderer = {
    version: '18.3.0',
    overrideProps: vi.fn(),
    findFiberByHostInstance: vi.fn(() => fiber),
  };
  (window as any)[REACT_HOOK_KEY] = {
    inject: vi.fn(() => 1),
    renderers: new Map([[1, renderer]]),
  };
  Object.defineProperty(target, '__reactFiber$test', {
    configurable: true,
    enumerable: true,
    value: fiber,
  });
  return { renderer, fiber, target };
}

function readProps(targetLocator: Record<string, unknown>): any {
  return (
    executePropsOperationInMain(
      request('read', undefined, targetLocator),
    ) as any
  ).response;
}

function countSerializedNodes(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  let count = 1;
  if (Array.isArray(value)) {
    for (const item of value) count += countSerializedNodes(item);
    return count;
  }
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += countSerializedNodes((value as Record<string, unknown>)[key]);
  }
  return count;
}

function readTargetGuard(): string {
  const execution = executePropsOperationInMain(request('read')) as any;
  expect(execution.targetGuard).toMatch(/^fiber-v1:[a-f0-9]{16}$/);
  return execution.targetGuard;
}

function attachRootContainer(fiber: any, container: HTMLElement): void {
  fiber.return = {
    tag: 3,
    type: null,
    memoizedProps: {},
    index: 0,
    return: null,
    stateNode: { containerInfo: container },
  };
}

describe('per-operation MAIN-world props runner', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    delete (window as any)[REACT_HOOK_KEY];
    delete (window as any).__MCP_WEB_EDITOR_PROPS_AGENT__;
  });

  afterEach(() => {
    delete (window as any)[REACT_HOOK_KEY];
    delete (window as any).__MCP_WEB_EDITOR_PROPS_AGENT__;
    vi.restoreAllMocks();
  });

  it('is closure-free and contains no page-visible command transport', () => {
    const source = executePropsOperationInMain.toString();
    expect(source).not.toContain('web-editor-props:');
    expect(source).not.toContain('JSON.stringify');
    expect(source).not.toMatch(
      /(?:addEventListener|CustomEvent|crypto\.subtle)/,
    );

    const standalone = Function(
      `return (${source})`,
    )() as typeof executePropsOperationInMain;
    expect(standalone({ v: 1, requestId: 'probe', op: 'probe' })).toMatchObject(
      {
        response: { v: 1, requestId: 'probe' },
      },
    );
  });

  it('does not ship the obsolete props agent but retains the early hook bootstrap', () => {
    expect(
      existsSync(join(process.cwd(), 'inject-scripts', 'props-agent.js')),
    ).toBe(false);
    expect(
      existsSync(
        join(process.cwd(), 'inject-scripts', 'props-hook-bootstrap.js'),
      ),
    ).toBe(true);
  });

  it('reads bounded React props without installing a MAIN listener', () => {
    attachReactProps({ label: 'Save', enabled: true });
    const listenerSpy = vi.spyOn(window, 'addEventListener');

    const result = executePropsOperationInMain(request('read')) as any;

    expect(result).toMatchObject({
      response: {
        success: true,
        data: {
          framework: 'react',
          componentName: 'Button',
          props: { entries: [{ key: 'label' }, { key: 'enabled' }] },
        },
      },
    });
    expect(listenerSpy).not.toHaveBeenCalled();
  });

  it('never exposes page-owned array or collection metadata', () => {
    const toJSON = vi.fn(() => 1);
    const oversizedMetadata = {
      toJSON,
      pad: 'A'.repeat(2_000_000),
    };
    const arrayLengthRead = vi.fn(() => oversizedMetadata);
    const hostileArray = new Proxy([], {
      get(target, key, receiver) {
        if (key === 'length') return arrayLengthRead();
        return Reflect.get(target, key, receiver);
      },
    });
    const hostileMap = new Map([['answer', 42]]);
    const hostileSet = new Set(['value']);
    const mapSizeRead = vi.fn(() => oversizedMetadata);
    const setSizeRead = vi.fn(() => oversizedMetadata);
    Object.defineProperty(hostileMap, 'size', {
      configurable: true,
      enumerable: true,
      get: mapSizeRead,
    });
    Object.defineProperty(hostileSet, 'size', {
      configurable: true,
      enumerable: true,
      get: setSizeRead,
    });
    attachReactProps({ hostileArray, hostileMap, hostileSet });

    const execution = executePropsOperationInMain(request('read')) as any;

    expect(execution.response.success).toBe(true);
    expect(execution.response.data.props.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'hostileArray',
          value: {
            kind: 'array',
            length: 0,
            truncated: false,
            items: [],
          },
        }),
        expect.objectContaining({
          key: 'hostileMap',
          value: expect.objectContaining({ kind: 'map', size: 1 }),
        }),
        expect.objectContaining({
          key: 'hostileSet',
          value: expect.objectContaining({ kind: 'set', size: 1 }),
        }),
      ]),
    );
    expect(arrayLengthRead).not.toHaveBeenCalled();
    expect(mapSizeRead).not.toHaveBeenCalled();
    expect(setSizeRead).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(JSON.stringify(execution).length).toBeLessThan(256 * 1024);
  });

  it('keeps multi-byte strings within the bridge UTF-8 boundary', () => {
    attachReactProps({
      astral: '😀'.repeat(1_500),
      threeByte: '€'.repeat(1_500),
    });

    const execution = executePropsOperationInMain(request('read')) as any;
    const normalized = normalizePropsRawResponse(execution.response);

    expect(normalized).not.toBeNull();
    const entries = normalized!.response.data!.props!.entries;
    const astral = entries.find((entry) => entry.key === 'astral')!.value as {
      kind: string;
      value: string;
      truncated?: boolean;
    };
    const threeByte = entries.find((entry) => entry.key === 'threeByte')!
      .value as typeof astral;
    expect(astral.kind).toBe('string');
    expect(new TextEncoder().encode(astral.value)).toHaveLength(3_000);
    expect(astral.truncated).toBe(true);
    expect(threeByte.kind).toBe('string');
    expect(new TextEncoder().encode(threeByte.value)).toHaveLength(4_095);
    expect(threeByte.truncated).toBe(true);
  });

  it('keeps one guard across locator aliases and keyed reorder', () => {
    const { fiber } = attachReactProps({ label: 'Save' });
    fiber.key = '';
    fiber.index = 0;
    const first = executePropsOperationInMain(request('read')) as any;
    fiber.index = 9;
    const alias = { selectors: ['button'], fingerprint: '', path: [] };
    const second = executePropsOperationInMain(request('read', undefined, alias)) as any;

    expect(second.targetGuard).toBe(first.targetGuard);
  });

  it('keeps a unique root id stable when an earlier sibling is inserted', () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    const target = document.createElement('button');
    target.id = 'target';
    root.append(target);
    const { fiber } = attachReactProps({ value: 1 }, target);
    attachRootContainer(fiber, root);
    const before = readTargetGuard();

    root.before(document.createElement('aside'));
    const after = readTargetGuard();

    expect(after).toBe(before);
  });

  it('separates idless and duplicate-id root containers', () => {
    const rootOne = document.createElement('div');
    const rootTwo = document.createElement('div');
    document.body.append(rootOne, rootTwo);
    const targetOne = document.createElement('button');
    targetOne.id = 'target';
    rootOne.append(targetOne);
    const first = attachReactProps({ value: 1 }, targetOne);
    attachRootContainer(first.fiber, rootOne);
    const idlessOne = readTargetGuard();
    const targetTwo = document.createElement('button');
    targetTwo.id = 'target-two';
    rootTwo.append(targetTwo);
    const second = attachReactProps({ value: 2 }, targetTwo);
    attachRootContainer(second.fiber, rootTwo);
    const idlessTwo = readTargetGuard();
    expect(idlessTwo).not.toBe(idlessOne);

    rootOne.id = 'duplicate-root';
    rootTwo.id = 'duplicate-root';
    (window as any)[REACT_HOOK_KEY].renderers = new Map([
      [1, first.renderer],
    ]);
    const duplicateOne = readTargetGuard();
    (window as any)[REACT_HOOK_KEY].renderers = new Map([
      [1, second.renderer],
    ]);
    const duplicateTwo = readTargetGuard();
    expect(duplicateTwo).not.toBe(duplicateOne);
  });

  it('separates same-named instances and structured identity fields', () => {
    const first = attachReactProps({ value: 1 });
    first.fiber.key = 'aÿ';
    first.fiber._debugSource = { fileName: 'b', lineNumber: 1 };
    const firstGuard = readTargetGuard();

    const secondTarget = document.createElement('button');
    secondTarget.id = 'second-target';
    document.body.append(secondTarget);
    const second = attachReactProps({ value: 2 }, secondTarget);
    second.fiber.key = 'a';
    second.fiber._debugSource = { fileName: 'ÿb', lineNumber: 1 };
    const secondExecution = executePropsOperationInMain(
      request('read', undefined, {
        selectors: ['#second-target'],
        fingerprint: '',
        path: [],
      }),
    ) as any;

    expect(secondExecution.targetGuard).not.toBe(firstGuard);
  });

  it('rejects a write when a previously read locator resolves to another component', () => {
    const first = attachReactProps({ count: 1 });
    const expectedTargetGuard = readTargetGuard();
    const second = attachReactProps({ count: 10 }, first.target);
    second.fiber.type = function OtherComponent() {};

    const result = executePropsOperationInMain(
      request('write', {
        propPath: ['count'],
        propValue: 2,
        captureOriginal: true,
        expectedTargetGuard,
        stateBudgetBytes: 48 * 1024,
      }),
    ) as any;

    expect(result.response).toMatchObject({
      success: false,
      error: 'Target component changed',
    });
    expect(second.renderer.overrideProps).not.toHaveBeenCalled();
  });

  it('stops at the second selector match without materializing all matches', () => {
    document.body.innerHTML =
      '<button class="duplicate"></button><button class="duplicate"></button><button class="duplicate"></button>';
    const nativeMatches = Element.prototype.matches;
    let matchingResults = 0;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      const matched = nativeMatches.call(this, selector);
      if (matched) matchingResults += 1;
      return matched;
    });
    const documentQueryAll = vi.spyOn(document, 'querySelectorAll');
    const shadowQueryAll = vi.spyOn(ShadowRoot.prototype, 'querySelectorAll');

    const response = readProps({ selectors: ['.duplicate'] });

    expect(response).toMatchObject({
      success: false,
      error: 'Target element not found',
    });
    expect(matchingResults).toBe(2);
    expect(documentQueryAll).not.toHaveBeenCalled();
    expect(shadowQueryAll).not.toHaveBeenCalled();
  });

  it('locates a unique element with one bounded traversal', () => {
    const target = document.createElement('button');
    target.id = 'unique-target';
    document.body.append(target);

    expect(readProps({ selectors: ['#unique-target'] })).toMatchObject({
      success: false,
      error: 'Not a React component',
    });
  });

  it('shares a 12,000-element budget across selector candidates', () => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 12_100; index += 1) {
      fragment.append(document.createElement('div'));
    }
    const target = document.createElement('button');
    target.id = 'late-target';
    fragment.append(target);
    document.body.append(fragment);
    const matches = vi.spyOn(Element.prototype, 'matches');

    const response = readProps({ selectors: ['#late-target', 'button'] });

    expect(response).toMatchObject({
      success: false,
      error: 'Target element not found',
    });
    expect(matches.mock.calls.length).toBeLessThanOrEqual(12_000);
  });

  it('rejects oversized and structurally expensive selectors before traversal', () => {
    const matches = vi.spyOn(Element.prototype, 'matches');
    const oversized = readProps({ selectors: [`#${'a'.repeat(4097)}`] });
    const expensive = readProps({ selectors: ['main:has(button)'] });

    expect(oversized.error).toBe('Target element not found');
    expect(expensive.error).toBe('Target element not found');
    expect(matches).not.toHaveBeenCalled();
  });

  it('uses the same bounded traversal inside open shadow roots', () => {
    const host = document.createElement('div');
    host.id = 'shadow-host';
    const root = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    target.id = 'shadow-target';
    root.append(target);
    document.body.append(host);
    const shadowQueryAll = vi.spyOn(ShadowRoot.prototype, 'querySelectorAll');

    const response = readProps({
      shadowHostChain: ['#shadow-host'],
      selectors: ['#shadow-target'],
    });

    expect(response).toMatchObject({
      success: false,
      error: 'Not a React component',
    });
    expect(shadowQueryAll).not.toHaveBeenCalled();
  });

  it('stops traversal when the shared time budget expires', () => {
    document.body.innerHTML = '<button id="target"></button>';
    const nativeMatches = Element.prototype.matches;
    let delayed = false;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      if (!delayed) {
        delayed = true;
        const deadline = performance.now() + 275;
        while (performance.now() < deadline) {
          // Simulate a pathological selector evaluation in the browser engine.
        }
      }
      return nativeMatches.call(this, selector);
    });

    expect(readProps({ selectors: ['#target'] })).toMatchObject({
      success: false,
      error: 'Target element not found',
    });
  });

  it('applies one global node budget across a branching props graph', () => {
    const buildTree = (depth: number): Record<string, unknown> => {
      if (depth === 0) return { value: 'leaf' };
      const node: Record<string, unknown> = {};
      for (let index = 0; index < 8; index += 1)
        node[`child-${index}`] = buildTree(depth - 1);
      return node;
    };
    const target = document.createElement('button');
    document.body.append(target);
    attachReactProps({ tree: buildTree(4) }, target);

    const response = readProps({
      selectors: ['button'],
      path: [],
      fingerprint: 'button',
    });

    expect(response.success).toBe(true);
    expect(response.data.props.truncated).toBe(true);
    expect(countSerializedNodes(response.data.props)).toBeLessThan(4_100);
    expect(
      new TextEncoder().encode(JSON.stringify(response)).byteLength,
    ).toBeLessThanOrEqual(256 * 1024);
  });

  it('enumerates only bounded prop keys without Object.keys snapshots', () => {
    const props: Record<string, unknown> = {};
    for (let index = 0; index < 5_000; index += 1)
      props[`prop-${index}`] = index;
    const target = document.createElement('button');
    document.body.append(target);
    attachReactProps(props, target);
    const objectKeys = vi.spyOn(Object, 'keys');

    const response = readProps({
      selectors: ['button'],
      path: [],
      fingerprint: 'button',
    });

    expect(response.success).toBe(true);
    expect(response.data.props.entries).toHaveLength(100);
    expect(response.data.props.truncated).toBe(true);
    expect(objectKeys).not.toHaveBeenCalled();
  });

  it('stops serializing strings at the global byte budget', () => {
    const props: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      props[`prop-${index}`] = Array.from({ length: 50 }, () =>
        'x'.repeat(1_500),
      );
    }
    const target = document.createElement('button');
    document.body.append(target);
    attachReactProps(props, target);

    const response = readProps({
      selectors: ['button'],
      path: [],
      fingerprint: 'button',
    });
    expect(response.success).toBe(true);
    expect(response.data.props.truncated).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(response)).byteLength,
    ).toBeLessThanOrEqual(256 * 1024);
  });

  it('marks props truncated after the global serialization deadline', () => {
    const props: Record<string, unknown> = {};
    Object.defineProperty(props, 'slow', {
      enumerable: true,
      get() {
        const deadline = performance.now() + 125;
        while (performance.now() < deadline) {
          // Simulate a hostile prop getter that blocks the page world.
        }
        return 'late';
      },
    });
    const target = document.createElement('button');
    document.body.append(target);
    attachReactProps(props, target);

    const response = readProps({
      selectors: ['button'],
      path: [],
      fingerprint: 'button',
    });
    expect(response.success).toBe(true);
    expect(response.data.props.truncated).toBe(true);
    expect(response.data.props.entries[0].value).toMatchObject({
      kind: 'unknown',
      type: 'resource_limit',
    });
  });

  it('rejects an original that exceeds the remaining budget before mutation', () => {
    const { renderer } = attachReactProps({ label: 'before' });

    const result = executePropsOperationInMain(
      request('write', {
        propPath: ['label'],
        propValue: 'after',
        captureOriginal: true,
        stateBudgetBytes: 1,
      }),
    ) as any;

    expect(result.response).toMatchObject({
      success: false,
      error: 'Original prop exceeds the reset storage budget',
    });
    expect(result.stateDelta).toBeUndefined();
    expect(renderer.overrideProps).not.toHaveBeenCalled();
  });

  it('retains the original when a renderer mutates and then throws', () => {
    const { renderer } = attachReactProps({ count: 1 });
    renderer.overrideProps.mockImplementation(() => {
      throw new Error('mutated then failed');
    });

    const result = executePropsOperationInMain(
      request('write', {
        propPath: ['count'],
        propValue: 2,
        captureOriginal: true,
        stateBudgetBytes: 48 * 1024,
      }),
    ) as any;

    expect(result.response.success).toBe(false);
    expect(result.stateDelta).toMatchObject({
      kind: 'write_original',
      path: ['count'],
      encodedValue: 1,
    });
  });

  it('uses the same renderer fallback order for write and reset', () => {
    const { renderer: preferred, fiber } = attachReactProps({ count: 1 });
    preferred.overrideProps.mockImplementation(() => {
      throw new Error('preferred renderer failed');
    });
    const fallback = {
      version: '18.3.0',
      overrideProps: vi.fn(),
      findFiberByHostInstance: vi.fn(() => null),
    };
    (window as any)[REACT_HOOK_KEY].renderers = new Map([
      [1, preferred],
      [2, fallback],
    ]);

    const write = executePropsOperationInMain(
      request('write', {
        propPath: ['count'],
        propValue: 2,
        captureOriginal: true,
        stateBudgetBytes: 48 * 1024,
      }),
    ) as any;
    expect(write.response.success).toBe(true);
    expect(fallback.overrideProps).toHaveBeenCalledWith(fiber, ['count'], 2);

    preferred.overrideProps.mockClear();
    fallback.overrideProps.mockClear();
    const reset = executePropsOperationInMain(
      request('reset', {
        originals: [
          {
            index: 0,
            path: ['count'],
            encodedValue: 1,
            existed: true,
            componentGuard: write.targetGuard,
          },
        ],
      }),
    ) as any;

    expect(reset.response.success).toBe(true);
    expect(reset.stateDelta).toEqual({
      kind: 'reset_result',
      appliedIndexes: [0],
      guardMismatch: false,
    });
    expect(preferred.overrideProps).toHaveBeenCalledWith(fiber, ['count'], 1);
    expect(fallback.overrideProps).toHaveBeenCalledWith(fiber, ['count'], 1);
  });

  it('round-trips a 20 KiB original through write and reset', () => {
    const original = 'x'.repeat(20 * 1024);
    const { renderer, fiber } = attachReactProps({ value: original });
    const write = executePropsOperationInMain(
      request('write', {
        propPath: ['value'],
        propValue: 'changed',
        captureOriginal: true,
        stateBudgetBytes: 48 * 1024,
      }),
    ) as any;

    expect(write.response.success).toBe(true);
    expect(write.stateDelta.encodedValue).toBe(original);
    renderer.overrideProps.mockClear();
    const reset = executePropsOperationInMain(
      request('reset', {
        originals: [
          {
            index: 0,
            path: ['value'],
            encodedValue: original,
            existed: true,
            componentGuard: write.targetGuard,
          },
        ],
      }),
    ) as any;
    expect(reset.response.success).toBe(true);
    expect(renderer.overrideProps).toHaveBeenCalledWith(fiber, ['value'], original);
  });

  it('rejects frame-chain locators and originals that cannot fit one reset wire', () => {
    const { renderer } = attachReactProps({ value: 'x'.repeat(20 * 1024) });
    const framed = executePropsOperationInMain(
      request(
        'write',
        {
          propPath: ['value'],
          propValue: 'changed',
          captureOriginal: true,
          stateBudgetBytes: 48 * 1024,
        },
        { ...locator, frameChain: ['iframe'] },
      ),
    ) as any;
    expect(framed.response.error).toBe('Invalid props request');

    const largeLocator = {
      selectors: ['#target'].concat(
        Array.from({ length: 12 }, (_, index) => `#x${index}${'a'.repeat(4_050)}`),
      ),
      fingerprint: '',
      path: [],
    };
    const unresettable = executePropsOperationInMain(
      request(
        'write',
        {
          propPath: ['value'],
          propValue: 'changed',
          captureOriginal: true,
          stateBudgetBytes: 48 * 1024,
        },
        largeLocator,
      ),
    ) as any;
    expect(unresettable.response).toMatchObject({
      success: false,
      error: 'Original prop cannot fit a reset request',
    });
    expect(renderer.overrideProps).not.toHaveBeenCalled();
  });

  it('returns the original only in private state after a successful write', () => {
    const { renderer, fiber } = attachReactProps({ count: 1 });

    const result = executePropsOperationInMain(
      request('write', {
        propPath: ['count'],
        propValue: 2,
        captureOriginal: true,
        stateBudgetBytes: 48 * 1024,
      }),
    ) as any;

    expect(renderer.overrideProps).toHaveBeenCalledWith(fiber, ['count'], 2);
    expect(result).toMatchObject({
      response: {
        success: true,
        data: { meta: { write: { method: 'overrideProps' } } },
      },
      stateDelta: {
        kind: 'write_original',
        path: ['count'],
        existed: true,
        encodedValue: 1,
        componentGuard: expect.stringMatching(/^fiber-v1:/),
      },
    });
    expect(result.response.data.meta.write).not.toHaveProperty('original');
  });

  it('finalizes mutation recovery state without page JSON serialization hooks', () => {
    const { renderer } = attachReactProps({ count: 1 });
    const originalStringify = JSON.stringify;
    const hostileStringify = vi.fn(() => 'x');
    renderer.overrideProps.mockImplementation(() => {
      JSON.stringify = hostileStringify as typeof JSON.stringify;
    });

    try {
      const result = executePropsOperationInMain(
        request('write', {
          propPath: ['count'],
          propValue: 2,
          captureOriginal: true,
          stateBudgetBytes: 48 * 1024,
        }),
      ) as any;

      expect(result).toMatchObject({
        response: {
          success: true,
          data: { meta: { write: { method: 'overrideProps' } } },
        },
        stateDelta: {
          kind: 'write_original',
          path: ['count'],
          encodedValue: 1,
        },
      });
      expect(hostileStringify).not.toHaveBeenCalled();
    } finally {
      JSON.stringify = originalStringify;
    }
  });

  it('does not reset when the component guard changed', () => {
    const { renderer } = attachReactProps({ count: 2 });

    const result = executePropsOperationInMain(
      request('reset', {
        originals: [
          {
            index: 0,
            path: ['count'],
            encodedValue: 1,
            existed: true,
            componentGuard: 'OtherComponent',
          },
        ],
      }),
    ) as any;

    expect(renderer.overrideProps).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      response: { success: false, data: { needsRefresh: true } },
      stateDelta: {
        kind: 'reset_result',
        appliedIndexes: [],
        guardMismatch: true,
      },
    });
  });

  it('reports exact successful reset indexes for partial recovery', () => {
    const { renderer } = attachReactProps({ one: 10, two: 20 });
    const componentGuard = readTargetGuard();
    renderer.overrideProps.mockImplementation(
      (_fiber: unknown, path: Array<string | number>) => {
        if (path[0] === 'two') throw new Error('renderer rejected path');
      },
    );

    const result = executePropsOperationInMain(
      request('reset', {
        originals: [
          {
            index: 0,
            path: ['one'],
            encodedValue: 1,
            existed: true,
            componentGuard,
          },
          {
            index: 1,
            path: ['two'],
            encodedValue: 2,
            existed: true,
            componentGuard,
          },
        ],
      }),
    ) as any;

    expect(result).toMatchObject({
      response: { success: false, error: 'Failed to reset some props' },
      stateDelta: {
        kind: 'reset_result',
        appliedIndexes: [0],
        guardMismatch: false,
      },
    });
  });

  it('deletes an originally absent prop only through the renderer delete API', () => {
    const { renderer, fiber } = attachReactProps({ added: 'temporary' });
    const componentGuard = readTargetGuard();
    const deletePath = vi.fn();
    (renderer as typeof renderer & { overridePropsDeletePath: typeof deletePath })
      .overridePropsDeletePath = deletePath;

    const result = executePropsOperationInMain(
      request('reset', {
        originals: [
          {
            index: 0,
            path: ['added'],
            encodedValue: { $we: 'undefined' },
            existed: false,
            componentGuard,
          },
        ],
      }),
    ) as any;

    expect(deletePath).toHaveBeenCalledWith(fiber, ['added']);
    expect(renderer.overrideProps).not.toHaveBeenCalled();
    expect(result.stateDelta).toMatchObject({ appliedIndexes: [0] });
  });

  it('keeps an absent-prop reset pending when exact deletion is unavailable', () => {
    const { renderer } = attachReactProps({ added: 'temporary' });
    const componentGuard = readTargetGuard();
    const result = executePropsOperationInMain(
      request('reset', {
        originals: [
          {
            index: 0,
            path: ['added'],
            encodedValue: { $we: 'undefined' },
            existed: false,
            componentGuard,
          },
        ],
      }),
    ) as any;

    expect(renderer.overrideProps).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      response: { success: false, data: { needsRefresh: true } },
      stateDelta: { appliedIndexes: [] },
    });
  });

  it('strictly rejects malformed reset originals without mutating', () => {
    const { renderer } = attachReactProps({ count: 2 });
    const result = executePropsOperationInMain(
      request('reset', {
        originals: [
          {
            index: 1,
            path: ['count'],
            encodedValue: 1,
            existed: true,
            componentGuard: 'Button',
          },
        ],
      }),
    ) as any;
    expect(result).toMatchObject({
      response: { success: false, error: 'Invalid props request' },
    });
    expect(renderer.overrideProps).not.toHaveBeenCalled();
  });
});
