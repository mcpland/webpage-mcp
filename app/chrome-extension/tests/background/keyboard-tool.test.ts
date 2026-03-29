import { afterEach, describe, expect, it, vi } from 'vitest';

import { keyboardTool } from '@/entrypoints/background/tools/browser/keyboard';

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

describe('keyboardTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects file URL tabs before simulating keyboard input', async () => {
    const tryGetTab = vi
      .spyOn(keyboardTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab());
    const injectContentScript = vi
      .spyOn(keyboardTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    const result = await keyboardTool.execute({
      tabId: 7,
      keys: 'Enter',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_keyboard',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(injectContentScript).not.toHaveBeenCalled();
  });
});
