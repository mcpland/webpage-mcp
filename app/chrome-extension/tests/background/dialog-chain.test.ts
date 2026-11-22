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

function stubLateFollowUp(options: { reportFollowUpAfterMs?: number }) {
  const state = { attached: false, answered: 0, blocked: false };
  type Listener = (source: { tabId: number }, method: string, params: object) => void;
  const listeners: Listener[] = [];
  const emit = (method: string, params = {}) => {
    if (state.attached) listeners.forEach((listener) => listener({ tabId: 7 }, method, params));
  };
  vi.stubGlobal('chrome', {
    ...chrome,
    tabs: { ...chrome.tabs, get: async () => ({ id: 7, windowId: 2, url: 'https://example.test/' }) },
    debugger: {
      getTargets: async () => [],
      attach: async () => { state.attached = true; },
      detach: async () => { state.attached = false; },
      onEvent: { addListener: (listener: Listener) => listeners.push(listener) },
      onDetach: { addListener: vi.fn() },
      sendCommand: async (_target: unknown, method: string) => {
        // A page showing a dialog cannot evaluate script.
        if (method === 'Runtime.evaluate' && state.blocked) return new Promise(() => {});
        if (method === 'Page.handleJavaScriptDialog') {
          state.answered++;
          state.blocked = false;
          emit('Page.javascriptDialogClosed');
          if (state.answered === 1) {
            // The handler shows an alert right away; Chrome reports it late, or never.
            setTimeout(() => { state.blocked = true; }, 50);
            if (options.reportFollowUpAfterMs !== undefined) {
              setTimeout(
                () => emit('Page.javascriptDialogOpening', { type: 'alert', message: 'late' }),
                options.reportFollowUpAfterMs,
              );
            }
          }
        }
        return {};
      },
    },
  });
  const openFirst = () =>
    setTimeout(() => emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'first' }), 10);
  return { state, openFirst };
}

it.each(['explicit', 'automatic'] as const)(
  'waits for a %s follow-up dialog that blocks the page before Chrome reports it',
  async (mode) => {
    vi.useFakeTimers();
    vi.resetModules();
    const { state, openFirst } = stubLateFollowUp({ reportFollowUpAfterMs: 700 });
    const { handleDialogTool } = await import('@/entrypoints/background/tools/browser/dialog');
    const { runCdpInputWithDialogs } = await import('@/utils/cdp-input');

    const input = runCdpInputWithDialogs(7, 'click', async () => { openFirst(); }, {
      dialog: mode === 'automatic' ? { action: 'accept' } : undefined,
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await input;
    if (mode === 'automatic') {
      expect(result.dialogs?.map((dialog) => dialog.message)).toEqual(['first', 'late']);
    } else {
      expect(result.dialog?.handled).toBe(false);
      const first = handleDialogTool.execute({ tabId: 7, action: 'accept' });
      await vi.advanceTimersByTimeAsync(2000);
      const content = (await first).content[0];
      expect(content.type === 'text' && JSON.parse(content.text).nextDialog?.message).toBe('late');
      const second = handleDialogTool.execute({ tabId: 7, action: 'dismiss' });
      await vi.advanceTimersByTimeAsync(2000);
      expect((await second).isError).toBe(false);
    }
    expect(state.answered).toBe(2);
    expect(state.attached).toBe(false);
  },
);

it('stops waiting for an unreported follow-up dialog after a bounded time', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const { state, openFirst } = stubLateFollowUp({});
  const { runCdpInputWithDialogs } = await import('@/utils/cdp-input');

  let settled = false;
  const input = runCdpInputWithDialogs(7, 'click', async () => { openFirst(); }, {
    dialog: { action: 'accept' },
  }).finally(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(3500);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  const result = await input;

  expect(settled).toBe(true);
  expect(result.dialog?.message).toBe('first');
  expect(result.dialogs).toBeUndefined();
  expect(state.attached).toBe(false);
});

it('keeps dialog tracking intact when a stale local onDetach arrives during a new session', async () => {
  vi.resetModules();
  let attached = false;
  type EventListener = (source: { tabId: number }, method: string, params: object) => void;
  type DetachListener = (source: { tabId: number }, reason: string) => void;
  const eventListeners: EventListener[] = [];
  const detachListeners: DetachListener[] = [];
  vi.stubGlobal('chrome', {
    ...chrome,
    runtime: { ...chrome.runtime, id: 'ext-id' },
    tabs: { ...chrome.tabs, get: async () => ({ id: 7, windowId: 2, url: 'https://example.test/' }) },
    debugger: {
      getTargets: async () => (attached ? [{ tabId: 7, attached: true, extensionId: 'ext-id' }] : []),
      attach: async () => { attached = true; },
      detach: async () => { attached = false; },
      onEvent: { addListener: (l: EventListener) => eventListeners.push(l) },
      onDetach: {
        addListener: (l: DetachListener) => detachListeners.push(l),
        removeListener: vi.fn(),
      },
      sendCommand: async () => ({}),
    },
  });

  const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
  const { dialogTracker } = await import('@/utils/dialog-tracker');
  dialogTracker.ensureListening();

  // First session attaches and detaches locally; Chrome will deliver its onDetach late.
  await cdpSessionManager.attach(7, 'first');
  await cdpSessionManager.detach(7, 'first');

  // Second session attaches and observes a dialog.
  await cdpSessionManager.attach(7, 'second');
  eventListeners.forEach((l) =>
    l({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Still here?' }),
  );
  expect(dialogTracker.get(7)?.message).toBe('Still here?');

  // Stale local detach notification arrives late: must NOT clear the active dialog.
  detachListeners.forEach((l) => l({ tabId: 7 }, 'canceled_by_user'));
  expect(dialogTracker.get(7)?.message).toBe('Still here?');

  await cdpSessionManager.detach(7, 'second');
  dialogTracker.forget(7);
});
