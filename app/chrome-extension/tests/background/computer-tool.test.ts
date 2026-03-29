import { afterEach, describe, expect, it, vi } from 'vitest';

import { computerTool } from '@/entrypoints/background/tools/browser/computer';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

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

describe('computerTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects file URL tabs before zoom screenshots', async () => {
    const tryGetTab = vi
      .spyOn(computerTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const getActiveTabOrThrowInWindow = vi
      .spyOn(computerTool as any, 'getActiveTabOrThrowInWindow')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const attach = vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
    const sendCommand = vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

    const result = await computerTool.execute({
      tabId: 7,
      action: 'zoom',
      region: { x0: 0, y0: 0, x1: 100, y1: 100 },
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_computer zoom',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(getActiveTabOrThrowInWindow).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('rejects file URL tabs before hover can fall back to DOM access', async () => {
    const tryGetTab = vi
      .spyOn(computerTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const sendMessageToTab = vi
      .spyOn(computerTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true });
    const attach = vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);

    const result = await computerTool.execute({
      tabId: 7,
      action: 'hover',
      coordinates: { x: 10, y: 10 },
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_computer',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(sendMessageToTab).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it('rejects file URL tabs before typing via CDP or keyboard fallback', async () => {
    const tryGetTab = vi
      .spyOn(computerTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const attach = vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);

    const result = await computerTool.execute({
      tabId: 7,
      action: 'type',
      text: 'secret',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_computer',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(attach).not.toHaveBeenCalled();
  });
});
