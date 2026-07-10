import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withSession: vi.fn(),
  sendCommand: vi.fn(),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
  runtimeSendMessage: vi.fn(),
  runtimeAddListener: vi.fn(),
  runtimeRemoveListener: vi.fn(),
  fetch: vi.fn(),
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
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'file-input-object' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        if (String(params.functionDeclaration).includes('isFileInput')) {
          return { result: { value: { isInput: true, isFileInput: true } } };
        }
        return { result: { value: true } };
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
      const action = message?.message?.payload?.action;
      if (typeof requestId === 'string') {
        queueMicrotask(() => {
          runtimeListeners.forEach((listener) =>
            listener({
              type: 'file_operation_response',
              responseToRequestId: requestId,
              payload:
                action === 'cleanupFile'
                  ? { success: true }
                  : {
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
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('rejects file URLs before fetching or touching the browser', async () => {
    const result = await fileUploadTool.execute({
      selector: 'input[type="file"]',
      fileUrl: 'file:///tmp/secret.txt',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// URLs are allowed for fileUrl uploads',
    );
    expect(mocks.runtimeSendMessage).not.toHaveBeenCalled();
    expect(mocks.withSession).not.toHaveBeenCalled();
  });

  it('rejects non-public target pages before touching CDP or the native host', async () => {
    mocks.tabsGet.mockResolvedValueOnce(makeTab({ url: 'file:///tmp/secret.txt' }));

    const result = await fileUploadTool.execute({
      selector: '#upload',
      base64Data: 'Zm9v',
      tabId: 7,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_upload_file',
    );
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
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(result.isError).toBe(false);
    expect(mocks.runtimeSendMessage).toHaveBeenCalledTimes(2);
    expect(
      mocks.runtimeSendMessage.mock.calls.map(([message]) => message.message.payload.action),
    ).toEqual(['prepareFile', 'cleanupFile']);
    expect(mocks.withSession).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'DOM.setFileInputFiles', {
      nodeId: 2,
      files: ['/tmp/prepared-upload.txt'],
    });
    expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'DOM.getDocument', {
      depth: 0,
      pierce: true,
    });
    expect(mocks.sendCommand).not.toHaveBeenCalledWith(
      7,
      'DOM.describeNode',
      expect.anything(),
    );
    expect(mocks.sendCommand).not.toHaveBeenCalledWith(
      7,
      'Runtime.evaluate',
      expect.anything(),
    );
    expect(payload).toMatchObject({
      success: true,
      files: ['prepared-upload.txt'],
      fileCount: 1,
      pathRedacted: true,
    });
  });

  it('cleans up native temporary files when CDP upload fails', async () => {
    mocks.sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === 'DOM.getDocument') {
        return { root: { nodeId: 1 } };
      }
      if (method === 'DOM.querySelector') {
        return { nodeId: 0 };
      }
      return {};
    });

    const result = await fileUploadTool.execute({
      selector: '#missing-upload',
      base64Data: 'Zm9v',
      fileName: 'example.txt',
      tabId: 7,
    });

    expect(result.isError).toBe(true);
    expect(
      mocks.runtimeSendMessage.mock.calls.map(([message]) => message.message.payload.action),
    ).toEqual(['prepareFile', 'cleanupFile']);
    expect(mocks.runtimeSendMessage.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          payload: {
            action: 'cleanupFile',
            filePath: '/tmp/prepared-upload.txt',
          },
        }),
      }),
    );
  });

  it('rejects base64 payloads larger than the single-file limit without logging their contents', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const maximumBytes = 16 * 1024 * 1024;
    const oversizedBase64 = 'A'.repeat(Math.ceil(((maximumBytes + 1) * 4) / 3));

    const result = await fileUploadTool.execute({
      selector: '#upload',
      base64Data: oversizedBase64,
      fileName: 'oversized.bin',
      tabId: 7,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'exceeds the 16 MiB limit',
    );
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(oversizedBase64.slice(0, 1024));
    expect(mocks.tabsGet).not.toHaveBeenCalled();
    expect(mocks.runtimeSendMessage).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('rejects resource-intensive or oversized selectors before preparing a file', async () => {
    for (const selector of [':has(input[type="file"])', `#${'a'.repeat(4097)}`]) {
      const result = await fileUploadTool.execute({
        selector,
        base64Data: 'Zm9v',
        tabId: 7,
      });

      expect(result.isError).toBe(true);
    }

    expect(mocks.runtimeSendMessage).not.toHaveBeenCalled();
    expect(mocks.withSession).not.toHaveBeenCalled();
  });

  it('does not interpolate an attacker-controlled selector into page JavaScript', async () => {
    const selector = `input[data-name="x'\\n);globalThis.pwned=true;//"]`;

    const result = await fileUploadTool.execute({
      selector,
      base64Data: 'Zm9v',
      tabId: 7,
    });

    expect(result.isError).toBe(false);
    expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'DOM.querySelector', {
      nodeId: 1,
      selector,
    });
    const executablePayloads = mocks.sendCommand.mock.calls
      .filter(([, method]) => method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn')
      .map(([, , params]) => JSON.stringify(params));
    expect(executablePayloads.join('\n')).not.toContain(selector);
  });

  it('rejects remote files whose Content-Length exceeds the single-file limit', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-length': String(16 * 1024 * 1024 + 1) },
      }),
    );

    const result = await fileUploadTool.execute({
      selector: '#upload',
      fileUrl: 'https://files.example/oversized.bin',
      tabId: 7,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'exceeds the 16 MiB limit',
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://files.example/oversized.bin',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.runtimeSendMessage).not.toHaveBeenCalled();
  });

  it('stops streaming a remote file when its body crosses the single-file limit', async () => {
    const firstChunk = new Uint8Array(8 * 1024 * 1024);
    const secondChunk = new Uint8Array(8 * 1024 * 1024 + 1);
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(firstChunk);
            controller.enqueue(secondChunk);
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    const result = await fileUploadTool.execute({
      selector: '#upload',
      fileUrl: 'https://files.example/streamed.bin',
      tabId: 7,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'exceeds the 16 MiB limit',
    );
    expect(mocks.runtimeSendMessage).not.toHaveBeenCalled();
  });

  it('keeps the remote-file timeout active while consuming the response body', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementationOnce(async (_url, options: RequestInit) => {
      const signal = options.signal as AbortSignal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener(
              'abort',
              () => controller.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          },
        }),
        { status: 200 },
      );
    });

    const resultPromise = fileUploadTool.execute({
      selector: '#upload',
      fileUrl: 'https://files.example/slow.bin',
      tabId: 7,
    });
    await vi.advanceTimersByTimeAsync(30000);
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'timed out after 30000 ms',
    );
    expect(mocks.runtimeSendMessage).not.toHaveBeenCalled();
  });
});
