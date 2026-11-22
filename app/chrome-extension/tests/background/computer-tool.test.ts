import { afterEach, describe, expect, it, vi } from 'vitest';

import { computerTool } from '@/entrypoints/background/tools/browser/computer';
import { keyboardTool } from '@/entrypoints/background/tools/browser/keyboard';
import { clickTool, fillTool } from '@/entrypoints/background/tools/browser/interaction';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

import { screenshotContextManager } from '@/utils/screenshot-context';

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

  it.each([
    ['left_click', { ref: 'ref_3' }, 'click'],
    ['right_click', { selector: '#menu' }, 'click'],
    ['left_click', { coordinates: { x: 10, y: 20 } }, 'click'],
    ['fill', { ref: 'ref_3', value: 'x' }, 'fill'],
    ['type', { ref: 'ref_3', text: 'x' }, 'click'],
  ] as const)(
    'forwards background=true when %s delegates (%o)',
    async (action, extra, delegate) => {
      vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab({ active: false }));
      const ok = { content: [{ type: 'text', text: '{"success":true}' }], isError: false };
      const click = vi.spyOn(clickTool, 'execute').mockResolvedValue(ok as any);
      const fill = vi.spyOn(fillTool, 'execute').mockResolvedValue(ok as any);
      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      await computerTool.execute({ tabId: 7, action, background: true, ...extra } as any);

      const spy = delegate === 'click' ? click : fill;
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][0]).toMatchObject({ background: true, tabId: 7 });
    },
  );

  it('delivers fallback keys to the frame encoded in the focused ref', async () => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    vi.spyOn(clickTool, 'execute').mockResolvedValue({ content: [], isError: false });
    vi.spyOn(cdpSessionManager, 'attach').mockRejectedValue(new Error('Debugger busy'));
    vi.spyOn(keyboardTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    vi.spyOn(keyboardTool as any, 'injectContentScript').mockResolvedValue(undefined);
    const send = vi.spyOn(keyboardTool as any, 'sendMessageToTab').mockResolvedValue({ success: true });
    const result = await computerTool.execute({ tabId: 7, background: true, action: 'key', text: 'Enter', ref: 'f12:ref_1' });
    expect(result.isError).toBe(false);
    expect(send).toHaveBeenCalledWith(7, expect.objectContaining({ action: 'simulateKeyboard' }), 12);
  });

  it('preserves a literal comma and repeats parsed fallback strokes without retrying CDP', async () => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    const attach = vi.spyOn(cdpSessionManager, 'attach').mockRejectedValue(new Error('Debugger busy'));
    const helper = vi.spyOn(keyboardTool, 'sendHelperSteps').mockResolvedValue({ content: [], isError: false });
    await computerTool.execute({ tabId: 7, background: true, action: 'key', text: 'a , b', repeat: 2 });
    expect(attach).toHaveBeenCalledOnce();
    expect(helper.mock.calls[0][2].map((step) => step.kind === 'stroke' && step.stroke.key.key))
      .toEqual(['a', ',', 'b', 'a', ',', 'b']);
  });

  it.each([true, false])('honors background=%s when falling back to DOM typing', async (background) => {
    const tab = makeTab({ active: false });
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(tab);
    vi.spyOn(cdpSessionManager, 'attach').mockRejectedValue(new Error('Debugger busy'));
    const activate = vi.spyOn(computerTool as any, 'activateTabIfNeeded').mockResolvedValue(tab);
    vi.spyOn(keyboardTool, 'sendHelperSteps').mockResolvedValue({ content: [], isError: false });
    await computerTool.execute({ tabId: 7, background, action: 'type', text: 'text' });
    expect(activate).toHaveBeenCalledTimes(background ? 0 : 1);
  });

  it.each(['type', 'key'] as const)(
    'does not %s into the focused element when the ref cannot be focused',
    async (action) => {
      vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab());
      vi.spyOn(clickTool, 'execute').mockResolvedValue({
        content: [{ type: 'text', text: 'ref "ref_9" not found or expired' }],
        isError: true,
      });
      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      const sendCommand = vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      const result = await computerTool.execute({
        tabId: 7,
        action,
        ref: 'ref_9',
        text: action === 'type' ? 'WRONG' : 'Enter',
      } as any);

      expect(result.isError).toBe(true);
      expect(String((result.content[0] as { text?: string }).text)).toContain(
        'not found or expired',
      );
      expect(sendCommand).not.toHaveBeenCalled();
    },
  );

  it('reports per-element fill_form errors and fails when nothing was filled', async () => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    const fill = vi.spyOn(fillTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: 'Element not found: #missing' }],
      isError: true,
    });

    const result = await computerTool.execute({
      tabId: 7,
      action: 'fill_form',
      elements: [
        { ref: 'ref_1', value: 'a' },
        { selector: '#missing', value: 'b' },
        { value: 'c' },
      ],
    } as any);
    const payload = JSON.parse(String((result.content[0] as { text?: string }).text));

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ success: false, filled: 0, total: 3 });
    expect(payload.results[0]).toEqual({ ref: 'ref_1', ok: false, error: 'Element not found: #missing' });
    expect(payload.results[1]).toMatchObject({ selector: '#missing', ok: false });
    expect(payload.results[2]).toEqual({ ok: false, error: 'missing ref or selector' });
    expect(fill.mock.calls[1][0]).toMatchObject({ selector: '#missing' });
  });

  it.each([
    [{ ref: 'ref_7' }, 1000, 500],
    [{ selector: '#target' }, 1000, 500],
    [{ coordinates: { x: 784, y: 441 } }, 960, 540],
  ] as const)('projects only screenshot coordinates when hovering with %o', async (target, x, y) => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    vi.spyOn(computerTool as any, 'injectAccessibilityHelper').mockResolvedValue(undefined);
    vi.spyOn(computerTool as any, 'sendMessageToTab').mockResolvedValue({
      success: true, viewportCenter: { x: 1000, y: 500 },
    });
    vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
    vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
    const send = vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});
    screenshotContextManager.setContext(7, {
      screenshotWidth: 1568, screenshotHeight: 882, viewportWidth: 1920, viewportHeight: 1080,
    });
    try {
      const result = await computerTool.execute({
        tabId: 7, action: 'hover', duration: 0, background: true, ...target,
      });
      expect(result.isError).toBe(false);
      expect(send).toHaveBeenCalledWith(7, 'Input.dispatchMouseEvent', expect.objectContaining({ x, y }));
    } finally {
      screenshotContextManager.clear(7);
    }
  });

  it('scrolls at the viewport center when no coordinates or ref are given', async () => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
    vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
    const sendCommand = vi
      .spyOn(cdpSessionManager, 'sendCommand')
      .mockImplementation(async (_tabId: number, method: string) =>
        method === 'Page.getLayoutMetrics'
          ? { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } }
          : {},
      );

    const result = await computerTool.execute({
      tabId: 7,
      action: 'scroll',
      scrollDirection: 'down',
    } as any);

    expect(result.isError).toBe(false);
    expect(sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseWheel', x: 640, y: 360, deltaY: 300 }),
    );
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

  it('returns clickTool errors for coordinate left_click instead of falling through to raw CDP', async () => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    vi.spyOn(clickTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: 'Invalid waitForDownload timeoutMs' }],
      isError: true,
    });
    const sendCommand = vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

    const result = await computerTool.execute({
      tabId: 7,
      action: 'left_click',
      coordinates: { x: 20, y: 30 },
      waitForDownload: { timeoutMs: 5 },
    } as any);

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string }).text)).toContain('Invalid waitForDownload');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('reports PageUnresponsiveError when targetless scroll hits a blocked page', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab());
      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) =>
        method === 'Page.enable' ? new Promise(() => {}) : {},
      );

      const pending = computerTool.execute({
        tabId: 7,
        action: 'scroll',
        scrollDirection: 'down',
      } as any);
      await vi.advanceTimersByTimeAsync(2500);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(String((result.content[0] as { text?: string }).text)).toContain('not responding');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects whitespace-only key actions', async () => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab());

    const result = await computerTool.execute({
      tabId: 7,
      action: 'key',
      text: '   ',
    } as any);

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string }).text)).toContain(
      'text is required for key action',
    );
  });

  it('does not fall back to DOM typing when CDP fails after input dispatch starts', async () => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
    vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
      if (method === 'Input.insertText') throw new Error('Detached mid-type');
      return {};
    });
    const helper = vi.spyOn(keyboardTool, 'sendHelperSteps');

    const result = await computerTool.execute({
      tabId: 7,
      action: 'type',
      text: 'hello',
      background: true,
    } as any);

    expect(result.isError).toBe(true);
    expect(helper).not.toHaveBeenCalled();
  });

  it('targets the child frame when domHoverFallback runs with a ref and frameId', async () => {
    const injectHelper = vi
      .spyOn(computerTool as any, 'injectAccessibilityHelper')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(computerTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true, target: { tagName: 'DIV' } });

    const result = await (computerTool as any).domHoverFallback(
      7,
      { x: 10, y: 20 },
      'ref',
      'ref_1',
      12,
    );

    expect(result.isError).toBe(false);
    expect(injectHelper).toHaveBeenCalledWith(7, 12);
    expect(sendMessageToTab).toHaveBeenCalledWith(
      7,
      { action: 'dispatchHoverForRef', ref: 'ref_1' },
      12,
    );
  });
});
