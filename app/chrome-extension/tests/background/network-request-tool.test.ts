import { afterEach, describe, expect, it, vi } from 'vitest';

import { networkRequestTool } from '@/entrypoints/background/tools/browser/network-request';

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

describe('networkRequestTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects non-public request URLs before touching the browser', async () => {
    const tryGetTab = vi.spyOn(networkRequestTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    const injectContentScript = vi
      .spyOn(networkRequestTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(networkRequestTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true });

    const result = await networkRequestTool.execute({
      tabId: 7,
      url: 'file:///tmp/secret.txt',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// URLs are allowed for chrome_network_request',
    );
    expect(tryGetTab).not.toHaveBeenCalled();
    expect(injectContentScript).not.toHaveBeenCalled();
    expect(sendMessageToTab).not.toHaveBeenCalled();
  });

  it('rejects non-public target tabs before injecting the helper', async () => {
    const tryGetTab = vi
      .spyOn(networkRequestTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt', title: 'Secret' }));
    const injectContentScript = vi
      .spyOn(networkRequestTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(networkRequestTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true });

    const result = await networkRequestTool.execute({
      tabId: 7,
      url: './relative-endpoint',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_network_request',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(injectContentScript).not.toHaveBeenCalled();
    expect(sendMessageToTab).not.toHaveBeenCalled();
  });

  it('rejects non-public object-form fileUrl attachments before touching the browser', async () => {
    const injectContentScript = vi
      .spyOn(networkRequestTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(networkRequestTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true });

    const result = await networkRequestTool.execute({
      tabId: 7,
      url: 'https://example.com/upload',
      method: 'POST',
      formData: {
        files: [{ name: 'file', fileUrl: 'file:///tmp/secret.txt' }],
      },
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// URLs are allowed for chrome_network_request formData attachments',
    );
    expect(injectContentScript).not.toHaveBeenCalled();
    expect(sendMessageToTab).not.toHaveBeenCalled();
  });

  it('rejects non-public compact url: attachment specs before touching the browser', async () => {
    const injectContentScript = vi
      .spyOn(networkRequestTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(networkRequestTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true });

    const result = await networkRequestTool.execute({
      tabId: 7,
      url: 'https://example.com/upload',
      method: 'POST',
      formData: [['file', 'url:file:///tmp/secret.txt', 'secret.txt']],
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// URLs are allowed for chrome_network_request formData attachments',
    );
    expect(injectContentScript).not.toHaveBeenCalled();
    expect(sendMessageToTab).not.toHaveBeenCalled();
  });
});
