import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WINDOW_DISCOVERY_MAX_OUTPUT_UTF8_BYTES,
  WINDOW_DISCOVERY_MAX_TABS,
  WINDOW_DISCOVERY_MAX_WINDOWS,
  windowTool,
} from '@/entrypoints/background/tools/browser/window';
import { measureUtf8Bytes } from '@/entrypoints/background/tools/browser/bounded-tool-output';

describe('windowTool', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      windows: {
        getAll: vi.fn(),
      },
      tabs: {
        query: vi.fn(),
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
      },
    ]);
    const tabsQuery = chrome.tabs.query as ReturnType<typeof vi.fn>;
    tabsQuery.mockResolvedValue([
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
    expect(getAll).toHaveBeenCalledWith({ populate: false });
    expect(tabsQuery).toHaveBeenCalledWith({ windowId: 1 });
  });

  it('bounds per-window discovery, tab count, fields, and output bytes', async () => {
    const getAll = chrome.windows.getAll as ReturnType<typeof vi.fn>;
    getAll.mockResolvedValue(
      Array.from({ length: WINDOW_DISCOVERY_MAX_WINDOWS + 10 }, (_, index) => ({
        id: index + 1,
      })),
    );
    const huge = 'x'.repeat(20_000);
    const tabsQuery = chrome.tabs.query as ReturnType<typeof vi.fn>;
    tabsQuery.mockResolvedValue(
      Array.from({ length: WINDOW_DISCOVERY_MAX_TABS + 100 }, (_, index) => ({
        id: index + 1,
        url: `https://example.com/${index}/${huge}`,
        title: huge,
        active: index === 0,
      })),
    );

    const result = await windowTool.execute();
    const text = String((result.content[0] as { text?: string })?.text || '');
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(payload.windowCount).toBeLessThanOrEqual(WINDOW_DISCOVERY_MAX_WINDOWS);
    expect(payload.tabCount).toBeLessThanOrEqual(WINDOW_DISCOVERY_MAX_TABS);
    expect(payload.truncated).toBe(true);
    expect(payload.totalWindowCount).toBe(WINDOW_DISCOVERY_MAX_WINDOWS + 10);
    expect(measureUtf8Bytes(text)).toBeLessThanOrEqual(
      WINDOW_DISCOVERY_MAX_OUTPUT_UTF8_BYTES,
    );
    expect(tabsQuery).toHaveBeenCalledTimes(1);
  });
});
