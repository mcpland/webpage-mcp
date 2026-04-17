import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
  executeScript: vi.fn(),
  tabsSendMessage: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: mocks.attach,
    detach: mocks.detach,
    sendCommand: mocks.sendCommand,
  },
}));

import { keyboardTool } from '@/entrypoints/background/tools/browser/keyboard';

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
    mocks.attach.mockReset();
    mocks.detach.mockReset();
    mocks.sendCommand.mockReset();
    mocks.executeScript.mockReset();
    mocks.tabsSendMessage.mockReset();
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
      undefined,
    );
    expect(injectContentScript).toHaveBeenNthCalledWith(
      2,
      7,
      ['inject-scripts/accessibility-tree-helper.js'],
      false,
      'ISOLATED',
      false,
      undefined,
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
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchKeyEvent',
      {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        text: undefined,
      },
    );
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
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
        keys: 'Enter',
        selector: undefined,
        delay: 50,
      },
      12,
    );
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
});
