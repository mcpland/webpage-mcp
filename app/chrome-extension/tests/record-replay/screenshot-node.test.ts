import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from 'webpage-mcp-shared';

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));

import {
  handleDownloadNode,
  screenshotNode,
} from '@/entrypoints/background/record-replay/nodes/download-screenshot-attr-event-frame-loop';
import { createMockExecCtx } from './_test-helpers';

const TAB_ID = 7;

describe('legacy screenshot node', () => {
  beforeEach(() => {
    mocks.handleCallTool.mockReset();
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: TAB_ID });
    (chrome.tabs.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: TAB_ID }]);
  });

  it('stores base64 data when saveAs is specified', async () => {
    mocks.handleCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ base64Data: 'shot-base64' }) }],
    });
    const ctx = createMockExecCtx({ tabId: TAB_ID });

    await screenshotNode.run(ctx, {
      id: 'shot',
      type: 'screenshot',
      saveAs: 'capturedImage',
      background: true,
    } as never);

    expect(ctx.vars.capturedImage).toBe('shot-base64');
    expect(mocks.handleCallTool).toHaveBeenCalledWith({
      name: TOOL_NAMES.BROWSER.SCREENSHOT,
      args: expect.objectContaining({
        tabId: TAB_ID,
        storeBase64: true,
        background: true,
      }),
    });
  });

  it('throws when the screenshot tool returns an error', async () => {
    mocks.handleCallTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'Cannot capture a full page background screenshot' }],
    });
    const ctx = createMockExecCtx({ tabId: TAB_ID });

    await expect(
      screenshotNode.run(ctx, {
        id: 'shot',
        type: 'screenshot',
        fullPage: true,
        background: true,
        saveAs: 'capturedImage',
      } as never),
    ).rejects.toThrow('Cannot capture a full page background screenshot');
  });

  it('throws when saveAs is set but the tool does not return base64 data', async () => {
    mocks.handleCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    });
    const ctx = createMockExecCtx({ tabId: TAB_ID });

    await expect(
      screenshotNode.run(ctx, {
        id: 'shot',
        type: 'screenshot',
        saveAs: 'capturedImage',
      } as never),
    ).rejects.toThrow('screenshot tool returned empty base64Data');
  });

  it('passes the workflow tabId to handleDownload', async () => {
    mocks.handleCallTool.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ download: { id: 1, filename: 'report.pdf' } }),
        },
      ],
    });
    const ctx = createMockExecCtx({ tabId: TAB_ID });

    await handleDownloadNode.run(ctx, {
      id: 'download',
      type: 'handleDownload',
      filenameContains: 'report',
      saveAs: 'downloadInfo',
    } as never);

    expect(mocks.handleCallTool).toHaveBeenCalledWith({
      name: TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD,
      args: expect.objectContaining({
        tabId: TAB_ID,
        filenameContains: 'report',
      }),
    });
    expect(ctx.vars.downloadInfo).toEqual({ id: 1, filename: 'report.pdf' });
  });
});
