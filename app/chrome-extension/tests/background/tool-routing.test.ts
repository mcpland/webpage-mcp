import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigateExecute: vi.fn(),
  switchExecute: vi.fn(),
  getSessionContext: vi.fn(),
  patchSessionContext: vi.fn(),
  runInTabQueue: vi.fn(async (_tabId: number, task: () => Promise<unknown>) => await task()),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
  windowsGet: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools/browser', () => ({
  navigateTool: { name: 'chrome_navigate', execute: mocks.navigateExecute },
  switchTabTool: { name: 'chrome_switch_tab', execute: mocks.switchExecute },
}));

vi.mock('@/entrypoints/background/tools/record-replay', () => ({
  flowRunTool: { name: 'record_replay_flow_run', execute: vi.fn() },
  listPublishedFlowsTool: { name: 'record_replay_list_published', execute: vi.fn() },
}));

vi.mock('@/entrypoints/background/tools/flow-tools', () => ({
  flowAnalyzeTool: { name: 'flow_analyze', execute: vi.fn() },
  flowUpdateTool: { name: 'flow_update', execute: vi.fn() },
  workflowDebugViewTool: { name: 'workflow_debug_view', execute: vi.fn() },
  workflowRepairTool: { name: 'workflow_repair', execute: vi.fn() },
}));

vi.mock('@/entrypoints/background/tools/recording', () => ({
  recordingStartTool: { name: 'recording_start', execute: vi.fn() },
  recordingStatusTool: { name: 'recording_status', execute: vi.fn() },
  recordingStopTool: { name: 'recording_stop', execute: vi.fn() },
}));

vi.mock('@/entrypoints/background/session-context', () => ({
  getSessionContext: mocks.getSessionContext,
  patchSessionContext: mocks.patchSessionContext,
}));

vi.mock('@/entrypoints/background/tab-queue', () => ({
  runInTabQueue: mocks.runInTabQueue,
}));

import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';

describe('handleCallTool navigation routing', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());

    mocks.getSessionContext.mockReturnValue({
      tabId: 10,
      windowId: 55,
      updatedAt: Date.now(),
    });
    mocks.patchSessionContext.mockImplementation(() => undefined);
    mocks.runInTabQueue.mockImplementation(
      async (_tabId: number, task: () => Promise<unknown>) => await task(),
    );
    mocks.navigateExecute.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            tabId: 10,
            windowId: 55,
            url: 'https://www.baidu.com',
          }),
        },
      ],
      isError: false,
    });
    mocks.switchExecute.mockResolvedValue({
      content: [{ type: 'text', text: 'switch failed' }],
      isError: true,
    });
    mocks.tabsGet.mockResolvedValue({ id: 10, windowId: 55, url: 'https://github.com/unadlib' });
    mocks.tabsQuery.mockResolvedValue([{ id: 99, windowId: 88, active: true }]);
    mocks.windowsGet.mockResolvedValue({ id: 55 });

    vi.stubGlobal('chrome', {
      tabs: {
        get: mocks.tabsGet,
        query: mocks.tabsQuery,
      },
      windows: {
        get: mocks.windowsGet,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps default URL navigation targeted at the session tab', async () => {
    mocks.navigateExecute.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Navigated current tab',
            tabId: 10,
            windowId: 55,
            url: 'https://www.baidu.com',
          }),
        },
      ],
      isError: false,
    });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: 'https://www.baidu.com', background: false },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.tabsGet).toHaveBeenCalledWith(10);
    expect(mocks.navigateExecute).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
      background: false,
      tabId: 10,
      windowId: 55,
    });
    expect(mocks.runInTabQueue).toHaveBeenCalledTimes(1);
    expect(mocks.patchSessionContext).toHaveBeenCalledWith(
      'session-1',
      { tabId: 10, windowId: 55 },
      undefined,
    );
  });

  it('uses the live session tab window for explicit new-tab navigation', async () => {
    mocks.getSessionContext.mockReturnValueOnce({
      tabId: 10,
      windowId: 55,
      updatedAt: Date.now(),
    });
    mocks.tabsGet.mockResolvedValueOnce({ id: 10, windowId: 77, url: 'https://github.com/unadlib' });
    mocks.navigateExecute.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Opened URL in new tab',
            tabId: 200,
            windowId: 77,
            url: 'https://www.baidu.com',
          }),
        },
      ],
      isError: false,
    });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: 'https://www.baidu.com', newTab: true },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.tabsGet).toHaveBeenCalledWith(10);
    expect(mocks.navigateExecute).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
      newTab: true,
      windowId: 77,
    });
    expect(mocks.runInTabQueue).not.toHaveBeenCalled();
    expect(mocks.patchSessionContext).toHaveBeenCalledWith(
      'session-1',
      { tabId: 200, windowId: 77 },
      undefined,
    );
  });

  it('still injects tabId when chrome_navigate explicitly targets the current tab', async () => {
    mocks.navigateExecute.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Navigated current tab',
            tabId: 10,
            windowId: 55,
            url: 'https://www.baidu.com',
          }),
        },
      ],
      isError: false,
    });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: 'https://www.baidu.com', openMode: 'current_tab' },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.tabsGet).toHaveBeenCalledWith(10);
    expect(mocks.runInTabQueue).toHaveBeenCalledTimes(1);
    expect(mocks.navigateExecute).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
      openMode: 'current_tab',
      tabId: 10,
      windowId: 55,
    });
    expect(mocks.patchSessionContext).toHaveBeenCalledWith(
      'session-1',
      { tabId: 10, windowId: 55 },
      undefined,
    );
  });

  it('does not persist session target updates when chrome_switch_tab fails', async () => {
    await handleCallTool({
      name: TOOL_NAMES.BROWSER.SWITCH_TAB,
      args: { tabId: 44 },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.runInTabQueue).toHaveBeenCalledTimes(1);
    expect(mocks.switchExecute).toHaveBeenCalledWith({ tabId: 44 });
    expect(mocks.patchSessionContext).not.toHaveBeenCalled();
  });
});
