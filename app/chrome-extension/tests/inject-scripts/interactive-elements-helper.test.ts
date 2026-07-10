import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = (
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

function loadHelper(): RuntimeListener {
  delete (window as any).__INTERACTIVE_ELEMENTS_HELPER_INITIALIZED__;
  vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
  const source = readFileSync(
    join(process.cwd(), 'inject-scripts', 'interactive-elements-helper.js'),
    'utf8',
  );
  window.eval(source);
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Interactive elements helper did not register a listener');
  return listener as RuntimeListener;
}

function dispatch(listener: RuntimeListener, request: unknown): Promise<any> {
  return new Promise((resolve) => {
    listener(request, {} as chrome.runtime.MessageSender, resolve);
  });
}

describe('interactive-elements-helper resource boundaries', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    // Keep count/byte-budget assertions deterministic under V8 coverage,
    // where instrumentation overhead can otherwise exhaust the wall-clock cap.
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          top: 0,
          right: 20,
          bottom: 10,
          left: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
  });

  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    delete (window as any).__INTERACTIVE_ELEMENTS_HELPER_INITIALIZED__;
    vi.restoreAllMocks();
  });

  it('caps result count and JSON bytes before returning page-controlled fields', async () => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 260; index += 1) {
      const button = document.createElement('button');
      button.id = `button-${index}`;
      button.setAttribute('aria-label', `Action ${index} ${'😀'.repeat(400)}`);
      fragment.append(button);
    }
    document.body.append(fragment);

    const response = await dispatch(loadHelper(), {
      action: 'getInteractiveElements',
    });

    expect(response).toMatchObject({ success: true, truncated: true, count: 200 });
    expect(response.elements).toHaveLength(200);
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(
      512 * 1024,
    );
    expect(response.stats.visitedNodes).toBeLessThanOrEqual(12_000);
  });

  it('finds quoted text without constructing or snapshotting an XPath expression', async () => {
    const button = document.createElement('button');
    button.append("Bob's primary action");
    document.body.append(button);
    const evaluate = vi.spyOn(document, 'evaluate');

    const response = await dispatch(loadHelper(), {
      action: 'getInteractiveElements',
      textQuery: "Bob's action",
    });

    expect(response).toMatchObject({ success: true, count: 1 });
    expect(response.elements[0].text).toContain("Bob's primary action");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('collects element text incrementally without materializing textContent', async () => {
    const button = document.createElement('button');
    button.append(document.createTextNode('Launch bounded scan'));
    Object.defineProperty(button, 'textContent', {
      configurable: true,
      get: () => {
        throw new Error('textContent must not be materialized');
      },
    });
    document.body.append(button);

    const response = await dispatch(loadHelper(), {
      action: 'getInteractiveElements',
    });

    expect(response).toMatchObject({ success: true, count: 1 });
    expect(response.elements[0].text).toBe('Launch bounded scan');
  });

  it('walks a wide DOM without reading or copying live children collections', async () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Safe child');
    document.body.append(button);
    Object.defineProperty(document.body, 'children', {
      configurable: true,
      get: () => {
        throw new Error('children collection must not be materialized');
      },
    });

    const response = await dispatch(loadHelper(), {
      action: 'getInteractiveElements',
    });

    expect(response).toMatchObject({ success: true, count: 1 });
    expect(response.elements[0].text).toBe('Safe child');
  });

  it('rejects oversized and resource-intensive selectors before traversal', async () => {
    const matches = vi.spyOn(Element.prototype, 'matches');
    const listener = loadHelper();

    const oversized = await dispatch(listener, {
      action: 'getInteractiveElements',
      selector: `#${'a'.repeat(4097)}`,
    });
    expect(oversized).toMatchObject({ success: false });
    expect(oversized.error).toContain('4096-byte UTF-8 limit');
    expect(matches).not.toHaveBeenCalled();

    const expensive = await dispatch(listener, {
      action: 'getInteractiveElements',
      selector: 'main:has(button)',
    });
    expect(expensive).toMatchObject({ success: false });
    expect(expensive.error).toContain(':has()');
    expect(matches).not.toHaveBeenCalled();
  });
});
