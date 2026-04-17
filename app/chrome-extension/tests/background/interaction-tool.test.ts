import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
  tabsSendMessage: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: mocks.attach,
    detach: mocks.detach,
    sendCommand: mocks.sendCommand,
  },
}));

import {
  clickTool,
  fillTool,
} from '@/entrypoints/background/tools/browser/interaction';

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

describe('interaction tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.attach.mockReset();
    mocks.detach.mockReset();
    mocks.sendCommand.mockReset();
    mocks.tabsSendMessage.mockReset();
  });

  it('uses CDP native click dispatch for public pages', async () => {
    const tryGetTab = vi.spyOn(clickTool as any, 'tryGetTab').mockResolvedValue(
      makeTab({
        url: 'https://www.google.com/',
      }),
    );
    vi.stubGlobal('chrome', {
      runtime: { lastError: null },
      tabs: {
        sendMessage: mocks.tabsSendMessage,
      },
    });
    const injectContentScript = vi
      .spyOn(clickTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    mocks.tabsSendMessage
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: true,
        center: { x: 120, y: 260 },
        rect: {},
        selector: '#btnK',
      });

    const result = await clickTool.execute({
      tabId: 7,
      ref: 'ref_click',
    });

    expect(result.isError).toBe(false);
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(injectContentScript).toHaveBeenCalledWith(
      7,
      ['inject-scripts/accessibility-tree-helper.js'],
      false,
      'ISOLATED',
      false,
      undefined,
    );
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(7, {
      action: 'focusByRef',
      ref: 'ref_click',
    });
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(7, {
      action: 'resolveRef',
      ref: 'ref_click',
    });
    expect(mocks.attach).toHaveBeenCalledWith(7, 'click');
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: 120,
        y: 260,
        button: 'none',
        buttons: 0,
        modifiers: 0,
      },
    );
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: 120,
        y: 260,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      },
    );
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseReleased',
        x: 120,
        y: 260,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
      },
    );
    expect(mocks.detach).toHaveBeenCalledWith(7, 'click');
    expect(mocks.tabsSendMessage).not.toHaveBeenCalledWith(7, {
      action: 'clickElement',
    });
  });

  it('uses projected viewport coordinates for iframe ref clicks', async () => {
    vi.spyOn(clickTool as any, 'tryGetTab').mockResolvedValue(
      makeTab({
        url: 'https://example.com/iframe',
      }),
    );
    vi.stubGlobal('chrome', {
      runtime: { lastError: null },
      tabs: {
        sendMessage: mocks.tabsSendMessage,
      },
    });
    const injectContentScript = vi
      .spyOn(clickTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    mocks.tabsSendMessage
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: true,
        center: { x: 20, y: 30 },
        viewportCenter: { x: 220, y: 330 },
        rect: {},
        selector: '#inside-frame',
      });

    const result = await clickTool.execute({
      tabId: 7,
      ref: 'ref_iframe',
      frameId: 12,
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
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(
      7,
      {
        action: 'focusByRef',
        ref: 'ref_iframe',
      },
      { frameId: 12 },
    );
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(
      7,
      {
        action: 'resolveRef',
        ref: 'ref_iframe',
      },
      { frameId: 12 },
    );
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: 220,
        y: 330,
        button: 'none',
        buttons: 0,
        modifiers: 0,
      },
    );
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: 220,
        y: 330,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      },
    );
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseReleased',
        x: 220,
        y: 330,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
      },
    );
  });

  it('reuses the resolved ref for helper fallback after xpath resolution', async () => {
    vi.spyOn(clickTool as any, 'tryGetTab').mockResolvedValue(
      makeTab({
        url: 'https://example.com/xpath',
      }),
    );
    vi.stubGlobal('chrome', {
      runtime: { lastError: null },
      tabs: {
        sendMessage: mocks.tabsSendMessage,
      },
    });
    const injectContentScript = vi
      .spyOn(clickTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    mocks.tabsSendMessage
      .mockResolvedValueOnce({ success: true, ref: 'ref_xpath' })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: true,
        center: { x: 15, y: 25 },
        viewportCenter: { x: 115, y: 125 },
        rect: {},
        selector: 'button.save',
      })
      .mockResolvedValueOnce({
        success: true,
        navigationOccurred: false,
        elementInfo: {
          clickMethod: 'ref',
          ref: 'ref_xpath',
        },
      });
    mocks.sendCommand.mockRejectedValueOnce(new Error('cdp failed'));

    const result = await clickTool.execute({
      tabId: 7,
      selector: '//button[text()="Save"]',
      selectorType: 'xpath',
      frameId: 12,
    });

    expect(result.isError).toBe(false);
    expect(mocks.tabsSendMessage).toHaveBeenNthCalledWith(
      1,
      7,
      {
        action: 'ensureRefForSelector',
        selector: '//button[text()="Save"]',
        isXPath: true,
      },
      { frameId: 12 },
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
    expect(injectContentScript).toHaveBeenNthCalledWith(
      3,
      7,
      ['inject-scripts/click-helper.js'],
      false,
      'ISOLATED',
      false,
      [12],
    );
    expect(mocks.tabsSendMessage).toHaveBeenNthCalledWith(
      4,
      7,
      {
        action: 'clickElement',
        selector: undefined,
        coordinates: undefined,
        ref: 'ref_xpath',
        waitForNavigation: undefined,
        timeout: undefined,
        double: false,
        button: undefined,
        bubbles: undefined,
        cancelable: undefined,
        modifiers: undefined,
      },
      { frameId: 12 },
    );
  });

  it('maps composite selectors to the resolved child frame before focus and click', async () => {
    vi.spyOn(clickTool as any, 'tryGetTab').mockResolvedValue(
      makeTab({
        url: 'https://example.com/composite',
      }),
    );
    vi.stubGlobal('chrome', {
      runtime: { lastError: null },
      tabs: {
        sendMessage: mocks.tabsSendMessage,
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: 'https://example.com/composite' },
          { frameId: 21, url: 'https://child.example/frame' },
        ]),
      },
    });
    const injectContentScript = vi
      .spyOn(clickTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    mocks.tabsSendMessage
      .mockResolvedValueOnce({
        success: true,
        ref: 'ref_composite',
        href: 'https://child.example/frame',
      })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: true,
        center: { x: 30, y: 40 },
        viewportCenter: { x: 330, y: 440 },
        rect: {},
        selector: '#inside-child',
      });

    const result = await clickTool.execute({
      tabId: 7,
      selector: 'iframe[data-app] |> button.save',
    });

    expect(result.isError).toBe(false);
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
      [21],
    );
    expect(mocks.tabsSendMessage).toHaveBeenNthCalledWith(1, 7, {
      action: 'ensureRefForSelector',
      selector: 'iframe[data-app] |> button.save',
      isXPath: false,
    });
    expect(mocks.tabsSendMessage).toHaveBeenNthCalledWith(
      2,
      7,
      {
        action: 'focusByRef',
        ref: 'ref_composite',
      },
      { frameId: 21 },
    );
    expect(mocks.tabsSendMessage).toHaveBeenNthCalledWith(
      3,
      7,
      {
        action: 'resolveRef',
        ref: 'ref_composite',
      },
      { frameId: 21 },
    );
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: 330,
        y: 440,
        button: 'none',
        buttons: 0,
        modifiers: 0,
      },
    );
  });

  it('rejects file URL tabs before clicking', async () => {
    const tryGetTab = vi
      .spyOn(clickTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab());
    const injectContentScript = vi
      .spyOn(clickTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    const result = await clickTool.execute({
      tabId: 7,
      ref: 'ref_click',
    });

    expect(result.isError).toBe(true);
    expect(
      String((result.content[0] as { text?: string })?.text || ''),
    ).toContain(
      'Only http:// and https:// pages are supported by chrome_click_element',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(injectContentScript).not.toHaveBeenCalled();
  });

  it('rejects file URL tabs before filling', async () => {
    const tryGetTab = vi
      .spyOn(fillTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab());
    const injectContentScript = vi
      .spyOn(fillTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    const result = await fillTool.execute({
      tabId: 7,
      ref: 'ref_fill',
      value: 'secret',
    });

    expect(result.isError).toBe(true);
    expect(
      String((result.content[0] as { text?: string })?.text || ''),
    ).toContain(
      'Only http:// and https:// pages are supported by chrome_fill_or_select',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(injectContentScript).not.toHaveBeenCalled();
  });
});
