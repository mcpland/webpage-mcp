import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/offscreen-manager', () => ({
  offscreenManager: {
    ensureOffscreenDocument: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/utils/image-utils', () => ({
  createImageBitmapFromUrl: vi.fn(async () => ({
    close: vi.fn(),
  })),
}));

import { gifRecorderTool } from '@/entrypoints/background/tools/browser/gif-recorder';
import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
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
    vi.stubGlobal(
      'OffscreenCanvas',
      class MockOffscreenCanvas {
        width: number;
        height: number;

        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }

        getContext() {
          return {
            clearRect: vi.fn(),
            drawImage: vi.fn(),
            getImageData: vi.fn(() => ({
              data: new Uint8ClampedArray([0, 0, 0, 255]),
            })),
          };
        }
      },
    );

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(),
      },
      downloads: {
        download: vi.fn(),
        search: vi.fn(),
      },
      scripting: {
        executeScript: vi.fn(),
      },
    });

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message) => {
        switch (message?.type) {
          case OFFSCREEN_MESSAGE_TYPES.GIF_RESET:
          case OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME:
            return { success: true };
          case OFFSCREEN_MESSAGE_TYPES.GIF_FINISH:
            return { success: true, gifData: [1, 2, 3], byteLength: 3 };
          default:
            return { success: true };
        }
      },
    );

    vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
    vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_tabId, method) => {
        if (method === 'Page.getLayoutMetrics') {
          return {
            layoutViewport: {
              clientWidth: 400,
              clientHeight: 300,
            },
          };
        }
        if (method === 'Page.captureScreenshot') {
          return {
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmS0AAAAASUVORK5CYII=',
          };
        }
        return {};
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects file URL tabs before starting GIF recording', async () => {
    const resolveTargetTab = vi
      .spyOn(gifRecorderTool as any, 'resolveTargetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const attach = vi
      .spyOn(cdpSessionManager, 'attach')
      .mockResolvedValue(undefined);
    const sendCommand = vi
      .spyOn(cdpSessionManager, 'sendCommand')
      .mockResolvedValue({});

    const result = await gifRecorderTool.execute({
      action: 'start',
      tabId: 7,
    });

    expect(result.isError).toBe(true);
    expect(
      String((result.content[0] as { text?: string })?.text || ''),
    ).toContain(
      'Only http:// and https:// pages are supported by chrome_gif_recorder recording actions.',
    );
    expect(resolveTargetTab).toHaveBeenCalledWith(7);
    expect(attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('redacts local download paths when stopping a fixed-fps recording', async () => {
    const resolveTargetTab = vi
      .spyOn(gifRecorderTool as any, 'resolveTargetTab')
      .mockResolvedValue(makeTab());
    const downloadsDownload = chrome.downloads.download as ReturnType<
      typeof vi.fn
    >;
    downloadsDownload.mockResolvedValue(88);

    const start = await gifRecorderTool.execute({
      action: 'start',
      tabId: 7,
      fps: 1,
      durationMs: 5_000,
      width: 10,
      height: 10,
      filename: 'secret-recording',
    });
    expect(start.isError).toBe(false);

    const stop = await gifRecorderTool.execute({ action: 'stop' });
    const payload = JSON.parse(
      String((stop.content[0] as { text?: string })?.text || '{}'),
    );

    expect(stop.isError).toBe(false);
    expect(resolveTargetTab).toHaveBeenCalledWith(7);
    expect(payload.downloadId).toBe(88);
    expect(payload.filename).toBe('secret-recording.gif');
    expect(payload.pathRedacted).toBe(true);
    expect('fullPath' in payload).toBe(false);
  });

  it('uses projected viewport coordinates when exporting to a drop target by ref', async () => {
    const resolveTargetTab = vi
      .spyOn(gifRecorderTool as any, 'resolveTargetTab')
      .mockResolvedValue(makeTab());
    const injectContentScript = vi
      .spyOn(gifRecorderTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(gifRecorderTool as any, 'sendMessageToTab')
      .mockResolvedValue({
        success: true,
        center: { x: 45, y: 55 },
        viewportCenter: { x: 345, y: 455 },
      });
    const executeScript = chrome.scripting.executeScript as ReturnType<
      typeof vi.fn
    >;
    executeScript.mockResolvedValueOnce([
      {
        result: {
          success: true,
          targetTagName: 'DIV',
          targetId: 'drop-zone',
        },
      },
    ]);

    const start = await gifRecorderTool.execute({
      action: 'start',
      tabId: 7,
      fps: 1,
      durationMs: 5_000,
      width: 10,
      height: 10,
      filename: 'drop-recording',
    });
    expect(start.isError).toBe(false);

    const stop = await gifRecorderTool.execute({ action: 'stop' });
    expect(stop.isError).toBe(false);

    const exportResult = await gifRecorderTool.execute({
      action: 'export',
      tabId: 7,
      download: false,
      ref: 'ref_drop_zone',
      filename: 'drop-recording',
    });
    const payload = JSON.parse(
      String((exportResult.content[0] as { text?: string })?.text || '{}'),
    );

    expect(exportResult.isError).toBe(false);
    expect(resolveTargetTab).toHaveBeenCalledWith(7);
    expect(injectContentScript).toHaveBeenCalledWith(7, [
      'inject-scripts/accessibility-tree-helper.js',
    ]);
    expect(sendMessageToTab).toHaveBeenCalledWith(7, {
      action: 'resolveRef',
      ref: 'ref_drop_zone',
    });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7 },
        args: [expect.any(String), 345, 455, 'drop-recording.gif'],
      }),
    );
    expect(payload.uploadTarget).toEqual({
      x: 345,
      y: 455,
      tagName: 'DIV',
      id: 'drop-zone',
    });
  });
});
