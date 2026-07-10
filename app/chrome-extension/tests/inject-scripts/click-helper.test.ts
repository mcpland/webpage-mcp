import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = (
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

const nativeMouseEvent = window.MouseEvent;

function loadHelper(): RuntimeListener {
  delete (window as any).__CLICK_HELPER_INITIALIZED__;
  vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
  const source = readFileSync(join(process.cwd(), 'inject-scripts', 'click-helper.js'), 'utf8');
  window.eval(source);
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Click helper did not register a listener');
  return listener as RuntimeListener;
}

function dispatch(listener: RuntimeListener, request: any): Promise<any> {
  return new Promise((resolve) => {
    listener(request, {} as chrome.runtime.MessageSender, resolve);
  });
}

function mockElementFromPoint(element: Element): void {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn().mockReturnValue(element),
  });
}

function mockMouseEvent(): void {
  Object.defineProperty(window, 'MouseEvent', {
    configurable: true,
    value: function MouseEventForTest(type: string, init: MouseEventInit = {}) {
      return new window.Event(type, {
        bubbles: init.bubbles,
        cancelable: init.cancelable,
      });
    },
  });
}

describe('click-helper bounded text summaries', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
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
    delete (window as any).__CLICK_HELPER_INITIALIZED__;
    delete (document as any).elementFromPoint;
    Object.defineProperty(window, 'MouseEvent', {
      configurable: true,
      value: nativeMouseEvent,
    });
    vi.restoreAllMocks();
  });

  it('summarizes descendant text without reading subtree textContent', async () => {
    const button = document.createElement('button');
    button.append(document.createTextNode('Bounded '));
    const label = document.createElement('span');
    label.append(document.createTextNode('label'));
    button.append(label);
    const style = document.createElement('style');
    style.append(document.createTextNode('secret style source'));
    button.append(style);
    Object.defineProperty(button, 'textContent', {
      configurable: true,
      get: () => {
        throw new Error('textContent must not be materialized');
      },
    });
    document.body.append(button);
    mockElementFromPoint(button);
    mockMouseEvent();
    const createTreeWalker = vi.spyOn(document, 'createTreeWalker');
    const listener = loadHelper();

    const response = await dispatch(listener, {
      action: 'clickElement',
      coordinates: { x: 5, y: 5 },
    });

    expect(response).toMatchObject({
      success: true,
      elementInfo: { text: 'Bounded label' },
    });
    expect(createTreeWalker).toHaveBeenCalledWith(button, NodeFilter.SHOW_ALL);
  });

  it('visits at most 512 DOM nodes when no text is available', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    mockElementFromPoint(button);
    mockMouseEvent();
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const inertNode = document.createElement('span');
    let nextNodeCalls = 0;
    vi.spyOn(document, 'createTreeWalker').mockReturnValue({
      nextNode: () => {
        nextNodeCalls += 1;
        return inertNode;
      },
    } as TreeWalker);
    const listener = loadHelper();

    const response = await dispatch(listener, {
      action: 'clickElement',
      coordinates: { x: 5, y: 5 },
    });

    expect(response).toMatchObject({ success: true, elementInfo: { text: '' } });
    expect(nextNodeCalls).toBe(512);
  });
});
