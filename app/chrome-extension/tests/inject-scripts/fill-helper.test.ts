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

function createCoveredField() {
  document.body.innerHTML = '<input id="field" value="original"><div id="overlay"></div>';
  const field = document.querySelector<HTMLInputElement>('#field')!;
  const overlay = document.querySelector('#overlay')!;
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => overlay.isConnected ? overlay : field,
  });
  return { field, overlay };
}

describe('fill helper', () => {
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
    vi.useRealTimers();
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

  it.each([
    ['text input', '<input id="field" />', 'typed'],
    ['checkbox', '<input id="field" type="checkbox" />', true],
    ['select', '<select id="field"><option value="a">A</option><option value="b">B</option></select>', 'b'],
  ])('keeps a %s focused only when keepFocus is set', async (_kind, markup, value) => {
    document.body.innerHTML = markup;
    const field = document.getElementById('field')!;
    // jsdom has no layout; the helper checks the field is the topmost element.
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn().mockReturnValue(field),
    });
    const listener = loadHelper();

    const blurred = await dispatch(listener, { action: 'fillElement', selector: '#field', value });
    expect(blurred).toMatchObject({ success: true });
    expect(document.activeElement).not.toBe(field);

    const kept = await dispatch(listener, {
      action: 'fillElement',
      selector: '#field',
      value,
      keepFocus: true,
    });
    expect(kept).toMatchObject({ success: true });
    expect(document.activeElement).toBe(field);
  });

  it('rechecks cancellation after the first input event before writing the requested value', async () => {
    document.body.innerHTML = '<input id="field" value="initial">';
    const field = document.querySelector<HTMLInputElement>('#field')!;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => field });
    let live = true;
    field.oninput = () => { live = false; };
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(async () => live);
    const result = await dispatch(loadHelper(), { action: 'fillElement', selector: '#field', value: 'late', permit: 'permit' });
    expect(result.error).toContain('cancelled');
    expect(field.value).toBe('');
  });

  it('fills an already reachable field without scrolling or advancing the clock', async () => {
    vi.useFakeTimers();
    const { field, overlay } = createCoveredField();
    overlay.remove();
    const result = await dispatch(loadHelper(), { action: 'fillElement', selector: '#field', value: 'now' });
    expect(result.success).toBe(true);
    expect(field.value).toBe('now');
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('waits only until the center of the control is uncovered', async () => {
    vi.useFakeTimers();
    const { field, overlay } = createCoveredField();
    const result = dispatch(loadHelper(), { action: 'fillElement', selector: '#field', value: 'ready' });
    await vi.advanceTimersByTimeAsync(20);
    expect(field.value).toBe('original');
    overlay.remove();
    await vi.advanceTimersByTimeAsync(20);
    expect((await result).success).toBe(true);
    expect(field.value).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['occlusion', 'not visible'],
    ['cancellation', 'cancelled'],
    ['deadline', 'timed out'],
  ])('never writes through %s during scroll settling', async (reason, expectedError) => {
    vi.useFakeTimers();
    const { field, overlay } = createCoveredField();
    const input = vi.fn();
    field.addEventListener('input', input);
    let live = true;
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(async () => live);
    const result = dispatch(loadHelper(), {
      action: 'fillElement', selector: '#field', value: 'late', permit: 'permit',
      deadlineAt: reason === 'deadline' ? Date.now() + 12 : undefined,
    });
    await vi.advanceTimersByTimeAsync(5);
    if (reason === 'cancellation') live = false;
    if (reason !== 'occlusion') overlay.remove();
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).error).toContain(expectedError);
    expect(field.value).toBe('original');
    expect(document.activeElement).not.toBe(field);
    expect(input).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['<fieldset disabled><input id="field"></fieldset>', 'disabled'],
    ['<textarea id="field" readonly></textarea>', 'read-only'],
  ])('rejects a visible non-editable field in %s', async (markup, error) => {
    document.body.innerHTML = markup;
    const field = document.querySelector<HTMLInputElement>('#field')!;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => field });
    const result = await dispatch(loadHelper(), { action: 'fillElement', selector: '#field', value: 'late' });
    expect(result.error).toContain(error);
    expect(field.value).toBe('');
  });

  it('fills a visible field once enabled without scrolling it', async () => {
    vi.useFakeTimers();
    const { field, overlay } = createCoveredField();
    overlay.remove();
    field.disabled = true;
    const result = dispatch(loadHelper(), { action: 'fillElement', selector: '#field', value: 'enabled' });
    await vi.advanceTimersByTimeAsync(20);
    expect(field.value).toBe('original');
    field.disabled = false;
    await vi.advanceTimersByTimeAsync(20);
    expect((await result).success).toBe(true);
    expect(field.value).toBe('enabled');
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('rechecks occlusion if focusing the field opens an overlay', async () => {
    const { field, overlay } = createCoveredField();
    overlay.remove();
    field.onfocus = () => document.body.append(overlay);
    const result = await dispatch(loadHelper(), { action: 'fillElement', selector: '#field', value: 'late' });
    expect(result.error).toContain('not visible');
    expect(field.value).toBe('original');
  });

  it('refocuses the exact filled control if an input handler moved focus before submit', async () => {
    document.body.innerHTML = '<form><input id="one"></form><form><input id="two"></form>';
    const field = document.querySelector<HTMLInputElement>('#one')!;
    const other = document.querySelector<HTMLInputElement>('#two')!;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => field });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    field.oninput = () => other.focus();
    const listener = loadHelper();
    await dispatch(listener, { action: 'fillElement', selector: '#one', value: 'x', keepFocus: true, submitToken: 'fill-1' });
    expect(document.activeElement).toBe(other);
    expect(await dispatch(listener, { action: 'focusFilledTarget', submitToken: 'fill-1' })).toEqual({ success: true });
    expect(document.activeElement).toBe(field);
    field.replaceWith(field.cloneNode(true));
    expect(await dispatch(listener, { action: 'focusFilledTarget', submitToken: 'fill-1' })).toEqual({ success: false });
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

  it('scrolls an offscreen rendered input into view before visibility check and reports ref on error', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input id="below" /><span id="not-input">text</span>';
    const input = document.getElementById('below') as HTMLInputElement;
    let scrolled = false;
    (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockImplementation(() => {
      scrolled = true;
    });
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      const top = this === input && !scrolled ? 5000 : 10;
      return {
        x: 0,
        y: top,
        width: 100,
        height: 20,
        top,
        right: 100,
        bottom: top + 20,
        left: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => (scrolled ? input : null)),
    });
    const listener = loadHelper();

    const filled = await dispatch(listener, {
      action: 'fillElement',
      selector: '#below',
      value: 'scrolled-in',
    });
    expect(filled).toMatchObject({ success: true });
    expect(scrolled).toBe(true);
    expect(input.value).toBe('scrolled-in');

    (window as any).__claudeElementMap = {
      ref_99: new WeakRef(document.getElementById('not-input')!),
    };
    const badRef = await dispatch(listener, {
      action: 'fillElement',
      ref: 'ref_99',
      value: 'nope',
    });
    expect(badRef.error).toContain('ref_99');
    expect(badRef.error).not.toContain('undefined');
  });
});
