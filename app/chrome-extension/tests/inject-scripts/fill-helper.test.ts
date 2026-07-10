import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = (
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

function loadHelper(): RuntimeListener {
  delete (window as any).__FILL_HELPER_INITIALIZED__;
  vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
  const scriptPath = join(process.cwd(), 'inject-scripts', 'fill-helper.js');
  const source = readFileSync(scriptPath, 'utf8');
  runInThisContext(source, { filename: scriptPath });
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Fill helper did not register a listener');
  return listener as RuntimeListener;
}

function dispatch(listener: RuntimeListener, request: any): Promise<any> {
  return new Promise((resolve) => {
    listener(request, {} as chrome.runtime.MessageSender, resolve);
  });
}

function createHost(): { host: HTMLDivElement; root: ShadowRoot } {
  const host = document.createElement('div');
  host.id = 'host';
  const root = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn().mockReturnValue(host),
  });
  return { host, root };
}

describe('fill-helper bounded shadow search', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
    } as CSSStyleDeclaration);
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
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    delete (window as any).__FILL_HELPER_INITIALIZED__;
    delete (document as any).elementFromPoint;
    delete (Element.prototype as any).scrollIntoView;
    vi.restoreAllMocks();
  });

  it('finds only the first fillable result without reading children collections', async () => {
    const { root } = createHost();
    const first = document.createElement('input');
    const second = document.createElement('input');
    root.append(first, second);
    Object.defineProperty(root, 'children', {
      configurable: true,
      get: () => {
        throw new Error('children collection must not be materialized');
      },
    });
    const listener = loadHelper();

    const response = await dispatch(listener, {
      action: 'fillElement',
      selector: '#host',
      value: 'bounded',
    });

    expect(response).toMatchObject({ success: true });
    expect(first.value).toBe('bounded');
    expect(second.value).toBe('');
  });

  it('does not search beyond the bounded BFS frontier', async () => {
    const { root } = createHost();
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 600; index += 1) {
      fragment.append(document.createElement('span'));
    }
    const lateInput = document.createElement('input');
    fragment.append(lateInput);
    root.append(fragment);
    const listener = loadHelper();

    const response = await dispatch(listener, {
      action: 'fillElement',
      selector: '#host',
      value: 'must-not-fill',
    });

    expect(response.error).toContain('not a fillable element');
    expect(lateInput.value).toBe('');
  });

  it('stops before a fillable control beyond the depth budget', async () => {
    const { root } = createHost();
    let parent: Element | ShadowRoot = root;
    for (let depth = 0; depth < 34; depth += 1) {
      const child = document.createElement('div');
      parent.append(child);
      parent = child;
    }
    const deepInput = document.createElement('input');
    parent.append(deepInput);
    const listener = loadHelper();

    const response = await dispatch(listener, {
      action: 'fillElement',
      selector: '#host',
      value: 'must-not-fill',
    });

    expect(response.error).toContain('not a fillable element');
    expect(deepInput.value).toBe('');
  });

  it('stops when the shadow search time budget expires', async () => {
    const { root } = createHost();
    root.append(document.createElement('input'));
    const listener = loadHelper();
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(101);

    const response = await dispatch(listener, {
      action: 'fillElement',
      selector: '#host',
      value: 'must-not-fill',
    });

    expect(response.error).toContain('not a fillable element');
  });
});
