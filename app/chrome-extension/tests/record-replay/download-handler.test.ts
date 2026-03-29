import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDownloadHandler } from '@/entrypoints/background/record-replay/actions/handlers/tabs';

type DownloadListener<T> = (payload: T) => void;

function makeDownloadItem(
  overrides: Partial<chrome.downloads.DownloadItem> = {},
): chrome.downloads.DownloadItem {
  return {
    id: 7,
    filename: '/Users/alice/Downloads/secret-report.pdf',
    url: 'https://example.com/report.pdf',
    state: 'complete',
    totalBytes: 128,
    ...overrides,
  } as chrome.downloads.DownloadItem;
}

describe('handleDownloadHandler', () => {
  let createdListeners: Array<DownloadListener<chrome.downloads.DownloadItem>>;
  let changedListeners: Array<DownloadListener<chrome.downloads.DownloadDelta>>;

  beforeEach(() => {
    createdListeners = [];
    changedListeners = [];

    vi.stubGlobal('chrome', {
      downloads: {
        onCreated: {
          addListener: vi.fn((listener: DownloadListener<chrome.downloads.DownloadItem>) => {
            createdListeners.push(listener);
          }),
          removeListener: vi.fn((listener: DownloadListener<chrome.downloads.DownloadItem>) => {
            createdListeners = createdListeners.filter((candidate) => candidate !== listener);
          }),
        },
        onChanged: {
          addListener: vi.fn((listener: DownloadListener<chrome.downloads.DownloadDelta>) => {
            changedListeners.push(listener);
          }),
          removeListener: vi.fn((listener: DownloadListener<chrome.downloads.DownloadDelta>) => {
            changedListeners = changedListeners.filter((candidate) => candidate !== listener);
          }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('redacts local download paths when the run requires public-safe outputs', async () => {
    const ctx = {
      vars: {},
      tabId: 11,
      execution: { redactDownloadPaths: true },
      log: vi.fn(),
    } as any;

    const runPromise = handleDownloadHandler.run(
      ctx,
      {
        id: 'download-1',
        type: 'handleDownload',
        params: {
          waitForComplete: false,
          saveAs: 'download_info',
        },
      } as any,
    );

    expect(createdListeners).toHaveLength(1);
    createdListeners[0]?.(makeDownloadItem());

    const result = await runPromise;
    expect(result).toEqual({
      status: 'success',
      output: {
        download: {
          id: '7',
          filename: 'secret-report.pdf',
          url: 'https://example.com/report.pdf',
          state: 'complete',
          size: 128,
          pathRedacted: true,
        },
      },
    });
    expect(ctx.vars.download_info).toEqual({
      id: '7',
      filename: 'secret-report.pdf',
      url: 'https://example.com/report.pdf',
      state: 'complete',
      size: 128,
      pathRedacted: true,
    });
  });

  it('preserves download paths for non-public runs', async () => {
    const ctx = {
      vars: {},
      tabId: 11,
      execution: {},
      log: vi.fn(),
    } as any;

    const runPromise = handleDownloadHandler.run(
      ctx,
      {
        id: 'download-2',
        type: 'handleDownload',
        params: {
          waitForComplete: false,
          saveAs: 'download_info',
        },
      } as any,
    );

    createdListeners[0]?.(makeDownloadItem());

    const result = await runPromise;
    expect(result).toEqual({
      status: 'success',
      output: {
        download: {
          id: '7',
          filename: '/Users/alice/Downloads/secret-report.pdf',
          url: 'https://example.com/report.pdf',
          state: 'complete',
          size: 128,
        },
      },
    });
    expect(ctx.vars.download_info).toEqual({
      id: '7',
      filename: '/Users/alice/Downloads/secret-report.pdf',
      url: 'https://example.com/report.pdf',
      state: 'complete',
      size: 128,
    });
  });
});
