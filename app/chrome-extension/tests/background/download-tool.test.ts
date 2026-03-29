import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDownloadTool } from '@/entrypoints/background/tools/browser/download';

describe('handleDownloadTool', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      downloads: {
        onCreated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
        search: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('redacts local download paths to a basename before returning', async () => {
    const hit = {
      id: 1,
      filename: '/Users/alice/Downloads/secret-report.pdf',
      url: 'https://example.com/secret-report.pdf',
      state: 'complete',
      fileSize: 128,
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
});
