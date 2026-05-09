import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigateExecute: vi.fn(),
  screenshotExecute: vi.fn(),
  switchExecute: vi.fn(),
  flowRunExecute: vi.fn(),
  runCancelExecute: vi.fn(),
  listPublishedExecute: vi.fn(),
  workflowPublishExecute: vi.fn(),
  workflowUnpublishExecute: vi.fn(),
  workflowDebugViewExecute: vi.fn(),
  getSessionContext: vi.fn(),
  patchSessionContext: vi.fn(),
  runInTabQueue: vi.fn(async (_tabId: number, task: () => Promise<unknown>) => await task()),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
  storageGet: vi.fn(),
  windowsGet: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools/browser', () => ({
  navigateTool: { name: 'chrome_navigate', execute: mocks.navigateExecute },
  screenshotTool: { name: 'chrome_screenshot', execute: mocks.screenshotExecute },
  switchTabTool: { name: 'chrome_switch_tab', execute: mocks.switchExecute },
}));

vi.mock('@/entrypoints/background/tools/record-replay', () => ({
  flowRunTool: { name: 'record_replay_flow_run', execute: mocks.flowRunExecute },
  runCancelTool: {
    name: 'record_replay_run_cancel',
    execute: mocks.runCancelExecute,
  },
  listPublishedFlowsTool: {
    name: 'record_replay_list_published',
    execute: mocks.listPublishedExecute,
  },
  workflowPublishTool: {
    name: 'workflow_publish',
    execute: mocks.workflowPublishExecute,
  },
  workflowUnpublishTool: {
    name: 'workflow_unpublish',
    execute: mocks.workflowUnpublishExecute,
  },
}));

vi.mock('@/entrypoints/background/tools/flow-tools', () => ({
  flowAnalyzeTool: { name: 'flow_analyze', execute: vi.fn() },
  flowUpdateTool: { name: 'flow_update', execute: vi.fn() },
  workflowApprovalStoreTool: { name: 'workflow_approval_store', execute: vi.fn() },
  workflowDescribeTool: { name: 'workflow_describe', execute: vi.fn() },
  workflowDebugViewTool: { name: 'workflow_debug_view', execute: mocks.workflowDebugViewExecute },
  workflowRepairTool: { name: 'workflow_repair', execute: vi.fn() },
  workflowRepairRollbackTool: { name: 'workflow_repair_rollback', execute: vi.fn() },
  workflowStabilizeTool: { name: 'workflow_stabilize', execute: vi.fn() },
  workflowMigrateTool: { name: 'workflow_migrate', execute: vi.fn() },
  workflowReleaseReadinessTool: { name: 'workflow_release_readiness', execute: vi.fn() },
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
import { MCP_BACKGROUND_MODE_STORAGE_KEY } from '@/common/mcp-background-mode';
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
    mocks.screenshotExecute.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true, tabId: 99, windowId: 88 }) }],
      isError: false,
    });
    mocks.flowRunExecute.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, flowId: 'flow-1', tabId: 10, windowId: 55 }),
        },
      ],
      isError: false,
    });
    mocks.listPublishedExecute.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true, flows: [] }) }],
      isError: false,
    });
    mocks.workflowDebugViewExecute.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });
    mocks.tabsGet.mockResolvedValue({ id: 10, windowId: 55, url: 'https://github.com/unadlib' });
    mocks.tabsQuery.mockResolvedValue([{ id: 99, windowId: 88, active: true }]);
    mocks.storageGet.mockResolvedValue({});
    mocks.windowsGet.mockResolvedValue({ id: 55 });

    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: mocks.storageGet,
        },
      },
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

  it('uses the popup background mode as the default for supported tools', async () => {
    mocks.storageGet.mockResolvedValueOnce({ [MCP_BACKGROUND_MODE_STORAGE_KEY]: true });

    await handleCallTool({
      name: TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
      args: { flowId: 'flow-1' },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.storageGet).toHaveBeenCalledWith([MCP_BACKGROUND_MODE_STORAGE_KEY]);
    expect(mocks.flowRunExecute).toHaveBeenCalledWith({
      flowId: 'flow-1',
      tabId: 10,
      windowId: 55,
      background: true,
    });
  });

  it('does not apply the MCP background default to non-MCP calls', async () => {
    mocks.storageGet.mockResolvedValueOnce({ [MCP_BACKGROUND_MODE_STORAGE_KEY]: true });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: 'https://www.baidu.com' },
    });

    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.navigateExecute).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
      tabId: 99,
      windowId: 88,
    });
  });

  it('uses the MCP source marker for background defaults without a session id', async () => {
    mocks.storageGet.mockResolvedValueOnce({ [MCP_BACKGROUND_MODE_STORAGE_KEY]: true });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: 'https://www.baidu.com' },
      meta: { source: 'mcp' },
    });

    expect(mocks.storageGet).toHaveBeenCalledWith([MCP_BACKGROUND_MODE_STORAGE_KEY]);
    expect(mocks.navigateExecute).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
      tabId: 99,
      windowId: 88,
      background: true,
    });
  });

  it('uses the popup background mode for viewport screenshots', async () => {
    mocks.storageGet.mockResolvedValueOnce({ [MCP_BACKGROUND_MODE_STORAGE_KEY]: true });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.SCREENSHOT,
      args: { storeBase64: true },
      meta: { source: 'mcp' },
    });

    expect(mocks.storageGet).toHaveBeenCalledWith([MCP_BACKGROUND_MODE_STORAGE_KEY]);
    expect(mocks.screenshotExecute).toHaveBeenCalledWith({
      storeBase64: true,
      tabId: 99,
      windowId: 88,
      background: true,
    });
  });

  it('does not force background for full-page or selector screenshots', async () => {
    mocks.storageGet.mockResolvedValue({ [MCP_BACKGROUND_MODE_STORAGE_KEY]: true });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.SCREENSHOT,
      args: { fullPage: true },
      meta: { source: 'mcp' },
    });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.SCREENSHOT,
      args: { selector: '#app' },
      meta: { source: 'mcp' },
    });

    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.screenshotExecute).toHaveBeenNthCalledWith(1, {
      fullPage: true,
      tabId: 99,
      windowId: 88,
    });
    expect(mocks.screenshotExecute).toHaveBeenNthCalledWith(2, {
      selector: '#app',
      tabId: 99,
      windowId: 88,
    });
  });

  it('keeps an explicit background value ahead of the popup default', async () => {
    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: 'https://www.baidu.com', background: false },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.navigateExecute).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
      background: false,
      tabId: 10,
      windowId: 55,
    });
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

  it('does not add background to tools without background support', async () => {
    mocks.storageGet.mockResolvedValueOnce({ [MCP_BACKGROUND_MODE_STORAGE_KEY]: true });

    await handleCallTool({
      name: TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED,
      args: {},
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.listPublishedExecute).toHaveBeenCalledWith({});
  });

  it('passes MCP context to workflow tools even when client capabilities are absent', async () => {
    await handleCallTool({
      name: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_DEBUG_VIEW,
      args: { flowId: 'flow-1' },
      meta: { mcpSessionId: 'session-1', source: 'mcp' },
    });

    expect(mocks.workflowDebugViewExecute).toHaveBeenCalledWith(
      { flowId: 'flow-1' },
      { meta: { mcpSessionId: 'session-1', source: 'mcp' } },
    );
  });
});
