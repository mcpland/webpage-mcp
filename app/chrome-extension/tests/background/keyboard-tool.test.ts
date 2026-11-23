import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withSession: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
  executeScript: vi.fn(),
  tabsSendMessage: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: mocks.withSession,
    attach: mocks.attach,
    detach: mocks.detach,
    sendCommand: mocks.sendCommand,
  },
}));

import { dispatchKeySequence, keyboardTool } from '@/entrypoints/background/tools/browser/keyboard';

function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 7,
    index: 0,
    windowId: 2,
    title: 'Secret',
    url: 'file:///tmp/secret.txt',
    status: 'complete',
    active: true,
    ...overrides,
  } as chrome.tabs.Tab;
}

describe('keyboardTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.withSession.mockReset();
    mocks.attach.mockReset();
    mocks.detach.mockReset();
    mocks.sendCommand.mockReset();
    mocks.executeScript.mockReset();
    mocks.tabsSendMessage.mockReset();
  });

  it.each(['modifier', 'primary', 'not submitted', 'completed'])('balances only the original recipients of a %s chord', async phase => {
    const controller = new AbortController();
    const executeScript = vi.fn().mockResolvedValue([]);
    vi.stubGlobal('chrome', { scripting: { executeScript } });
    mocks.sendCommand.mockImplementation(async (_tab, _method, event, _signal, submitted) => {
      if (phase !== 'not submitted') submitted?.();
      if (phase === 'not submitted' || (phase === 'modifier' && event.key === 'Shift') ||
          (phase === 'primary' && event.code === 'KeyA')) {
        controller.abort();
        throw controller.signal.reason;
      }
    });
    const chord = dispatchKeySequence(7, 'Ctrl+Shift+A', 0, controller.signal, controller.signal);
    if (phase === 'completed') await chord;
    else await expect(chord).rejects.toThrow();
    const [arm, finish] = executeScript.mock.calls.map(([request]) => request as { target: chrome.scripting.InjectionTarget; args: [string, string[], Array<{ code: string; modifiers: number }> | null] });
    expect(arm.target).toEqual({ tabId: 7, allFrames: true });
    expect(arm.args?.[0]).toBe(finish.args?.[0]);
    expect(arm.args?.[2]).toBeNull();
    const keys = finish.args?.[2] as Array<{ code: string; modifiers: number }>;
    expect(keys.map(key => [key.code, key.modifiers])).toEqual(phase === 'modifier'
      ? [['ShiftLeft', 2], ['ControlLeft', 0]] : phase === 'primary'
      ? [['KeyA', 10], ['ShiftLeft', 2], ['ControlLeft', 0]] : []);
    if (phase !== 'completed') expect(mocks.sendCommand.mock.calls.some(([, , e]) => e.type === 'keyUp')).toBe(false);
  });

  it.each(['registration', 'native release'])('handles cancellation while awaiting %s', async phase => {
    const controller = new AbortController();
    let notifyNavigation!: (event: { tabId: number }) => void;
    const onBeforeNavigate = {
      addListener: (listener: typeof notifyNavigation) => { notifyNavigation = listener; },
      removeListener: vi.fn(),
    };
    let resolveReply!: (value: { identifier: string }) => void;
    const delayed = new Promise(resolve => { resolveReply = resolve; });
    const delayedMethod = phase === 'registration' ? 'Page.addScriptToEvaluateOnNewDocument' : 'Input.dispatchKeyEvent';
    const sendCommand = vi.fn(async (_target, method) => method === delayedMethod ? delayed : { identifier: 'preload' });
    const finish = vi.fn();
    const executeScript = vi.fn(async request => {
      if (request.func.name === 'prepareNativeKeyRelease') return [{ documentId: 'original', result: 'focused' }];
      if (Array.isArray(request.args[2])) finish(structuredClone(request.args[2]));
      return [];
    });
    vi.stubGlobal('chrome', {
      debugger: { sendCommand, onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() } },
      scripting: { executeScript },
      webNavigation: { getAllFrames: async () => [{ documentId: 'original' }], onBeforeNavigate },
    });
    const releaseLease = vi.fn();
    const sameSession = vi.fn(() => true);
    mocks.withSession.mockImplementation(async (_tab, _owner, operation) => {
      try { return await operation(sameSession); } finally { releaseLease(); }
    });
    mocks.sendCommand.mockImplementation(async (_tab, _method, event, _signal, submitted) => {
      submitted();
      if (event.code === 'KeyA') { controller.abort(); throw controller.signal.reason; }
    });
    const chord = dispatchKeySequence(7, 'Ctrl+A', 0, controller.signal, controller.signal);
    const cancelled = expect(chord).rejects.toThrow();
    await vi.waitFor(() => expect(sendCommand.mock.calls.some(([, method]) => method === delayedMethod)).toBe(true));
    notifyNavigation({ tabId: 7 });
    await cancelled;
    expect(finish.mock.calls[0][0].map((key: { code: string }) => key.code)).toEqual(['KeyA', 'ControlLeft']);
    if (phase === 'registration') {
      expect(releaseLease).toHaveBeenCalledOnce();
      expect(finish.mock.calls[0][0][0].awaitingNativeAck).toBeUndefined();
    } else {
      expect(releaseLease).not.toHaveBeenCalled();
      expect(finish.mock.calls[0][0][0].awaitingNativeAck).toBe(true);
    }
    resolveReply({ identifier: 'preload' });
    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith({ tabId: 7 },
      'Page.removeScriptToEvaluateOnNewDocument', { identifier: 'preload' }));
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(sendCommand.mock.calls.filter(([, method]) => method === 'Input.dispatchKeyEvent'))
      .toHaveLength(phase === 'registration' ? 0 : 1);
  });

  it('rejects expensive selectors before helper injection', async () => {
    vi.spyOn(keyboardTool as any, 'tryGetTab').mockResolvedValue(
      makeTab({ url: 'https://example.com/' }),
    );
    const injectContentScript = vi
      .spyOn(keyboardTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    const result = await keyboardTool.execute({
      tabId: 7,
      keys: 'Enter',
      selector: 'main:has(button)',
    });

    expect(result.isError).toBe(true);
    expect(injectContentScript).not.toHaveBeenCalled();
  });

  it('uses CDP key dispatch for Enter on public pages', async () => {
    vi.stubGlobal('chrome', {
      runtime: { lastError: null },
      tabs: {
        sendMessage: mocks.tabsSendMessage,
      },
      scripting: {
        executeScript: mocks.executeScript,
      },
    });

    const tryGetTab = vi
      .spyOn(keyboardTool as any, 'tryGetTab')
      .mockResolvedValue(
        makeTab({
          url: 'https://www.google.com/',
        }),
      );
    const injectContentScript = vi
      .spyOn(keyboardTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(keyboardTool as any, 'sendMessageToTab')
      .mockResolvedValueOnce({ success: true, ref: 'ref_1' })
      .mockResolvedValueOnce({ success: true, selector: '#APjFqb' })
      .mockResolvedValueOnce({ success: true });

    const result = await keyboardTool.execute({
      tabId: 7,
      keys: 'Enter',
      selector: '#APjFqb',
    });

    expect(result.isError).toBe(false);
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(injectContentScript).toHaveBeenCalledTimes(2);
    expect(injectContentScript).toHaveBeenNthCalledWith(
      1,
      7,
      ['inject-scripts/accessibility-tree-helper.js'],
      false,
      'ISOLATED',
      false,
      [0],
    );
    expect(injectContentScript).toHaveBeenNthCalledWith(
      2,
      7,
      ['inject-scripts/accessibility-tree-helper.js'],
      false,
      'ISOLATED',
      false,
      [0],
    );
    expect(sendMessageToTab).toHaveBeenCalledWith(
      7,
      {
        action: 'ensureRefForSelector',
        selector: '#APjFqb',
        isXPath: false,
      },
      undefined,
    );
    expect(sendMessageToTab).toHaveBeenCalledWith(
      7,
      {
        action: 'resolveRef',
        ref: 'ref_1',
      },
      undefined,
    );
    expect(sendMessageToTab).toHaveBeenCalledWith(
      7,
      {
        action: 'focusByRef',
        ref: 'ref_1',
      },
      undefined,
    );
    expect(sendMessageToTab).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ action: 'simulateKeyboard' }),
      undefined,
    );
    expect(mocks.attach).toHaveBeenCalledWith(7, 'keyboard');
    // Enter needs its virtual key code and "\r" text to submit forms.
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
        unmodifiedText: '\r',
        modifiers: 0,
        location: 0,
      },
    );
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        modifiers: 0,
        location: 0,
      },
    );
    expect(mocks.detach).toHaveBeenCalledWith(7, 'keyboard');
  });

  it('reuses the resolved iframe context for keyboard fallback after xpath resolution', async () => {
    vi.stubGlobal('chrome', {
      runtime: { lastError: null },
      tabs: {
        sendMessage: mocks.tabsSendMessage,
      },
      scripting: {
        executeScript: mocks.executeScript,
      },
    });

    vi.spyOn(keyboardTool as any, 'tryGetTab').mockResolvedValue(
      makeTab({
        url: 'https://example.com/keyboard',
      }),
    );
    const injectContentScript = vi
      .spyOn(keyboardTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(keyboardTool as any, 'sendMessageToTab')
      .mockResolvedValueOnce({ success: true, ref: 'ref_input' })
      .mockResolvedValueOnce({ success: true, selector: 'input[name="email"]' })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true, message: 'typed' });
    mocks.sendCommand.mockRejectedValueOnce(new Error('cdp key failed'));

    const result = await keyboardTool.execute({
      tabId: 7,
      keys: 'Enter',
      selector: '//input[@name="email"]',
      selectorType: 'xpath',
      frameId: 12,
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse((result.content[0] as { text: string }).text).selector).toBe('input[name="email"]');
    expect(injectContentScript).toHaveBeenNthCalledWith(
      1,
      7,
      ['inject-scripts/accessibility-tree-helper.js'],
      false,
      'ISOLATED',
      false,
      [12],
    );
    expect(injectContentScript).toHaveBeenNthCalledWith(
      2,
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
        action: 'ensureRefForSelector',
        selector: '//input[@name="email"]',
        isXPath: true,
      },
      12,
    );
    expect(sendMessageToTab).toHaveBeenNthCalledWith(
      2,
      7,
      {
        action: 'resolveRef',
        ref: 'ref_input',
      },
      12,
    );
    expect(sendMessageToTab).toHaveBeenNthCalledWith(
      3,
      7,
      {
        action: 'focusByRef',
        ref: 'ref_input',
      },
      12,
    );
    expect(injectContentScript).toHaveBeenNthCalledWith(
      3,
      7,
      ['inject-scripts/keyboard-helper.js'],
      false,
      'ISOLATED',
      false,
      [12],
    );
    expect(sendMessageToTab).toHaveBeenNthCalledWith(
      4,
      7,
      {
        action: 'simulateKeyboard',
        steps: [expect.objectContaining({ kind: 'stroke', token: 'Enter' })],
        keys: 'Enter',
        selector: undefined,
        delay: 50,
        deadline: expect.any(Number),
      },
      12,
    );
  });

  it('returns a bounded error while a fallback key is blocked by a modal', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(keyboardTool as any, 'injectContentScript').mockResolvedValue(undefined);
      vi.spyOn(keyboardTool as any, 'sendMessageToTab').mockReturnValue(new Promise(() => {}));
      const pending = keyboardTool.sendHelperSteps(7, 'Enter', [], 0);
      await vi.advanceTimersByTimeAsync(5100);
      expect((await pending).content[0]).toMatchObject({ text: expect.stringContaining('dialog may be open') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not dispatch fallback keys when an automatic dialog response was requested', async () => {
    const inject = vi.spyOn(keyboardTool as any, 'injectContentScript');
    const result = await keyboardTool.sendHelperSteps(7, 'Enter', [], 0, { dialog: { action: 'accept' } });
    expect(result.isError).toBe(true);
    expect(inject).not.toHaveBeenCalled();
  });

  it('surfaces a failed helper result even when it only has a message', async () => {
    vi.spyOn(keyboardTool as any, 'tryGetTab').mockResolvedValue(makeTab({ url: 'https://example.test/' }));
    vi.spyOn(keyboardTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(keyboardTool as any, 'sendMessageToTab').mockResolvedValue({ success: false, message: 'Edit failed' });
    mocks.attach.mockRejectedValue(new Error('Debugger busy'));
    const result = await keyboardTool.execute({ keys: 'Hello', tabId: 7, background: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Edit failed' });
  });

  it('rejects file URL tabs before simulating keyboard input', async () => {
    const tryGetTab = vi
      .spyOn(keyboardTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab());
    const injectContentScript = vi
      .spyOn(keyboardTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    const result = await keyboardTool.execute({
      tabId: 7,
      keys: 'Enter',
    });

    expect(result.isError).toBe(true);
    expect(
      String((result.content[0] as { text?: string })?.text || ''),
    ).toContain(
      'Only http:// and https:// pages are supported by chrome_keyboard',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(injectContentScript).not.toHaveBeenCalled();
  });

  it('injects accessibility helper into all frames for composite selectors', async () => {
    vi.spyOn(keyboardTool as any, 'tryGetTab').mockResolvedValue(
      makeTab({ url: 'https://example.com/' }),
    );
    const injectContentScript = vi
      .spyOn(keyboardTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    vi.spyOn(keyboardTool as any, 'sendMessageToTab')
      .mockResolvedValueOnce({ success: true, ref: 'ref_1' })
      .mockResolvedValueOnce({ success: true, selector: '#field' })
      .mockResolvedValueOnce({ success: true });
    mocks.attach.mockResolvedValue(undefined);
    mocks.detach.mockResolvedValue(undefined);
    mocks.sendCommand.mockResolvedValue({});

    const result = await keyboardTool.execute({
      tabId: 7,
      keys: 'Enter',
      selector: 'iframe#child |> #field',
      background: true,
    });

    expect(result.isError).toBe(false);
    expect(injectContentScript).toHaveBeenNthCalledWith(
      1,
      7,
      ['inject-scripts/accessibility-tree-helper.js'],
      false,
      'ISOLATED',
      true,
    );
  });

  it('does not fall back to DOM helper when CDP fails after key dispatch starts', async () => {
    vi.spyOn(keyboardTool as any, 'tryGetTab').mockResolvedValue(
      makeTab({ url: 'https://example.com/' }),
    );
    const injectContentScript = vi
      .spyOn(keyboardTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    mocks.attach.mockResolvedValueOnce(undefined);
    mocks.detach.mockResolvedValueOnce(undefined);
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Input.dispatchKeyEvent') throw new Error('Detached mid-key');
      return {};
    });

    const result = await keyboardTool.execute({
      tabId: 7,
      keys: 'Enter',
      background: true,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string }).text)).toContain('Detached mid-key');
    expect(injectContentScript).not.toHaveBeenCalled();
  });
});
