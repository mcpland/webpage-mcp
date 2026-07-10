import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPropsBridge } from '@/entrypoints/web-editor/core/props-bridge';

const REQUEST_EVENT = 'web-editor-props:request';
const RESPONSE_EVENT = 'web-editor-props:response';
const AGENT_KEY = '__MCP_WEB_EDITOR_PROPS_AGENT__';
const REACT_HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

let hadReactHook = false;
let originalReactHook: unknown;

function loadAgent(): void {
  delete (window as any)[AGENT_KEY];
  const scriptPath = join(process.cwd(), 'inject-scripts', 'props-agent.js');
  const source = readFileSync(scriptPath, 'utf8');
  runInThisContext(source, { filename: scriptPath });
  if (!(window as any)[AGENT_KEY]) throw new Error('Props agent did not initialize');
}

function request(locator: Record<string, unknown>): any {
  let response: any;
  const onResponse = (event: Event) => {
    response = (event as CustomEvent).detail;
  };
  window.addEventListener(RESPONSE_EVENT, onResponse, { once: true });
  window.dispatchEvent(
    new CustomEvent(REQUEST_EVENT, {
      detail: {
        v: 1,
        requestId: 'request-1',
        op: 'read',
        locator,
      },
    }),
  );
  window.removeEventListener(RESPONSE_EVENT, onResponse);
  if (!response) throw new Error('Props agent did not respond');
  return response;
}

function attachReactProps(target: Element, props: Record<string, unknown>): void {
  function TestComponent() {}
  const fiber = {
    tag: 0,
    type: TestComponent,
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

describe('props-agent locator resource boundaries', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    hadReactHook = Object.prototype.hasOwnProperty.call(window, REACT_HOOK_KEY);
    originalReactHook = (window as any)[REACT_HOOK_KEY];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    try {
      (window as any)[AGENT_KEY]?.dispose();
    } catch {
      // Best effort cleanup for a partially initialized agent.
    }
    delete (window as any)[AGENT_KEY];
    if (hadReactHook) (window as any)[REACT_HOOK_KEY] = originalReactHook;
    else delete (window as any)[REACT_HOOK_KEY];
    document.documentElement.innerHTML = '<head></head><body></body>';
    vi.restoreAllMocks();
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
    loadAgent();

    const response = request({ selectors: ['.duplicate'] });

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
    loadAgent();

    const response = request({ selectors: ['#unique-target'] });

    expect(response).toMatchObject({
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
    loadAgent();

    const response = request({ selectors: ['#late-target', 'button'] });

    expect(response).toMatchObject({
      success: false,
      error: 'Target element not found',
    });
    expect(matches.mock.calls.length).toBeLessThanOrEqual(12_000);
  });

  it('rejects oversized and structurally expensive selectors before traversal', () => {
    const matches = vi.spyOn(Element.prototype, 'matches');
    loadAgent();

    const oversized = request({ selectors: [`#${'a'.repeat(4097)}`] });
    const expensive = request({ selectors: ['main:has(button)'] });

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
    loadAgent();

    const response = request({
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
    loadAgent();

    const response = request({ selectors: ['#target'] });

    expect(response).toMatchObject({
      success: false,
      error: 'Target element not found',
    });
  });

  it('applies one global node budget across a branching props graph', () => {
    const buildTree = (depth: number): Record<string, unknown> => {
      if (depth === 0) return { value: 'leaf' };
      const node: Record<string, unknown> = {};
      for (let index = 0; index < 8; index++) node[`child-${index}`] = buildTree(depth - 1);
      return node;
    };
    const target = document.createElement('button');
    document.body.append(target);
    attachReactProps(target, { tree: buildTree(4) });
    loadAgent();

    const response = request({
      selectors: ['button'],
      path: [],
      fingerprint: 'button',
    });

    expect(response.success).toBe(true);
    expect(response.data.props.truncated).toBe(true);
    expect(countSerializedNodes(response.data.props)).toBeLessThan(4_100);
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(
      256 * 1024,
    );
  });

  it('enumerates only the bounded prop keys without Object.keys snapshots', () => {
    const props: Record<string, unknown> = {};
    for (let index = 0; index < 5_000; index++) props[`prop-${index}`] = index;
    const target = document.createElement('button');
    document.body.append(target);
    attachReactProps(target, props);
    const objectKeys = vi.spyOn(Object, 'keys');
    loadAgent();

    const response = request({
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
    for (let index = 0; index < 100; index++) {
      props[`prop-${index}`] = Array.from({ length: 50 }, () => 'x'.repeat(1_500));
    }
    const target = document.createElement('button');
    document.body.append(target);
    attachReactProps(target, props);
    loadAgent();

    const response = request({
      selectors: ['button'],
      path: [],
      fingerprint: 'button',
    });
    const encoded = new TextEncoder().encode(JSON.stringify(response));

    expect(response.success).toBe(true);
    expect(response.data.props.truncated).toBe(true);
    expect(encoded.byteLength).toBeLessThanOrEqual(256 * 1024);
  });

  it('marks the props result truncated after the global serialization deadline', () => {
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
    attachReactProps(target, props);
    loadAgent();

    const response = request({
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

  it('round-trips a bounded serialized response through the isolated-world bridge', async () => {
    const target = document.createElement('button');
    target.id = 'target';
    document.body.append(target);
    attachReactProps(target, { label: 'Save', nested: { enabled: true } });
    loadAgent();
    const bridge = createPropsBridge();

    const result = await bridge.read({
      selectors: ['#target'],
      fingerprint: 'button|id=target',
      path: [],
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        framework: 'react',
        props: { entries: [{ key: 'label' }, { key: 'nested' }] },
      },
    });
    bridge.dispose();
  });
});
