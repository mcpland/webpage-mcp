import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
  uploadLocalFileToInputInternal: vi.fn(),
  locateElement: vi.fn(),
  resolveNodeTabId: vi.fn(),
  tabsSendMessage: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));

vi.mock('@/entrypoints/background/tools/browser/file-upload', () => ({
  uploadLocalFileToInputInternal: mocks.uploadLocalFileToInputInternal,
}));

vi.mock('@/entrypoints/background/record-replay/selector-engine', () => ({
  locateElement: mocks.locateElement,
}));

vi.mock('@/entrypoints/background/record-replay/nodes/tab-context', () => ({
  resolveNodeTabId: mocks.resolveNodeTabId,
}));

import { fillNode } from '@/entrypoints/background/record-replay/nodes/fill';
import { TOOL_NAMES } from 'webpage-mcp-shared';

describe('fillNode file uploads', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());

    mocks.resolveNodeTabId.mockResolvedValue(7);
    mocks.locateElement.mockResolvedValue({ frameId: 0, resolvedBy: 'css' });
    mocks.uploadLocalFileToInputInternal.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });
    mocks.handleCallTool.mockResolvedValue({});
    mocks.tabsSendMessage.mockImplementation(async (_tabId: number, message: unknown) => {
      const msg = message as { action?: string };
      if (msg.action === 'getAttributeForSelector') {
        return { value: 'file' };
      }
      return { success: true };
    });

    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: mocks.tabsSendMessage,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('routes file inputs through the internal upload helper', async () => {
    const ctx = {
      vars: { upload_path: '/tmp/demo.txt' },
      frameId: 0,
      logger: vi.fn(),
    };

    const step = {
      id: 'fill-file',
      type: 'fill',
      target: {
        candidates: [{ type: 'css', value: '#upload' }],
      },
      value: '{upload_path}',
    };

    const result = await fillNode.run(ctx as any, step as any);

    expect(result).toEqual({});
    expect(mocks.handleCallTool).toHaveBeenCalledWith({
      name: TOOL_NAMES.BROWSER.READ_PAGE,
      args: { tabId: 7 },
    });
    expect(mocks.uploadLocalFileToInputInternal).toHaveBeenCalledWith({
      selector: '#upload',
      filePath: '/tmp/demo.txt',
      tabId: 7,
    });

    const toolCalls = mocks.handleCallTool.mock.calls.map(([arg]) => arg.name);
    expect(toolCalls).not.toContain(TOOL_NAMES.BROWSER.FILL);
    expect(toolCalls).not.toContain(TOOL_NAMES.BROWSER.FILE_UPLOAD);
  });
});
