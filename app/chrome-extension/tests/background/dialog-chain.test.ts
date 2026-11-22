import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(['explicit', 'automatic'] as const)('keeps the %s responder attached across delayed dialogs', async (mode) => {
  vi.useFakeTimers();
  vi.resetModules();
  let attached = false;
  let opened = 0;
  let answered = 0;
  type Listener = (source: { tabId: number }, method: string, params: object) => void;
  const listeners: Listener[] = [];
  const emit = (method: string, params = {}) => {
    if (attached) listeners.forEach((listener) => listener({ tabId: 7 }, method, params));
  };
  const open = () => {
    opened++;
    emit('Page.javascriptDialogOpening', { type: 'alert', message: 'dialog ' + opened });
  };
  vi.stubGlobal('chrome', {
    ...chrome,
    tabs: { ...chrome.tabs, get: async () => ({ id: 7, windowId: 2, url: 'https://example.test/' }) },
    debugger: {
      getTargets: async () => [],
      attach: async () => { attached = true; },
      detach: async () => { attached = false; },
      onEvent: { addListener: (listener: Listener) => listeners.push(listener) },
      onDetach: { addListener: vi.fn() },
      sendCommand: async (_target: unknown, method: string) => {
        if (method === 'Page.handleJavaScriptDialog') {
          answered++;
          emit('Page.javascriptDialogClosed');
          if (answered === 1) setTimeout(open, 50);
        }
        return {};
      },
    },
  });
  const { handleDialogTool } = await import('@/entrypoints/background/tools/browser/dialog');
  const { runCdpInputWithDialogs } = await import('@/utils/cdp-input');
  const input = runCdpInputWithDialogs(7, 'click', async () => { setTimeout(open, 10); }, {
    dialog: mode === 'automatic' ? { action: 'accept' } : undefined,
  });
  await vi.advanceTimersByTimeAsync(500);
  const result = await input;
  if (mode === 'automatic') {
    expect(result.dialogs?.map((dialog) => dialog.message)).toEqual(['dialog 1', 'dialog 2']);
  } else {
    expect(result.dialog?.handled).toBe(false);
    const first = handleDialogTool.execute({ tabId: 7, action: 'accept' });
    await vi.advanceTimersByTimeAsync(400);
    const content = (await first).content[0];
    expect(content.type === 'text' && JSON.parse(content.text).nextDialog?.message).toBe('dialog 2');
    const second = handleDialogTool.execute({ tabId: 7, action: 'dismiss' });
    await vi.advanceTimersByTimeAsync(400);
    expect((await second).isError).toBe(false);
  }
  expect(answered).toBe(2);
  expect(attached).toBe(false);
});
