import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clickTool,
  fillTool,
} from '@/entrypoints/background/tools/browser/interaction';

function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 7,
    index: 0,
    windowId: 2,
    title: 'Secret',
    url: 'file:///tmp/secret.txt',
    status: 'complete',
    active: true,
    ...overrides,
  } as chrome.tabs.Tab;
}

describe('interaction tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects file URL tabs before clicking', async () => {
    const tryGetTab = vi
      .spyOn(clickTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab());
    const injectContentScript = vi
      .spyOn(clickTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    const result = await clickTool.execute({
      tabId: 7,
      ref: 'ref_click',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_click_element',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(injectContentScript).not.toHaveBeenCalled();
  });

  it('rejects file URL tabs before filling', async () => {
    const tryGetTab = vi
      .spyOn(fillTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab());
    const injectContentScript = vi
      .spyOn(fillTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    const result = await fillTool.execute({
      tabId: 7,
      ref: 'ref_fill',
      value: 'secret',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_fill_or_select',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(injectContentScript).not.toHaveBeenCalled();
  });
});
