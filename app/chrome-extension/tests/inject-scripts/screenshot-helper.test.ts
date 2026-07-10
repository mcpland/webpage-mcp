import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = (
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

function loadHelper(): RuntimeListener {
  delete (window as any).__SCREENSHOT_HELPER_INITIALIZED__;
  vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
  const source = readFileSync(join(process.cwd(), 'inject-scripts', 'screenshot-helper.js'), 'utf8');
  window.eval(source);
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Screenshot helper did not register a listener');
  return listener as RuntimeListener;
}

function dispatch(listener: RuntimeListener, request: any): Promise<any> {
  return new Promise((resolve) => {
    listener(request, {} as chrome.runtime.MessageSender, resolve);
  });
}

async function prepare(listener: RuntimeListener, fullPage = true): Promise<any> {
  const response = dispatch(listener, { action: 'preparePageForCapture', options: { fullPage } });
  await vi.advanceTimersByTimeAsync(50);
  return response;
}

describe('screenshot-helper resource boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.innerHTML = '<head></head><body></body>';
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element) => ({ position: (element as HTMLElement).style.position || 'static' }) as any,
    );
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(20);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(10);
  });

  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    delete (window as any).__SCREENSHOT_HELPER_INITIALIZED__;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('scans incrementally without materializing a page-sized NodeList', async () => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 12_100; index += 1) {
      fragment.append(document.createElement('div'));
    }
    document.body.append(fragment);
    const querySelectorAll = vi.spyOn(document, 'querySelectorAll');
    const listener = loadHelper();

    const response = await prepare(listener);

    expect(response).toMatchObject({
      success: true,
      fixedElementScan: { truncated: true },
    });
    expect(response.fixedElementScan.visited).toBeLessThanOrEqual(12_000);
    expect(window.getComputedStyle).toHaveBeenCalledTimes(response.fixedElementScan.visited);
    expect(querySelectorAll).not.toHaveBeenCalled();
  });

  it('caps retained fixed elements and restores every hidden style', async () => {
    const fragment = document.createDocumentFragment();
    const elements: HTMLElement[] = [];
    for (let index = 0; index < 600; index += 1) {
      const element = document.createElement('div');
      element.style.position = 'fixed';
      element.style.display = 'inline-block';
      fragment.append(element);
      elements.push(element);
    }
    document.body.append(fragment);
    const listener = loadHelper();

    const response = await prepare(listener);

    expect(response.fixedElementScan).toMatchObject({ hidden: 512, truncated: true });
    expect(elements.filter((element) => element.style.display === 'none')).toHaveLength(512);

    await expect(dispatch(listener, { action: 'resetPageAfterCapture' })).resolves.toEqual({
      success: true,
    });
    expect(elements.every((element) => element.style.display === 'inline-block')).toBe(true);
  });

  it('restores overflow and prior hidden elements before a superseding preparation', async () => {
    const element = document.createElement('div');
    element.style.position = 'fixed';
    element.style.display = 'block';
    document.body.append(element);
    document.documentElement.style.overflow = 'scroll';
    const listener = loadHelper();

    await prepare(listener);
    expect(element.style.display).toBe('none');
    expect(document.documentElement.style.overflow).toBe('hidden');

    element.style.position = 'static';
    await prepare(listener);
    expect(element.style.display).toBe('block');
    expect(document.documentElement.style.overflow).toBe('hidden');

    await dispatch(listener, { action: 'resetPageAfterCapture' });
    expect(element.style.display).toBe('block');
    expect(document.documentElement.style.overflow).toBe('scroll');
  });

  it('uses a cleanup watchdog when the caller never sends reset', async () => {
    const element = document.createElement('div');
    element.style.position = 'sticky';
    element.style.display = 'flex';
    document.body.append(element);
    document.documentElement.style.overflow = 'auto';
    const listener = loadHelper();

    await prepare(listener);
    expect(element.style.display).toBe('none');

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(element.style.display).toBe('flex');
    expect(document.documentElement.style.overflow).toBe('auto');
  });
});
