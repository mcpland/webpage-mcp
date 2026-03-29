import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listMarkersForUrl: vi.fn(),
}));

vi.mock('@/entrypoints/background/element-marker/element-marker-storage', () => ({
  listMarkersForUrl: mocks.listMarkersForUrl,
}));

import { readPageTool } from '@/entrypoints/background/tools/browser/read-page';

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

describe('readPageTool', () => {
  beforeEach(() => {
    mocks.listMarkersForUrl.mockReset();
    mocks.listMarkersForUrl.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects file URL tabs before injecting content scripts', async () => {
    const tryGetTab = vi
      .spyOn(readPageTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const getActiveTabOrThrowInWindow = vi
      .spyOn(readPageTool as any, 'getActiveTabOrThrowInWindow')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const injectContentScript = vi
      .spyOn(readPageTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(readPageTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true, pageContent: 'secret' });

    const result = await readPageTool.execute({ tabId: 7 });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_read_page',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(getActiveTabOrThrowInWindow).not.toHaveBeenCalled();
    expect(injectContentScript).not.toHaveBeenCalled();
    expect(sendMessageToTab).not.toHaveBeenCalled();
  });
});
