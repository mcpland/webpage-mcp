import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cdpMocks = vi.hoisted(() => ({
  withSession: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: cdpMocks.withSession,
    sendCommand: cdpMocks.sendCommand,
  },
}));

import { createChromeArtifactService } from '@/entrypoints/background/record-replay-v3/engine/kernel/artifacts';

describe('createChromeArtifactService', () => {
  beforeEach(() => {
    cdpMocks.withSession.mockReset();
    cdpMocks.sendCommand.mockReset();
    cdpMocks.withSession.mockImplementation(async (_tabId, _owner, fn) => await fn());
    cdpMocks.sendCommand.mockResolvedValue({ data: 'background-shot' });

    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 7, windowId: 2 }),
        captureVisibleTab: vi.fn().mockResolvedValue('data:image/png;base64,visible-shot'),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses CDP without visible-tab fallback for background screenshots', async () => {
    const service = createChromeArtifactService();
    const result = await service.screenshot(7, { background: true });

    expect(result).toEqual({ ok: true, base64: 'background-shot' });
    expect(cdpMocks.withSession).toHaveBeenCalledWith(7, 'rr-v3-artifact-screenshot', expect.any(Function));
    expect(cdpMocks.sendCommand).toHaveBeenCalledWith(7, 'Page.captureScreenshot', { format: 'png' });
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('returns an error without visible-tab fallback when background CDP capture fails', async () => {
    cdpMocks.sendCommand.mockRejectedValueOnce(new Error('debugger unavailable'));
    const service = createChromeArtifactService();
    const result = await service.screenshot(7, { background: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('debugger unavailable');
    }
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('uses captureVisibleTab for foreground screenshots', async () => {
    const service = createChromeArtifactService();
    const result = await service.screenshot(7);

    expect(result).toEqual({ ok: true, base64: 'visible-shot' });
    expect(chrome.tabs.get).toHaveBeenCalledWith(7);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(2, {
      format: 'png',
      quality: undefined,
    });
    expect(cdpMocks.withSession).not.toHaveBeenCalled();
  });
});
