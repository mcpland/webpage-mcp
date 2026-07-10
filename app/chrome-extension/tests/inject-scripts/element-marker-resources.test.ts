import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = (
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

function loadMarker(): RuntimeListener {
  delete (window as any).__ELEMENT_MARKER_INSTALLED__;
  vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
  const source = readFileSync(join(process.cwd(), 'inject-scripts', 'element-marker.js'), 'utf8');
  window.eval(source);
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Element marker did not register a listener');
  return listener as RuntimeListener;
}

function dispatch(listener: RuntimeListener, request: any): Promise<any> {
  return new Promise((resolve) => {
    listener(request, {} as chrome.runtime.MessageSender, resolve);
  });
}

async function highlight(listener: RuntimeListener, request: any): Promise<any> {
  const response = dispatch(listener, { action: 'element_marker_highlight', ...request });
  await vi.advanceTimersByTimeAsync(150);
  return response;
}

function start(listener: RuntimeListener): void {
  const response = vi.fn();
  listener(
    { action: 'element_marker_start', markerSessionId: 'resource-session' },
    {} as chrome.runtime.MessageSender,
    response,
  );
  expect(response).toHaveBeenCalledWith({ ok: true });
}

function dispatchFrameMessage(source: Window, data: unknown): void {
  const event = new Event('message');
  Object.defineProperties(event, {
    source: { value: source },
    origin: { value: 'https://example.com' },
    data: { value: data },
  });
  window.dispatchEvent(event);
}

describe('element-marker DOM resource boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(chrome.runtime.sendMessage).mockReset().mockResolvedValue(undefined);
    document.documentElement.innerHTML = '<head></head><body></body>';
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
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
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    vi.clearAllTimers();
    vi.useRealTimers();
    document.documentElement.innerHTML = '<head></head><body></body>';
    delete (window as any).__ELEMENT_MARKER_INSTALLED__;
    delete (Element.prototype as any).scrollIntoView;
    vi.restoreAllMocks();
  });

  it('caps deep CSS query results without querySelectorAll snapshots', async () => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 150; index += 1) {
      const button = document.createElement('button');
      button.className = 'bounded-result';
      fragment.append(button);
    }
    document.body.append(fragment);
    const documentQueryAll = vi.spyOn(document, 'querySelectorAll');
    const shadowQueryAll = vi.spyOn(ShadowRoot.prototype, 'querySelectorAll');
    const listener = loadMarker();

    const response = await highlight(listener, {
      selector: '.bounded-result',
      selectorType: 'css',
      listMode: true,
    });

    expect(response).toEqual({ success: true, count: 100 });
    expect(documentQueryAll).not.toHaveBeenCalled();
    expect(shadowQueryAll).not.toHaveBeenCalled();
  });

  it('uses a bounded XPath iterator instead of a snapshot', async () => {
    document.body.innerHTML = '<button></button><button></button><button></button>';
    const evaluate = vi.spyOn(document, 'evaluate');
    const listener = loadMarker();

    const response = await highlight(listener, {
      selector: '//button',
      selectorType: 'xpath',
    });

    expect(response).toEqual({ success: true, count: 3 });
    expect(evaluate).toHaveBeenCalledWith(
      '//button',
      document,
      null,
      XPathResult.ORDERED_NODE_ITERATOR_TYPE,
      null,
    );
    expect(
      evaluate.mock.calls.some((call) => call[3] === XPathResult.ORDERED_NODE_SNAPSHOT_TYPE),
    ).toBe(false);
  });

  it('rejects XPath evaluation when the page exceeds the DOM preflight budget', async () => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 10_100; index += 1) {
      fragment.append(document.createElement('div'));
    }
    fragment.append(document.createElement('button'));
    document.body.append(fragment);
    const evaluate = vi.spyOn(document, 'evaluate');
    const listener = loadMarker();

    const response = await highlight(listener, {
      selector: '//button',
      selectorType: 'xpath',
    });

    expect(response).toMatchObject({ success: false });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('uses a two-match uniqueness scan and incremental sibling traversal', () => {
    const source = readFileSync(join(process.cwd(), 'inject-scripts', 'element-marker.js'), 'utf8');

    expect(source).toMatch(
      /function isDeepSelectorUnique[\s\S]*?scanDeepSelector\(\s*selector,\s*2,/,
    );
    expect(source).not.toMatch(/Array\.from\(parent\.children/);
  });

  it('bounds iframe source lookup without materializing an iframe NodeList', () => {
    const listener = loadMarker();
    start(listener);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 10_100; index += 1) {
      fragment.append(document.createElement('div'));
    }
    const frame = document.createElement('iframe');
    fragment.append(frame);
    document.body.append(fragment);
    const frameRect = vi.spyOn(frame, 'getBoundingClientRect');
    const querySelectorAll = vi.spyOn(document, 'querySelectorAll');

    dispatchFrameMessage(frame.contentWindow!, {
      type: 'em_hover',
      rects: [{ x: 0, y: 0, width: 10, height: 10 }],
    });

    expect(frameRect).not.toHaveBeenCalled();
    expect(querySelectorAll).not.toHaveBeenCalled();
  });
});
