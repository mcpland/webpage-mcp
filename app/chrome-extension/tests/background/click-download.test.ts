import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
  waitForDownload: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: mocks.attach,
    detach: mocks.detach,
    sendCommand: mocks.sendCommand,
  },
}));

vi.mock('@/entrypoints/background/tools/browser/download', () => ({
  waitForDownload: mocks.waitForDownload,
}));

import { clickTool } from '@/entrypoints/background/tools/browser/interaction';

const payloadOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(String(result.content[0]?.text || '{}'));

describe('chrome_click_element waitForDownload', () => {
  beforeEach(() => {
    mocks.attach.mockResolvedValue(undefined);
    mocks.detach.mockResolvedValue(undefined);
    mocks.sendCommand.mockResolvedValue({});
    vi.spyOn(clickTool as any, 'tryGetTab').mockResolvedValue({
      id: 7,
      windowId: 2,
      url: 'https://example.com/',
      active: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('arms the download watcher before clicking and returns the download', async () => {
    const order: string[] = [];
    mocks.waitForDownload.mockImplementation(async () => {
      order.push('armed');
      return { id: 5, filename: 'report.txt', state: 'complete' };
    });
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string, params?: any) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
        order.push('clicked');
      }
      return {};
    });

    const result = await clickTool.execute({
      tabId: 7,
      coordinates: { x: 10, y: 20 },
      waitForDownload: true,
    });

    expect(result.isError).toBe(false);
    expect(payloadOf(result).download).toEqual({ id: 5, filename: 'report.txt', state: 'complete' });
    expect(order).toEqual(['armed', 'clicked']);
    expect(mocks.waitForDownload).toHaveBeenCalledWith(
      expect.objectContaining({ onlyNew: true, waitForComplete: true, timeoutMs: 30000 }),
    );
  });

  it('keeps the click successful and warns when no download starts', async () => {
    mocks.waitForDownload.mockRejectedValue(new Error('Download wait timed out'));

    const result = await clickTool.execute({
      tabId: 7,
      coordinates: { x: 10, y: 20 },
      waitForDownload: { timeoutMs: 2000, filenameContains: 'report' },
    });
    const payload = payloadOf(result);

    expect(result.isError).toBe(false);
    expect(payload.download).toBeUndefined();
    expect(payload.warnings).toContain('waitForDownload: Download wait timed out');
    expect(mocks.waitForDownload).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 2000, filenameContains: 'report' }),
    );
  });

  it('rejects malformed waitForDownload values before clicking', async () => {
    const result = await clickTool.execute({
      tabId: 7,
      coordinates: { x: 10, y: 20 },
      waitForDownload: { timeoutMs: 5 },
    });

    expect(result.isError).toBe(true);
    expect(mocks.waitForDownload).not.toHaveBeenCalled();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });
});
