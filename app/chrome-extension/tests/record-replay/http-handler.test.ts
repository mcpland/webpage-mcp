import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HTTP_ACTION_LIMITS,
  httpHandler,
} from '@/entrypoints/background/record-replay/actions/handlers/http';
import { createMockActionCtx } from './_test-helpers';

describe('httpHandler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    'file:///Users/alice/secrets.json',
    'chrome-extension://extension-id/private.json',
    'data:application/json,%7B%22secret%22%3Atrue%7D',
  ])('rejects non-HTTP target %s before fetching', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await httpHandler.run(
      createMockActionCtx(),
      {
        id: 'http-private-target',
        type: 'http',
        params: { url },
      },
    );

    expect(result).toEqual({
      status: 'failed',
      error: {
        code: 'VALIDATION_ERROR',
        message: 'HTTP actions only support http:// and https:// URLs',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized request bodies before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await httpHandler.run(createMockActionCtx(), {
      id: 'http-large-request',
      type: 'http',
      params: {
        url: 'https://example.com/upload',
        method: 'POST',
        body: {
          kind: 'text',
          text: 'x'.repeat(HTTP_ACTION_LIMITS.maxRequestBodyUtf8Bytes + 1),
        },
      },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('request body exceeds'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects excessive request header counts before resolving or fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const headers = Object.fromEntries(
      Array.from({ length: HTTP_ACTION_LIMITS.maxHeaderCount + 1 }, (_, index) => [
        `x-test-${index}`,
        'value',
      ]),
    );

    const result = await httpHandler.run(createMockActionCtx(), {
      id: 'http-many-headers',
      type: 'http',
      params: { url: 'https://example.com/', headers },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('headers exceeds') },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects response bodies whose declared size exceeds the budget', async () => {
    const response = new Response('small placeholder', {
      headers: {
        'content-length': String(HTTP_ACTION_LIMITS.maxResponseBodyBytes + 1),
        'content-type': 'text/plain',
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => response));

    const result = await httpHandler.run(createMockActionCtx(), {
      id: 'http-large-response',
      type: 'http',
      params: { url: 'https://example.com/download' },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'NETWORK_REQUEST_FAILED',
        message: expect.stringContaining('response body exceeds'),
      },
    });
  });

  it('stops streaming a response when decoded bytes cross the body budget', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(HTTP_ACTION_LIMITS.maxResponseBodyBytes));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/plain' } })),
    );

    const result = await httpHandler.run(createMockActionCtx(), {
      id: 'http-stream-overflow',
      type: 'http',
      params: { url: 'https://example.com/stream' },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'NETWORK_REQUEST_FAILED',
        message: expect.stringContaining('response body exceeds'),
      },
    });
  });

  it('keeps the abort deadline active while consuming the response body', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        observedSignal = options.signal as AbortSignal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            observedSignal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/plain' } });
      }),
    );

    const pending = httpHandler.run(createMockActionCtx(), {
      id: 'http-slow-response',
      type: 'http',
      params: { url: 'https://example.com/slow' },
      policy: { timeout: { ms: 25 } },
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TIMEOUT' },
    });
    expect(observedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('parses and returns a bounded JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, count: 2 }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await httpHandler.run(createMockActionCtx(), {
      id: 'http-json-response',
      type: 'http',
      params: { url: 'https://example.com/data', saveAs: 'api_response' },
    });

    expect(result).toMatchObject({
      status: 'success',
      output: {
        response: {
          status: 200,
          body: { ok: true, count: 2 },
        },
      },
    });
  });

  it('rejects a response whose escaped JSON output exceeds the event-safe budget', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ value: '\0'.repeat(10_000) }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await httpHandler.run(createMockActionCtx(), {
      id: 'http-json-output-overflow',
      type: 'http',
      params: { url: 'https://example.com/data' },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'NETWORK_REQUEST_FAILED',
        message: expect.stringContaining('HTTP response exceeds'),
      },
    });
  });
});
