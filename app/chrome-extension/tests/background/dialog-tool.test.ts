import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  withSession: vi.fn(),
  sendCommand: vi.fn(),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: mocks.attach,
    detach: mocks.detach,
    withSession: mocks.withSession,
    sendCommand: mocks.sendCommand,
  },
}));

import { handleDialogTool } from '@/entrypoints/background/tools/browser/dialog';

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

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  String(result.content[0]?.text || '');

describe('handleDialogTool', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.attach.mockResolvedValue(undefined);
    mocks.detach.mockResolvedValue(undefined);
    mocks.withSession.mockImplementation(async (_tabId, _scope, fn) => await fn());
    mocks.sendCommand.mockResolvedValue(undefined);
    mocks.tabsGet.mockResolvedValue(makeTab());
    mocks.tabsQuery.mockResolvedValue([makeTab()]);

    vi.stubGlobal('chrome', {
      tabs: {
        get: mocks.tabsGet,
        query: mocks.tabsQuery,
        onRemoved: { addListener: vi.fn() },
      },
      debugger: {
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('rejects non-public tabs before attempting to handle a dialog', async () => {
    mocks.tabsQuery.mockResolvedValueOnce([makeTab({ url: 'file:///tmp/secret.txt' })]);

    const result = await handleDialogTool.execute({
      action: 'dismiss',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      'Only http:// and https:// pages are supported by chrome_handle_dialog',
    );
    expect(mocks.withSession).not.toHaveBeenCalled();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });

  it('answers the dialog without first enabling the Page domain', async () => {
    const result = await handleDialogTool.execute({
      tabId: 7,
      action: 'accept',
      promptText: 'Ada',
    });

    expect(result.isError).toBe(false);
    expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'Page.handleJavaScriptDialog', {
      accept: true,
      promptText: 'Ada',
    }, expect.any(AbortSignal));
    // Page.enable blocks while a dialog holds the renderer.
    expect(mocks.sendCommand.mock.calls.map((call) => call[1])).not.toContain('Page.enable');
  });

  it('explains an untracked dialog that keeps the page blocked', async () => {
    vi.useFakeTimers();
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Page.handleJavaScriptDialog') {
        throw new Error('{"code":-32602,"message":"No dialog is showing"}');
      }
      if (method === 'Runtime.evaluate') return new Promise(() => {});
      return undefined;
    });

    const pending = handleDialogTool.execute({ tabId: 7, action: 'dismiss' });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('opened while no debugger session was observing the page');
    expect(textOf(result)).toContain('chrome_navigate({ refresh: true })');
  });

  it('reports that no dialog is open when the page is responsive', async () => {
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Page.handleJavaScriptDialog') throw new Error('No dialog is showing');
      return { result: { value: 1 } };
    });

    const result = await handleDialogTool.execute({ tabId: 7, action: 'accept' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('No JavaScript dialog is open on this tab.');
  });
});
