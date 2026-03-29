import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gifRecorderTool } from '@/entrypoints/background/tools/browser/gif-recorder';
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

describe('gifRecorderTool', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(),
      },
      downloads: {
        download: vi.fn(),
        search: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects file URL tabs before starting GIF recording', async () => {
    const resolveTargetTab = vi
      .spyOn(gifRecorderTool as any, 'resolveTargetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const attach = vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
    const sendCommand = vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

    const result = await gifRecorderTool.execute({
      action: 'start',
      tabId: 7,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_gif_recorder recording actions.',
    );
    expect(resolveTargetTab).toHaveBeenCalledWith(7);
    expect(attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
