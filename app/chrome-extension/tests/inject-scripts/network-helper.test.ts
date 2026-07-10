import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageListener = (
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

describe('network-helper', () => {
  let messageListener: RuntimeMessageListener | null = null;
  const fetchMock = vi.fn();
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

  async function loadHelper(pageUrl = 'https://example.com/page'): Promise<void> {
    messageListener = null;
    const location = new URL(pageUrl);

    vi.stubGlobal('window', { location });
    vi.stubGlobal('location', location);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: RuntimeMessageListener) => {
            messageListener = listener;
          }),
        },
      },
    });

    await import('@/inject-scripts/network-helper.js');
  }

  async function dispatchMessage(request: any): Promise<any> {
    if (!messageListener) {
      throw new Error('network-helper did not register a runtime message listener');
    }

    return await new Promise((resolve) => {
      const handled = messageListener!(request, {} as chrome.runtime.MessageSender, resolve);
      expect(handled).toBe(true);
    });
  }

  beforeEach(async () => {
    fetchMock.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    await loadHelper();
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy?.mockRestore();
    warnSpy = null;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([
    {
      name: 'object formData descriptors',
      formData: {
        fields: { kind: 'avatar' },
        files: [{ name: 'upload', filePath: '/tmp/secret.txt' }],
      },
    },
    {
      name: 'compact array formData descriptors',
      formData: [['upload', 'file:/tmp/secret.txt']],
    },
  ])('returns an error without sending the request for unsupported local paths in $name', async ({ formData }) => {
    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/upload',
      method: 'POST',
      formData,
      timeout: 1000,
    });

    expect(response).toEqual(
      expect.objectContaining({
        success: false,
      }),
    );
    expect(String(response.error || '')).toContain('Local file paths are not supported');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects requests from non-public page contexts before fetching relative URLs', async () => {
    vi.resetModules();
    await loadHelper('file:///tmp/secret.html');

    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: './relative-endpoint',
      method: 'GET',
      timeout: 1000,
    });

    expect(response).toEqual(
      expect.objectContaining({
        success: false,
      }),
    );
    expect(String(response.error || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_network_request',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads and parses successful JSON responses within the response limit', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/api',
      method: 'GET',
      timeout: 1000,
    });

    expect(response).toEqual(
      expect.objectContaining({
        success: true,
        response: expect.objectContaining({
          status: 200,
          body: { ok: true },
        }),
      }),
    );
  });

  it('returns non-success HTTP status with its bounded response body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('missing', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/missing',
      method: 'GET',
      timeout: 1000,
    });

    expect(response).toEqual(
      expect.objectContaining({
        success: false,
        error: 'Network request returned HTTP 404.',
        response: expect.objectContaining({ status: 404, body: 'missing' }),
      }),
    );
  });

  it('rejects a response whose Content-Length exceeds the response limit', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('small mock body', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': String(8 * 1024 * 1024 + 1),
        },
      }),
    );

    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/oversized',
      method: 'GET',
      timeout: 1000,
    });

    expect(response.success).toBe(false);
    expect(String(response.error || '')).toContain('Network response exceeds the 8 MiB limit');
  });

  it('stops streaming a response when its body crosses the response limit', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024));
            controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/plain' } },
      ),
    );

    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/streamed',
      method: 'GET',
      timeout: 1000,
    });

    expect(response.success).toBe(false);
    expect(String(response.error || '')).toContain('Network response exceeds the 8 MiB limit');
  });

  it('keeps the main request timeout active while consuming the response body', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async (_url, options: RequestInit) => {
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
        { status: 200, headers: { 'content-type': 'text/plain' } },
      );
    });

    const responsePromise = dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/slow',
      method: 'GET',
      timeout: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const response = await responsePromise;

    expect(response.success).toBe(false);
    expect(String(response.error || '')).toContain('Network response timed out after 1000 ms');
  });

  it('rejects non-success remote FormData attachment downloads before the main request', async () => {
    fetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/upload',
      method: 'POST',
      timeout: 1000,
      formData: {
        files: [{ name: 'upload', fileUrl: 'https://files.example/missing.bin' }],
      },
    });

    expect(response.success).toBe(false);
    expect(String(response.error || '')).toContain('FormData attachment returned HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects remote FormData attachments whose Content-Length exceeds the file limit', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('small mock body', {
        status: 200,
        headers: { 'content-length': String(16 * 1024 * 1024 + 1) },
      }),
    );

    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/upload',
      method: 'POST',
      timeout: 1000,
      formData: [['upload', 'url:https://files.example/oversized.bin']],
    });

    expect(response.success).toBe(false);
    expect(String(response.error || '')).toContain(
      'FormData attachment exceeds the 16 MiB limit',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized base64 FormData attachments before decoding or fetching', async () => {
    const maximumBytes = 16 * 1024 * 1024;
    const oversizedBase64 = 'A'.repeat(Math.ceil(((maximumBytes + 1) * 4) / 3));

    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/upload',
      method: 'POST',
      timeout: 1000,
      formData: [['upload', `base64:${oversizedBase64}`]],
    });

    expect(response.success).toBe(false);
    expect(String(response.error || '')).toContain(
      'FormData attachment exceeds the 16 MiB limit',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops streaming remote FormData attachments at the file limit', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024));
            controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/upload',
      method: 'POST',
      timeout: 1000,
      formData: {
        files: [{ name: 'upload', fileUrl: 'https://files.example/streamed.bin' }],
      },
    });

    expect(response.success).toBe(false);
    expect(String(response.error || '')).toContain(
      'FormData attachment exceeds the 16 MiB limit',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps attachment timeouts active while consuming remote FormData bodies', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async (_url, options: RequestInit) => {
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

    const responsePromise = dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/upload',
      method: 'POST',
      timeout: 1000,
      formData: [['upload', 'url:https://files.example/slow.bin']],
    });
    await vi.advanceTimersByTimeAsync(1000);
    const response = await responsePromise;

    expect(response.success).toBe(false);
    expect(String(response.error || '')).toContain(
      'FormData attachment timed out after 1000 ms',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
