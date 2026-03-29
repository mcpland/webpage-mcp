import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { windowTool } from '@/entrypoints/background/tools/browser/window';

describe('windowTool', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      windows: {
        getAll: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('redacts non-public tab URLs and titles from discovery results', async () => {
    const getAll = chrome.windows.getAll as ReturnType<typeof vi.fn>;
    getAll.mockResolvedValue([
      {
        id: 1,
        tabs: [
          {
            id: 11,
            url: 'https://example.com/',
            title: 'Example',
            active: true,
          },
          {
            id: 12,
            url: 'file:///tmp/secret.txt',
            title: 'secret.txt',
            active: false,
          },
        ],
      },
    ]);

    const result = await windowTool.execute();
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(payload).toEqual({
      windowCount: 1,
      tabCount: 2,
      windows: [
        {
          windowId: 1,
          tabs: [
            {
              tabId: 11,
              url: 'https://example.com/',
              title: 'Example',
              active: true,
              restricted: false,
            },
            {
              tabId: 12,
              url: null,
              title: null,
              active: false,
              restricted: true,
            },
          ],
        },
      ],
    });
  });
});
