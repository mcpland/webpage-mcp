import { afterEach, describe, expect, it, vi } from 'vitest';

import { javascriptTool } from '@/entrypoints/background/tools/browser/javascript';

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

describe('javascriptTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects file URL tabs before executing JavaScript', async () => {
    const tryGetTab = vi
      .spyOn(javascriptTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const getActiveTabOrThrow = vi
      .spyOn(javascriptTool as any, 'getActiveTabOrThrow')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));

    const result = await javascriptTool.execute({
      tabId: 7,
      code: 'return document.body?.innerText;',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_javascript',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(getActiveTabOrThrow).not.toHaveBeenCalled();
  });
});
