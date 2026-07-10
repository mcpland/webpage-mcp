import { afterEach, describe, expect, it, vi } from 'vitest';

import { computerTool } from '@/entrypoints/background/tools/browser/computer';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

const nativeMouseEvent = window.MouseEvent;

function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 7,
    index: 0,
    windowId: 2,
    title: 'Example',
    url: 'https://example.com/',
    status: 'complete',
    active: true,
    ...overrides,
  } as chrome.tabs.Tab;
}

describe('computerTool', () => {
  afterEach(() => {
    delete (document as any).elementFromPoint;
    delete (chrome as any).scripting;
    Object.defineProperty(window, 'MouseEvent', {
      configurable: true,
      value: nativeMouseEvent,
    });
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('rejects file URL tabs before zoom screenshots', async () => {
    const tryGetTab = vi
      .spyOn(computerTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const getActiveTabOrThrowInWindow = vi
      .spyOn(computerTool as any, 'getActiveTabOrThrowInWindow')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const attach = vi
      .spyOn(cdpSessionManager, 'attach')
      .mockResolvedValue(undefined);
    const sendCommand = vi
      .spyOn(cdpSessionManager, 'sendCommand')
      .mockResolvedValue({});

    const result = await computerTool.execute({
      tabId: 7,
      action: 'zoom',
      region: { x0: 0, y0: 0, x1: 100, y1: 100 },
    });

    expect(result.isError).toBe(true);
    expect(
      String((result.content[0] as { text?: string })?.text || ''),
    ).toContain(
      'Only http:// and https:// pages are supported by chrome_computer zoom',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(getActiveTabOrThrowInWindow).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('rejects file URL tabs before hover can fall back to DOM access', async () => {
    const tryGetTab = vi
      .spyOn(computerTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const sendMessageToTab = vi
      .spyOn(computerTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true });
    const attach = vi
      .spyOn(cdpSessionManager, 'attach')
      .mockResolvedValue(undefined);

    const result = await computerTool.execute({
      tabId: 7,
      action: 'hover',
      coordinates: { x: 10, y: 10 },
    });

    expect(result.isError).toBe(true);
    expect(
      String((result.content[0] as { text?: string })?.text || ''),
    ).toContain(
      'Only http:// and https:// pages are supported by chrome_computer',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(sendMessageToTab).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it('rejects file URL tabs before typing via CDP or keyboard fallback', async () => {
    const tryGetTab = vi
      .spyOn(computerTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const attach = vi
      .spyOn(cdpSessionManager, 'attach')
      .mockResolvedValue(undefined);

    const result = await computerTool.execute({
      tabId: 7,
      action: 'type',
      text: 'secret',
    });

    expect(result.isError).toBe(true);
    expect(
      String((result.content[0] as { text?: string })?.text || ''),
    ).toContain(
      'Only http:// and https:// pages are supported by chrome_computer',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(attach).not.toHaveBeenCalled();
  });

  it('uses projected viewport coordinates for iframe hover targets', async () => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    const injectContentScript = vi
      .spyOn(computerTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(computerTool as any, 'sendMessageToTab')
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: true,
        center: { x: 25, y: 35 },
        viewportCenter: { x: 225, y: 335 },
      });
    const attach = vi
      .spyOn(cdpSessionManager, 'attach')
      .mockResolvedValue(undefined);
    const detach = vi
      .spyOn(cdpSessionManager, 'detach')
      .mockResolvedValue(undefined);
    const sendCommand = vi
      .spyOn(cdpSessionManager, 'sendCommand')
      .mockResolvedValue({});

    const result = await computerTool.execute({
      tabId: 7,
      action: 'hover',
      ref: 'ref_iframe_hover',
      frameId: 12,
      duration: 0,
    });

    expect(result.isError).toBe(false);
    expect(injectContentScript).toHaveBeenCalledWith(
      7,
      ['inject-scripts/accessibility-tree-helper.js'],
      false,
      'ISOLATED',
      false,
      [12],
    );
    expect(sendMessageToTab).toHaveBeenNthCalledWith(
      1,
      7,
      {
        action: 'focusByRef',
        ref: 'ref_iframe_hover',
      },
      12,
    );
    expect(sendMessageToTab).toHaveBeenNthCalledWith(
      2,
      7,
      {
        action: 'resolveRef',
        ref: 'ref_iframe_hover',
      },
      12,
    );
    expect(attach).toHaveBeenCalledWith(7, 'computer');
    expect(sendCommand).toHaveBeenCalledWith(7, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 225,
      y: 335,
      modifiers: 0,
      button: 'none',
      buttons: 0,
    });
    expect(detach).toHaveBeenCalledWith(7, 'computer');
  });

  it('bounds DOM hover text without materializing the target subtree', async () => {
    const target = document.createElement('div');
    target.append(document.createTextNode('Bounded hover label'));
    Object.defineProperty(target, 'textContent', {
      configurable: true,
      get: () => {
        throw new Error('textContent must not be materialized');
      },
    });
    document.body.append(target);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn().mockReturnValue(target),
    });
    Object.defineProperty(window, 'MouseEvent', {
      configurable: true,
      value: function MouseEventForTest(type: string, init: MouseEventInit = {}) {
        return new window.Event(type, {
          bubbles: init.bubbles,
          cancelable: init.cancelable,
        });
      },
    });
    const executeScript = vi.fn(async ({ func, args }: any) => [
      { result: await func(...args) },
    ]);
    (chrome as any).scripting = { executeScript };

    const result = await (computerTool as any).domHoverFallback(
      7,
      { x: 5, y: 5 },
      'coordinates',
    );

    expect(result.isError).toBe(false);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.target.text).toBe('Bounded hover label');
  });
});
