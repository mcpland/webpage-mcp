import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDownloadTool } from '@/entrypoints/background/tools/browser/download';

describe('handleDownloadTool', () => {
  let createdListener: ((item: chrome.downloads.DownloadItem) => void) | null = null;
  let changedListener: ((delta: chrome.downloads.DownloadDelta) => void) | null = null;

  beforeEach(() => {
    vi.stubGlobal('chrome', {
      downloads: {
        onCreated: {
          addListener: vi.fn((listener: (item: chrome.downloads.DownloadItem) => void) => {
            createdListener = listener;
          }),
          removeListener: vi.fn(),
        },
        onChanged: {
          addListener: vi.fn((listener: (delta: chrome.downloads.DownloadDelta) => void) => {
            changedListener = listener;
          }),
          removeListener: vi.fn(),
        },
        search: vi.fn(),
      },
    });
  });

  afterEach(() => {
    createdListener = null;
    changedListener = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('redacts local download paths to a basename before returning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:00.000Z'));

    const hit = {
      id: 1,
      filename: '/Users/alice/Downloads/secret-report.pdf',
      url: 'https://example.com/secret-report.pdf',
      state: 'complete',
      fileSize: 128,
      startTime: '2026-03-30T00:00:00.000Z',
    };
    const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
    search.mockResolvedValue([hit]);

    const result = await handleDownloadTool.execute({
      waitForComplete: false,
    });
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(payload).toMatchObject({
      success: true,
      download: {
        id: 1,
        filename: 'secret-report.pdf',
        url: 'https://example.com/secret-report.pdf',
        state: 'complete',
        pathRedacted: true,
      },
    });
  });

  it('redacts non-public download source urls before returning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:00.000Z'));

    const hit = {
      id: 9,
      filename: '/Users/alice/Downloads/secret-export.bin',
      url: 'file:///Users/alice/secrets/export.bin',
      state: 'complete',
      fileSize: 32,
      startTime: '2026-03-30T00:00:00.000Z',
    };
    const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
    search.mockResolvedValue([hit]);

    const result = await handleDownloadTool.execute({
      waitForComplete: false,
    });
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(payload).toMatchObject({
      success: true,
      download: {
        id: 9,
        filename: 'secret-export.bin',
        url: null,
        state: 'complete',
        pathRedacted: true,
        urlRedacted: true,
      },
    });
  });

  it('ignores stale existing downloads and resolves when a new matching download is created', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:00.000Z'));

    const staleHit = {
      id: 1,
      filename: '/Users/alice/Downloads/report.pdf',
      url: 'https://example.com/report.pdf',
      state: 'complete',
      fileSize: 128,
      startTime: '2026-03-29T23:58:00.000Z',
      endTime: '2026-03-29T23:58:05.000Z',
    };
    const freshHit = {
      id: 2,
      filename: '/Users/alice/Downloads/report.pdf',
      url: 'https://example.com/report.pdf',
      state: 'complete',
      fileSize: 256,
      startTime: '2026-03-30T00:00:01.000Z',
      endTime: '2026-03-30T00:00:02.000Z',
    };
    const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
    search.mockImplementation(async (query?: { id?: number }) => {
      if (query?.id === freshHit.id) {
        return [freshHit];
      }
      return [staleHit];
    });

    const pending = handleDownloadTool.execute({
      waitForComplete: false,
      filenameContains: 'report.pdf',
      timeoutMs: 5000,
    });

    await vi.runAllTicks();
    expect(createdListener).toBeTypeOf('function');

    createdListener?.({
      ...freshHit,
      state: 'in_progress',
      endTime: undefined,
    } as chrome.downloads.DownloadItem);

    const result = await pending;
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(payload).toMatchObject({
      success: true,
      download: {
        id: 2,
        filename: 'report.pdf',
        url: 'https://example.com/report.pdf',
        state: 'complete',
        pathRedacted: true,
      },
    });
  });

  it('returns a matching download that already completed moments before the call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:10.000Z'));

    const recentComplete = {
      id: 3,
      filename: '/Users/alice/Downloads/export.csv',
      url: 'https://example.com/export.csv',
      state: 'complete',
      fileSize: 64,
      startTime: '2026-03-30T00:00:08.000Z',
      endTime: '2026-03-30T00:00:09.500Z',
    };
    const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
    search.mockResolvedValue([recentComplete]);

    const pending = handleDownloadTool.execute({
      waitForComplete: true,
      filenameContains: 'export.csv',
      timeoutMs: 1000,
    });

    await vi.runAllTimersAsync();
    const result = await pending;
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(payload).toMatchObject({
      success: true,
      download: {
        id: 3,
        filename: 'export.csv',
        url: 'https://example.com/export.csv',
        state: 'complete',
        pathRedacted: true,
      },
    });
    expect(changedListener).toBeTypeOf('function');
  });
});
