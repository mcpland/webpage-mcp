import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleDownloadTool,
  resetReportedDownloadsForTests,
  waitForDownload,
} from '@/entrypoints/background/tools/browser/download';

describe('handleDownloadTool', () => {
  let createdListener: ((item: chrome.downloads.DownloadItem) => void) | null = null;
  let changedListener: ((delta: chrome.downloads.DownloadDelta) => void) | null = null;

  beforeEach(() => {
    resetReportedDownloadsForTests();
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

  it('ignores stale in-progress downloads and resolves when a new matching download is created', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:00.000Z'));

    const staleHit = {
      id: 1,
      filename: '/Users/alice/Downloads/report.pdf',
      url: 'https://example.com/report.pdf',
      state: 'in_progress',
      fileSize: 128,
      startTime: '2026-03-29T23:58:00.000Z',
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
  const payloadOf = (result: { content: Array<{ type: string; text?: string }> }) =>
    JSON.parse(String(result.content[0]?.text || '{}'));

  it('returns a download that finished several seconds before the call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:30.000Z'));
    // Clicked, then the agent spent a turn thinking before asking for it.
    const finished = {
      id: 11,
      filename: '/Users/alice/Downloads/report.txt',
      url: 'https://example.com/report.txt',
      state: 'complete',
      startTime: '2026-03-30T00:00:21.000Z',
      endTime: '2026-03-30T00:00:22.000Z',
    };
    (chrome.downloads.search as ReturnType<typeof vi.fn>).mockResolvedValue([finished]);

    const pending = handleDownloadTool.execute({ timeoutMs: 1000 });
    await vi.runAllTimersAsync();
    const payload = payloadOf(await pending);

    expect(payload).toMatchObject({ success: true, download: { id: 11, state: 'complete' } });
    expect(chrome.downloads.search).toHaveBeenCalledWith(
      expect.objectContaining({ startedAfter: '2026-03-29T23:59:30.000Z' }),
    );
  });

  it('reports each download only once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:30.000Z'));
    const finished = {
      id: 12,
      filename: '/Users/alice/Downloads/a.txt',
      state: 'complete',
      startTime: '2026-03-30T00:00:25.000Z',
    };
    (chrome.downloads.search as ReturnType<typeof vi.fn>).mockResolvedValue([finished]);

    const first = handleDownloadTool.execute({ timeoutMs: 1000 });
    await vi.runAllTimersAsync();
    expect(payloadOf(await first).download.id).toBe(12);

    const second = handleDownloadTool.execute({ timeoutMs: 1000 });
    await vi.runAllTimersAsync();
    const result = await second;
    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text)).toContain('Download wait timed out');
  });

  it('waits for the newest matching download instead of an older finished one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:30.000Z'));
    const older = { id: 13, filename: 'x/old.txt', state: 'complete', startTime: '2026-03-30T00:00:01.000Z' };
    const newer = { id: 14, filename: 'x/new.txt', state: 'in_progress', startTime: '2026-03-30T00:00:28.000Z' };
    const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
    search.mockImplementation(async (query?: { id?: number }) =>
      query?.id === 14 ? [{ ...newer, state: 'complete' }] : [older, newer],
    );

    const pending = handleDownloadTool.execute({ timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(10);
    changedListener?.({ id: 14 } as chrome.downloads.DownloadDelta);
    await vi.advanceTimersByTimeAsync(10);
    const payload = payloadOf(await pending);

    expect(payload.download).toMatchObject({ id: 14, state: 'complete' });
  });

  it('reports an interrupted download instead of waiting for the timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:30.000Z'));
    const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
    search.mockImplementation(async (query?: { id?: number }) =>
      query?.id === 15 ? [{ id: 15, filename: 'x/broken.zip', state: 'interrupted' }] : [],
    );

    const pending = handleDownloadTool.execute({ timeoutMs: 60000 });
    await vi.advanceTimersByTimeAsync(10);
    createdListener?.({ id: 15, filename: 'x/broken.zip', state: 'in_progress' } as any);
    changedListener?.({ id: 15 } as chrome.downloads.DownloadDelta);
    await vi.advanceTimersByTimeAsync(10);
    const payload = payloadOf(await pending);

    expect(payload.download).toMatchObject({ id: 15, state: 'interrupted' });
  });

  it('only reports downloads created after arming when onlyNew is set', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:30.000Z'));
    const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
    search.mockImplementation(async (query?: { id?: number }) =>
      query?.id === 17
        ? [{ id: 17, filename: 'x/fresh.txt', state: 'complete' }]
        : [{ id: 16, filename: 'x/existing.txt', state: 'complete', startTime: '2026-03-30T00:00:29.000Z' }],
    );

    const pending = waitForDownload({ waitForComplete: true, timeoutMs: 5000, onlyNew: true });
    await vi.advanceTimersByTimeAsync(10);
    createdListener?.({ id: 17, filename: 'x/fresh.txt', state: 'complete' } as any);
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({ id: 17 });
    expect(search).not.toHaveBeenCalledWith(expect.objectContaining({ startedAfter: expect.any(String) }));
  });

  it('stops waiting when its signal aborts', async () => {
    const controller = new AbortController();
    (chrome.downloads.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const pending = waitForDownload({
      waitForComplete: true,
      timeoutMs: 60000,
      onlyNew: true,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow('Download wait cancelled');
    expect(chrome.downloads.onCreated.removeListener).toHaveBeenCalled();
  });
});
