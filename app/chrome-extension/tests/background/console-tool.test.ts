import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consoleTool } from '@/entrypoints/background/tools/browser/console';
import { consoleBuffer } from '@/entrypoints/background/tools/browser/console-buffer';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

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

describe('consoleTool', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(),
        query: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      windows: {
        update: vi.fn(),
      },
      debugger: {
        onEvent: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects file URLs before navigating', async () => {
    const tabsCreate = chrome.tabs.create as ReturnType<typeof vi.fn>;

    const result = await consoleTool.execute({
      url: 'file:///tmp/secret.txt',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_console',
    );
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('rejects file URL tabs before attaching the debugger', async () => {
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const attach = vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);

    const result = await consoleTool.execute({
      tabId: 7,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_console',
    );
    expect(tabsGet).toHaveBeenCalledWith(7);
    expect(attach).not.toHaveBeenCalled();
  });

  it('redacts non-public urls from snapshot console results', async () => {
    vi.useFakeTimers();

    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab());

    let eventListener:
      | ((source: chrome.debugger.Debuggee, method: string, params?: any) => void)
      | undefined;
    const addListener = chrome.debugger.onEvent.addListener as ReturnType<typeof vi.fn>;
    addListener.mockImplementation((listener) => {
      eventListener = listener;
    });

    vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
    vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
      if (method === 'Log.enable' && eventListener) {
        eventListener(
          { tabId: 7 },
          'Log.entryAdded',
          {
            entry: {
              timestamp: 1,
              level: 'log',
              text: 'blob log',
              url: 'blob:https://example.com/asset',
              lineNumber: 12,
              stackTrace: {
                callFrames: [{ url: 'data:text/plain,stack', lineNumber: 9 }],
              },
            },
          },
        );
        eventListener(
          { tabId: 7 },
          'Runtime.exceptionThrown',
          {
            exceptionDetails: {
              text: 'boom',
              url: 'chrome-extension://extension-id/script.js',
              lineNumber: 4,
              columnNumber: 5,
              stackTrace: {
                callFrames: [{ url: 'blob:https://example.com/error-stack', lineNumber: 2 }],
              },
            },
          },
        );
      }
      return {};
    });

    const promise = consoleTool.execute({ tabId: 7 });
    await vi.runAllTimersAsync();
    const result = await promise;
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(payload.messages[0]).toMatchObject({
      url: null,
      urlRedacted: true,
    });
    expect(payload.messages[0].stackTrace.callFrames[0]).toMatchObject({
      url: null,
      urlRedacted: true,
    });
    expect(payload.exceptions[0]).toMatchObject({
      url: null,
      urlRedacted: true,
    });
    expect(payload.exceptions[0].stackTrace.callFrames[0]).toMatchObject({
      url: null,
      urlRedacted: true,
    });
  });

  it('redacts non-public urls from buffer console results', async () => {
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab());

    vi.spyOn(consoleBuffer, 'ensureStarted').mockResolvedValue(undefined);
    vi.spyOn(consoleBuffer, 'read').mockReturnValue({
      tabId: 7,
      tabUrl: 'https://example.com/',
      tabTitle: 'Example',
      captureStartTime: 10,
      captureEndTime: 20,
      totalDurationMs: 10,
      messages: [
        {
          timestamp: 11,
          level: 'log',
          text: 'buffered',
          url: 'blob:https://example.com/buffered',
          stackTrace: {
            callFrames: [{ url: 'data:text/plain,buffer-stack', lineNumber: 8 }],
          },
        },
      ],
      exceptions: [
        {
          timestamp: 12,
          text: 'buffered error',
          url: 'chrome-extension://extension-id/buffer-error.js',
        },
      ],
      totalBufferedMessages: 1,
      totalBufferedExceptions: 1,
      messageCount: 1,
      exceptionCount: 1,
      messageLimitReached: false,
      droppedMessageCount: 0,
      droppedExceptionCount: 0,
    });

    const result = await consoleTool.execute({ tabId: 7, mode: 'buffer' });
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(payload.messages[0]).toMatchObject({
      url: null,
      urlRedacted: true,
    });
    expect(payload.messages[0].stackTrace.callFrames[0]).toMatchObject({
      url: null,
      urlRedacted: true,
    });
    expect(payload.exceptions[0]).toMatchObject({
      url: null,
      urlRedacted: true,
    });
  });
});
