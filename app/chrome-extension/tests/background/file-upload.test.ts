import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withSession: vi.fn(),
  sendCommand: vi.fn(),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
  runtimeSendMessage: vi.fn(),
  runtimeAddListener: vi.fn(),
  runtimeRemoveListener: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: mocks.withSession,
    sendCommand: mocks.sendCommand,
  },
}));

import { fileUploadTool } from '@/entrypoints/background/tools/browser/file-upload';

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

describe('fileUploadTool', () => {
  let runtimeListeners: Array<(message: any) => void> = [];

  beforeEach(() => {
    runtimeListeners = [];
    Object.values(mocks).forEach((mock) => mock.mockReset());

    mocks.withSession.mockImplementation(async (_tabId, _scope, fn) => await fn());
    mocks.sendCommand.mockImplementation(async (_tabId, method, params) => {
      if (method === 'DOM.getDocument') {
        return { root: { nodeId: 1 } };
      }
      if (method === 'DOM.querySelector') {
        return { nodeId: 2 };
      }
      if (method === 'DOM.describeNode') {
        return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } };
      }
      if (method === 'DOM.setFileInputFiles') {
        return { files: params.files };
      }
      return {};
    });
    mocks.tabsGet.mockResolvedValue(makeTab());
    mocks.tabsQuery.mockResolvedValue([makeTab()]);
    mocks.runtimeAddListener.mockImplementation((listener) => {
      runtimeListeners.push(listener);
    });
    mocks.runtimeRemoveListener.mockImplementation((listener) => {
      runtimeListeners = runtimeListeners.filter((entry) => entry !== listener);
    });
    mocks.runtimeSendMessage.mockImplementation(async (message) => {
      const requestId = message?.message?.requestId;
      if (typeof requestId === 'string') {
        queueMicrotask(() => {
          runtimeListeners.forEach((listener) =>
            listener({
              type: 'file_operation_response',
              responseToRequestId: requestId,
              payload: {
                success: true,
                filePath: '/tmp/prepared-upload.txt',
              },
            }),
          );
        });
      }
      return undefined;
    });

    vi.stubGlobal('chrome', {
      tabs: {
        get: mocks.tabsGet,
        query: mocks.tabsQuery,
      },
      runtime: {
        onMessage: {
          addListener: mocks.runtimeAddListener,
          removeListener: mocks.runtimeRemoveListener,
        },
        sendMessage: mocks.runtimeSendMessage,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('rejects direct local file paths before touching the browser or native host', async () => {
    const result = await fileUploadTool.execute({
      selector: 'input[type="file"]',
      filePath: '/tmp/secret.txt',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Direct local file paths are not supported',
    );
    expect(mocks.tabsGet).not.toHaveBeenCalled();
    expect(mocks.runtimeSendMessage).not.toHaveBeenCalled();
    expect(mocks.withSession).not.toHaveBeenCalled();
  });

  it('still uploads files prepared from base64 payloads', async () => {
    const result = await fileUploadTool.execute({
      selector: '#upload',
      base64Data: 'Zm9v',
      fileName: 'example.txt',
      tabId: 7,
    });

    expect(result.isError).toBe(false);
    expect(mocks.runtimeSendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.withSession).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'DOM.setFileInputFiles', {
      nodeId: 2,
      files: ['/tmp/prepared-upload.txt'],
    });
  });
});
