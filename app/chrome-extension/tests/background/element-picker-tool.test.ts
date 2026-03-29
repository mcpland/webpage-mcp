import { afterEach, describe, expect, it, vi } from 'vitest';

import { elementPickerTool } from '@/entrypoints/background/tools/browser/element-picker';

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

describe('elementPickerTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects file URL tabs before starting element selection', async () => {
    const tryGetTab = vi
      .spyOn(elementPickerTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab());
    const ensureFocus = vi
      .spyOn(elementPickerTool as any, 'ensureFocus')
      .mockResolvedValue(undefined);

    const result = await elementPickerTool.execute({
      tabId: 7,
      requests: [{ name: 'Primary button' }],
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_request_element_selection',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(ensureFocus).not.toHaveBeenCalled();
  });
});
