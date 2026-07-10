import { afterEach, describe, expect, it, vi } from 'vitest';

import { httpHandler } from '@/entrypoints/background/record-replay/actions/handlers/http';
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
});
