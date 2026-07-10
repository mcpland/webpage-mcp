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

import {
  cleanupGifRecorderForTab,
  gifRecorderTool,
} from '@/entrypoints/background/tools/browser/gif-recorder';
import {
  cleanupAutoCaptureForTab,
  isAutoCaptureActive,
  startAutoCapture,
} from '@/entrypoints/background/tools/browser/gif-auto-capture';
import { getGifCaptureOwner } from '@/entrypoints/background/tools/browser/gif-capture-owner';
import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import { GIF_TRANSPORT_LIMITS } from '@/common/gif-transport';
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

function responsePayload(result: {
  content: Array<{ text?: string }>;
}): Record<string, any> {
  return JSON.parse(String(result.content[0]?.text || '{}'));
}

function mockTabResolution(): void {
  vi.spyOn(gifRecorderTool as any, 'resolveTargetTab').mockImplementation(
    async (...args: unknown[]) => {
      const tabId = typeof args[0] === 'number' ? args[0] : 7;
      return makeTab({ id: tabId });
    },
  );
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

        async convertToBlob() {
          const bytes = new Uint8Array([137, 80, 78, 71]);
          const blob = new Blob([bytes], {
            type: 'image/png',
          });
          Object.defineProperty(blob, 'arrayBuffer', {
            value: async () => bytes.buffer.slice(0),
          });
          return blob;
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
            return {
              success: true,
              protocolVersion: 2,
              gifBase64: 'AQID',
              byteLength: 3,
            };
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

  afterEach(async () => {
    try {
      await gifRecorderTool.execute({ action: 'clear' });
    } catch {
      // Best-effort isolation if a test intentionally breaks startup.
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects a second auto capture on another tab while preserving the first owner', async () => {
    mockTabResolution();

    const first = await gifRecorderTool.execute({
      action: 'auto_start',
      tabId: 7,
    });
    const second = await gifRecorderTool.execute({
      action: 'auto_start',
      tabId: 8,
    });

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(true);
    expect(responsePayload(second as any).error).toContain(
      'auto-capture GIF capture is already active on tab 7',
    );
    expect(getGifCaptureOwner()).toEqual({ mode: 'auto_capture', tabId: 7 });
    expect(isAutoCaptureActive(7)).toBe(true);
    expect(isAutoCaptureActive(8)).toBe(false);
  });

  it('rejects auto capture on another tab while fixed-FPS capture owns the encoder', async () => {
    mockTabResolution();

    const fixed = await gifRecorderTool.execute({
      action: 'start',
      tabId: 7,
      fps: 1,
      durationMs: 5_000,
      width: 10,
      height: 10,
    });
    const auto = await gifRecorderTool.execute({
      action: 'auto_start',
      tabId: 8,
    });

    expect(fixed.isError).toBe(false);
    expect(auto.isError).toBe(true);
    expect(responsePayload(auto as any).error).toContain(
      'fixed-FPS GIF capture is already active on tab 7',
    );
    expect(getGifCaptureOwner()).toEqual({ mode: 'fixed_fps', tabId: 7 });
  });

  it('rejects fixed-FPS capture on another tab while auto capture owns the encoder', async () => {
    mockTabResolution();

    const auto = await gifRecorderTool.execute({
      action: 'auto_start',
      tabId: 7,
    });
    const fixed = await gifRecorderTool.execute({
      action: 'start',
      tabId: 8,
      width: 10,
      height: 10,
    });

    expect(auto.isError).toBe(false);
    expect(fixed.isError).toBe(true);
    expect(responsePayload(fixed as any).error).toContain(
      'auto-capture GIF capture is already active on tab 7',
    );
    expect(getGifCaptureOwner()).toEqual({ mode: 'auto_capture', tabId: 7 });
  });

  it('sends fixed-FPS frames as bounded protocol-v2 base64 instead of number arrays', async () => {
    mockTabResolution();

    const result = await gifRecorderTool.execute({
      action: 'start',
      tabId: 7,
      width: 10,
      height: 10,
    });

    expect(result.isError).toBe(false);
    const addFrameMessage = (
      chrome.runtime.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls
      .map(([message]) => message)
      .find(
        (message) => message?.type === OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME,
      );
    expect(addFrameMessage).toMatchObject({
      protocolVersion: 2,
      frameEncoding: 'png',
      frameBase64: expect.any(String),
      frameByteLength: 4,
      width: 10,
      height: 10,
    });
    expect(addFrameMessage).not.toHaveProperty('imageData');
  });

  it('sends auto-capture frames as bounded protocol-v2 base64 instead of number arrays', async () => {
    mockTabResolution();

    const result = await gifRecorderTool.execute({
      action: 'auto_start',
      tabId: 7,
      width: 10,
      height: 10,
    });

    expect(result.isError).toBe(false);
    const addFrameMessage = (
      chrome.runtime.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls
      .map(([message]) => message)
      .find(
        (message) => message?.type === OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME,
      );
    expect(addFrameMessage).toMatchObject({
      protocolVersion: 2,
      frameEncoding: 'png',
      frameBase64: expect.any(String),
      frameByteLength: 4,
      width: 10,
      height: 10,
    });
    expect(addFrameMessage).not.toHaveProperty('imageData');
  });

  it('rolls back the owner when startup fails so another mode can start', async () => {
    mockTabResolution();
    vi.mocked(cdpSessionManager.attach)
      .mockRejectedValueOnce(new Error('attach failed'))
      .mockResolvedValue(undefined);

    const failed = await gifRecorderTool.execute({
      action: 'auto_start',
      tabId: 7,
    });
    expect(failed.isError).toBe(true);
    expect(getGifCaptureOwner()).toBeNull();

    const next = await gifRecorderTool.execute({
      action: 'start',
      tabId: 8,
      width: 10,
      height: 10,
    });
    expect(next.isError).toBe(false);
    expect(getGifCaptureOwner()).toEqual({ mode: 'fixed_fps', tabId: 8 });
  });

  it('releases auto capture state, encoder, and CDP when its tab closes', async () => {
    mockTabResolution();
    const started = await gifRecorderTool.execute({
      action: 'auto_start',
      tabId: 7,
    });
    expect(started.isError).toBe(false);

    await cleanupAutoCaptureForTab(7);
    await cleanupGifRecorderForTab(7);

    expect(getGifCaptureOwner()).toBeNull();
    expect(isAutoCaptureActive(7)).toBe(false);
    expect(cdpSessionManager.detach).toHaveBeenCalledWith(
      7,
      'gif-auto-capture',
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: OFFSCREEN_MESSAGE_TYPES.GIF_RESET }),
    );

    const next = await gifRecorderTool.execute({
      action: 'start',
      tabId: 8,
      width: 10,
      height: 10,
    });
    expect(next.isError).toBe(false);
  });

  it('releases fixed-FPS state, encoder, and CDP when its tab closes', async () => {
    mockTabResolution();
    const started = await gifRecorderTool.execute({
      action: 'start',
      tabId: 7,
      width: 10,
      height: 10,
    });
    expect(started.isError).toBe(false);

    await cleanupGifRecorderForTab(7);

    expect(getGifCaptureOwner()).toBeNull();
    expect(cdpSessionManager.detach).toHaveBeenCalledWith(7, 'gif-recorder');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: OFFSCREEN_MESSAGE_TYPES.GIF_RESET }),
    );

    const next = await gifRecorderTool.execute({
      action: 'auto_start',
      tabId: 8,
      width: 10,
      height: 10,
    });
    expect(next.isError).toBe(false);
  });

  it('finalizes and releases auto capture when maxFrames is reached', async () => {
    mockTabResolution();

    const started = await gifRecorderTool.execute({
      action: 'auto_start',
      tabId: 7,
      maxFrames: 1,
      width: 10,
      height: 10,
    });

    expect(started.isError).toBe(false);
    expect(responsePayload(started as any).isRecording).toBe(false);
    expect(getGifCaptureOwner()).toBeNull();
    expect(isAutoCaptureActive(7)).toBe(false);

    const stop = await gifRecorderTool.execute({ action: 'stop' });
    expect(stop.isError).toBe(false);
    expect(responsePayload(stop as any)).toMatchObject({
      mode: 'auto_capture',
      frameCount: 1,
    });
  });

  it('finalizes and releases fixed-FPS capture when maxFrames is reached', async () => {
    vi.useFakeTimers();
    mockTabResolution();

    const started = await gifRecorderTool.execute({
      action: 'start',
      tabId: 7,
      fps: 30,
      durationMs: 5_000,
      maxFrames: 1,
      width: 10,
      height: 10,
    });
    expect(started.isError).toBe(false);

    await vi.advanceTimersByTimeAsync(40);

    expect(getGifCaptureOwner()).toBeNull();
    expect(cdpSessionManager.detach).toHaveBeenCalledWith(7, 'gif-recorder');
  });

  it('accepts a legacy gifData finish response in fixed-FPS mode', async () => {
    mockTabResolution();
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message) =>
        message?.type === OFFSCREEN_MESSAGE_TYPES.GIF_FINISH
          ? { success: true, gifData: [1, 2, 3], byteLength: 3 }
          : { success: true },
    );

    const start = await gifRecorderTool.execute({
      action: 'start',
      tabId: 7,
      width: 10,
      height: 10,
    });
    const stop = await gifRecorderTool.execute({ action: 'stop' });

    expect(start.isError).toBe(false);
    expect(stop.isError).toBe(false);
    expect(responsePayload(stop as any).byteLength).toBe(3);
  });

  it('accepts a legacy gifData finish response in auto-capture mode', async () => {
    mockTabResolution();
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message) =>
        message?.type === OFFSCREEN_MESSAGE_TYPES.GIF_FINISH
          ? { success: true, gifData: [1, 2, 3], byteLength: 3 }
          : { success: true },
    );

    const start = await gifRecorderTool.execute({
      action: 'auto_start',
      tabId: 7,
      maxFrames: 1,
      width: 10,
      height: 10,
    });
    const stop = await gifRecorderTool.execute({ action: 'stop' });

    expect(start.isError).toBe(false);
    expect(stop.isError).toBe(false);
    expect(responsePayload(stop as any).byteLength).toBe(3);
  });

  it('rejects an oversized declared GIF output in fixed-FPS mode before download', async () => {
    mockTabResolution();
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message) =>
        message?.type === OFFSCREEN_MESSAGE_TYPES.GIF_FINISH
          ? {
              success: true,
              gifBase64: 'AQID',
              byteLength: GIF_TRANSPORT_LIMITS.maxOutputBytes + 1,
            }
          : { success: true },
    );

    const start = await gifRecorderTool.execute({
      action: 'start',
      tabId: 7,
      width: 10,
      height: 10,
    });
    const stop = await gifRecorderTool.execute({ action: 'stop' });

    expect(start.isError).toBe(false);
    expect(stop.isError).toBe(true);
    expect(responsePayload(stop as any).error).toContain('byteLength');
    expect(getGifCaptureOwner()).toBeNull();
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared GIF output in auto mode and releases capture state', async () => {
    mockTabResolution();
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message) =>
        message?.type === OFFSCREEN_MESSAGE_TYPES.GIF_FINISH
          ? {
              success: true,
              gifBase64: 'AQID',
              byteLength: GIF_TRANSPORT_LIMITS.maxOutputBytes + 1,
            }
          : { success: true },
    );

    const start = await gifRecorderTool.execute({
      action: 'auto_start',
      tabId: 7,
      maxFrames: 1,
      width: 10,
      height: 10,
    });
    const stop = await gifRecorderTool.execute({ action: 'stop' });

    expect(start.isError).toBe(false);
    expect(stop.isError).toBe(true);
    expect(responsePayload(stop as any).error).toContain('byteLength');
    expect(getGifCaptureOwner()).toBeNull();
    expect(isAutoCaptureActive(7)).toBe(false);
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });

  it('rejects oversized auto-capture dimensions before acquiring resources', async () => {
    const result = await startAutoCapture(7, {
      width: GIF_TRANSPORT_LIMITS.maxWidth + 1,
      height: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('dimensions exceed');
    expect(getGifCaptureOwner()).toBeNull();
    expect(cdpSessionManager.attach).not.toHaveBeenCalled();
  });

  it('releases an idle auto capture after its absolute TTL', async () => {
    vi.useFakeTimers();

    const started = await startAutoCapture(7, {
      width: 10,
      height: 10,
      maxFrames: 10,
    });
    expect(started.success).toBe(true);
    expect(getGifCaptureOwner()).toEqual({ mode: 'auto_capture', tabId: 7 });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

    expect(getGifCaptureOwner()).toBeNull();
    expect(isAutoCaptureActive(7)).toBe(false);
    expect(cdpSessionManager.detach).toHaveBeenCalledWith(
      7,
      'gif-auto-capture',
    );
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
