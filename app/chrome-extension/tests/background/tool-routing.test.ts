import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigateExecute: vi.fn(),
  screenshotExecute: vi.fn(),
  switchExecute: vi.fn(),
  readPageExecute: vi.fn(),
  clickExecute: vi.fn(),
  fillExecute: vi.fn(),
  keyboardExecute: vi.fn(),
  networkRequestExecute: vi.fn(),
  dialogExecute: vi.fn(),
  downloadExecute: vi.fn(),
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
  readPageTool: { name: 'chrome_read_page', execute: mocks.readPageExecute },
  clickTool: { name: 'chrome_click_element', execute: mocks.clickExecute },
  fillTool: { name: 'chrome_fill_or_select', execute: mocks.fillExecute },
  keyboardTool: { name: 'chrome_keyboard', execute: mocks.keyboardExecute },
  networkRequestTool: {
    name: 'chrome_network_request',
    execute: mocks.networkRequestExecute,
  },
  handleDialogTool: { name: 'chrome_handle_dialog', execute: mocks.dialogExecute },
  handleDownloadTool: { name: 'chrome_handle_download', execute: mocks.downloadExecute },
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

vi.mock('@/entrypoints/background/tab-queue', async (original) => ({
  ...await original<typeof import('@/entrypoints/background/tab-queue')>(),
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
    const okJson = (extra: Record<string, unknown> = {}) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, tabId: 10, windowId: 55, ...extra }),
        },
      ],
      isError: false,
    });
    mocks.readPageExecute.mockResolvedValue(okJson({ pageContent: '' }));
    mocks.clickExecute.mockResolvedValue(okJson());
    mocks.fillExecute.mockResolvedValue(okJson());
    mocks.keyboardExecute.mockResolvedValue(okJson());
    mocks.networkRequestExecute.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            response: {
              body: { tabId: 200, windowId: 77 },
            },
          }),
        },
      ],
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

  it('routes default URL navigation as a new tab in the session window (tabId not pinned)', async () => {
    // After chrome_navigate's default flipped to "new_tab", the routing layer
    // is window-scoped for implicit-new-tab calls: it injects the session's
    // windowId so the new tab lands in the right window, but it must NOT pin
    // tabId (otherwise NavigateTool would treat it as an in-place target).
    mocks.navigateExecute.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Opened URL in new tab',
            tabId: 200,
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
      windowId: 55,
    });
    expect(mocks.runInTabQueue).not.toHaveBeenCalled();
    expect(mocks.patchSessionContext).toHaveBeenCalledWith(
      'session-1',
      { tabId: 200, windowId: 55 },
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
    }, expect.objectContaining({ deadlineAt: expect.any(Number) }));
  });

  it('keeps the earlier caller deadline when a workflow declares a longer timeout', async () => {
    const deadlineAt = Date.now() + 1000;
    await handleCallTool({
      name: TOOL_NAMES.RECORD_REPLAY.FLOW_RUN, args: { flowId: 'flow-1', timeoutMs: 60000 }, deadlineAt,
    });
    expect(mocks.flowRunExecute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deadlineAt }));
  });

  it('does not apply the MCP background default to non-MCP calls', async () => {
    mocks.storageGet.mockResolvedValueOnce({ [MCP_BACKGROUND_MODE_STORAGE_KEY]: true });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: 'https://www.baidu.com' },
    });

    expect(mocks.storageGet).not.toHaveBeenCalled();
    // Implicit new_tab default → routing is window-scoped; tabId must not be
    // injected (otherwise NavigateTool would treat it as an in-place target).
    expect(mocks.navigateExecute).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
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
    // Implicit new_tab default → window-scoped; tabId is not pinned.
    expect(mocks.navigateExecute).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
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

  it('honours an explicit background:false when MCP Background Mode is disabled', async () => {
    mocks.storageGet.mockResolvedValueOnce({});

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: 'https://www.baidu.com', background: false },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.storageGet).toHaveBeenCalledWith([MCP_BACKGROUND_MODE_STORAGE_KEY]);
    // Implicit new_tab → window-scoped; tabId is intentionally dropped.
    expect(mocks.navigateExecute).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
      background: false,
      windowId: 55,
    });
  });

  it('forces background:true even when caller passes false once MCP Background Mode is enabled', async () => {
    mocks.storageGet.mockResolvedValueOnce({ [MCP_BACKGROUND_MODE_STORAGE_KEY]: true });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: 'https://www.baidu.com', background: false },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.storageGet).toHaveBeenCalledWith([MCP_BACKGROUND_MODE_STORAGE_KEY]);
    expect(mocks.navigateExecute).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
      background: true,
      windowId: 55,
    });
  });

  it('skips the storage lookup when caller already opted into background:true', async () => {
    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: 'https://www.baidu.com', background: true },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.navigateExecute).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
      background: true,
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

  it.each([
    ['record_replay_flow_run', 'flowRunExecute'],
    ['chrome_handle_dialog', 'dialogExecute'],
    ['chrome_handle_download', 'downloadExecute'],
  ] as const)('runs %s outside the per-operation queue', async (name, executeKey) => {
    mocks[executeKey].mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    });

    await handleCallTool({
      name,
      args: { tabId: 10, action: 'accept' },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks[executeKey]).toHaveBeenCalled();
    expect(mocks.runInTabQueue).not.toHaveBeenCalled();
  });

  it('serializes a public flow with other requests while allowing its nested page reads', async () => {
    const order: string[] = [];
    let finishNavigation!: () => void;
    let finishFlow!: () => void;
    mocks.navigateExecute.mockImplementation(async () => {
      order.push('navigate');
      await new Promise<void>((resolve) => { finishNavigation = resolve; });
      return { content: [] };
    });
    mocks.flowRunExecute.mockImplementation(async () => {
      order.push('flow');
      await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId: 10 } });
      order.push('read');
      await new Promise<void>((resolve) => { finishFlow = resolve; });
      return { content: [] };
    });
    mocks.screenshotExecute.mockImplementation(async () => {
      order.push('screenshot');
      return { content: [] };
    });
    const call = (name: string) => handleCallTool({
      name, args: { tabId: 10 }, meta: { source: 'mcp' },
    });
    const navigation = call(TOOL_NAMES.BROWSER.NAVIGATE);
    await vi.waitFor(() => expect(order).toEqual(['navigate']));
    const flow = call(TOOL_NAMES.RECORD_REPLAY.FLOW_RUN);
    const screenshot = call(TOOL_NAMES.BROWSER.SCREENSHOT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['navigate']);
    finishNavigation();
    await vi.waitFor(() => expect(order).toEqual(['navigate', 'flow', 'read']));
    finishFlow();
    await Promise.all([navigation, flow, screenshot]);
    expect(order).toEqual(['navigate', 'flow', 'read', 'screenshot']);
  });

  it('queues navigation addressed by window with a flow on its active tab', async () => {
    mocks.tabsQuery.mockResolvedValue([{ id: 10, windowId: 55, active: true }]);
    let finish!: () => void;
    mocks.navigateExecute.mockImplementation(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { content: [] };
    });
    const navigation = handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE, meta: { source: 'mcp' },
      args: { windowId: 55, openMode: 'current_tab', url: 'https://example.com/slow' },
    });
    await vi.waitFor(() => expect(mocks.navigateExecute).toHaveBeenCalled());
    const flow = handleCallTool({
      name: TOOL_NAMES.RECORD_REPLAY.FLOW_RUN, meta: { source: 'mcp' }, args: { flowId: 'flow-1', tabId: 10 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.tabsQuery).toHaveBeenCalledWith({ active: true, windowId: 55 });
    expect(mocks.navigateExecute).toHaveBeenCalledWith(expect.objectContaining({ tabId: 10 }));
    expect(mocks.flowRunExecute).not.toHaveBeenCalled();
    finish();
    await Promise.all([navigation, flow]);
    expect(mocks.flowRunExecute).toHaveBeenCalledOnce();
  });

  it('passes the call signal to the per-tab queue', async () => {
    const controller = new AbortController();
    mocks.clickExecute.mockResolvedValue({ content: [], isError: false });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.CLICK,
      args: { tabId: 10, selector: '#go' },
      meta: { mcpSessionId: 'session-1' },
      signal: controller.signal,
    });

    expect(mocks.runInTabQueue).toHaveBeenCalledWith(10, expect.any(Function), {
      signal: controller.signal,
    });
  });

  it('adds a page-change summary to MCP interactions only', async () => {
    const listeners: Array<(tabId: number, info: chrome.tabs.TabChangeInfo) => void> = [];
    let tabUrl = 'https://example.com/login';
    (chrome.tabs as any).onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
    (chrome.tabs as any).onUpdated = {
      addListener: vi.fn((listener) => listeners.push(listener)),
      removeListener: vi.fn((listener) => listeners.splice(listeners.indexOf(listener), 1)),
    };
    mocks.tabsGet.mockImplementation(async () => ({
      id: 10,
      windowId: 55,
      url: tabUrl,
      title: tabUrl.endsWith('/home') ? 'Home' : 'Login',
      status: 'complete',
    }));
    mocks.clickExecute.mockImplementation(async () => {
      tabUrl = 'https://example.com/home';
      for (const listener of [...listeners]) listener(10, { url: tabUrl });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, navigationOccurred: false }) }],
        isError: false,
      };
    });

    const viaMcp = await handleCallTool({
      name: TOOL_NAMES.BROWSER.CLICK,
      args: { ref: 'ref_1' },
      meta: { mcpSessionId: 'session-1', source: 'mcp' },
    });
    const payload = JSON.parse(String((viaMcp.content[0] as { text?: string }).text));
    expect(payload).toMatchObject({
      navigationOccurred: true,
      pageChange: { navigated: true, url: 'https://example.com/home', title: 'Home' },
    });
    expect(listeners).toHaveLength(0);

    tabUrl = 'https://example.com/login';
    const internal = await handleCallTool({ name: TOOL_NAMES.BROWSER.CLICK, args: { tabId: 10 } });
    expect(String((internal.content[0] as { text?: string }).text)).not.toContain('pageChange');
  });

  it('lets chrome_switch_tab find its tab by url instead of the session tab', async () => {
    mocks.switchExecute.mockResolvedValue({
      content: [
        { type: 'text', text: JSON.stringify({ success: true, tabId: 200, windowId: 77 }) },
      ],
      isError: false,
    });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.SWITCH_TAB,
      args: { url: 'github.com' },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.switchExecute).toHaveBeenCalledWith({ url: 'github.com' });
    expect(mocks.runInTabQueue).not.toHaveBeenCalled();
    // Later calls in the session target the tab that was switched to.
    expect(mocks.patchSessionContext).toHaveBeenCalledWith(
      'session-1',
      { tabId: 200, windowId: 77 },
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

  it('does not treat nested page-controlled network JSON as session routing metadata', async () => {
    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
      args: { url: 'https://api.example.test/data' },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.networkRequestExecute).toHaveBeenCalledWith({
      url: 'https://api.example.test/data',
      tabId: 10,
      windowId: 55,
    });
    expect(mocks.patchSessionContext).toHaveBeenCalledWith(
      'session-1',
      { tabId: 10, windowId: 55 },
      undefined,
    );
    expect(mocks.patchSessionContext).not.toHaveBeenCalledWith(
      'session-1',
      { tabId: 200, windowId: 77 },
      undefined,
    );
  });

  it('ignores nested target ids even for a trusted target-changing tool', async () => {
    mocks.navigateExecute.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            data: { tabId: 200, windowId: 77 },
          }),
        },
      ],
      isError: false,
    });

    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: 'https://example.test', openMode: 'current_tab' },
      meta: { mcpSessionId: 'session-1' },
    });

    expect(mocks.patchSessionContext).toHaveBeenCalledWith(
      'session-1',
      { tabId: 10, windowId: 55 },
      undefined,
    );
  });

  it.each([
    {
      label: 'chrome_read_page',
      name: TOOL_NAMES.BROWSER.READ_PAGE,
      args: { filter: 'interactive' as const },
      mock: () => mocks.readPageExecute,
    },
    {
      label: 'chrome_click_element',
      name: TOOL_NAMES.BROWSER.CLICK,
      args: { selector: '#btn' },
      mock: () => mocks.clickExecute,
    },
    {
      label: 'chrome_fill_or_select',
      name: TOOL_NAMES.BROWSER.FILL,
      args: { selector: '#email', value: 'a@b.c' },
      mock: () => mocks.fillExecute,
    },
    {
      label: 'chrome_keyboard',
      name: TOOL_NAMES.BROWSER.KEYBOARD,
      args: { keys: 'Enter' },
      mock: () => mocks.keyboardExecute,
    },
  ])(
    'applies MCP Background Mode default to $label so interaction tools stay in the background',
    async ({ name, args, mock }) => {
      mocks.storageGet.mockResolvedValueOnce({ [MCP_BACKGROUND_MODE_STORAGE_KEY]: true });

      await handleCallTool({
        name,
        args,
        meta: { source: 'mcp' },
      });

      expect(mock()).toHaveBeenCalledWith({
        ...args,
        tabId: 99,
        windowId: 88,
        background: true,
      });
    },
  );

  it.each([
    {
      label: 'chrome_read_page',
      name: TOOL_NAMES.BROWSER.READ_PAGE,
      args: { background: false },
      mock: () => mocks.readPageExecute,
    },
    {
      label: 'chrome_click_element',
      name: TOOL_NAMES.BROWSER.CLICK,
      args: { selector: '#btn', background: false },
      mock: () => mocks.clickExecute,
    },
  ])(
    'overrides an explicit background:false for $label when MCP Background Mode is enabled',
    async ({ name, args, mock }) => {
      mocks.storageGet.mockResolvedValueOnce({ [MCP_BACKGROUND_MODE_STORAGE_KEY]: true });

      await handleCallTool({
        name,
        args,
        meta: { source: 'mcp' },
      });

      expect(mock()).toHaveBeenCalledWith(
        expect.objectContaining({ background: true }),
      );
    },
  );

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

  it('does not start a queued tool after its request is cancelled', async () => {
    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    mocks.runInTabQueue.mockImplementationOnce(
      async (_tabId: number, task: () => Promise<unknown>) => {
        await queueGate;
        return task();
      },
    );
    const controller = new AbortController();
    const execution = handleCallTool({
      name: TOOL_NAMES.BROWSER.CLICK,
      args: { selector: '#danger' },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.runInTabQueue).toHaveBeenCalledOnce());

    controller.abort();
    releaseQueue();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.clickExecute).not.toHaveBeenCalled();
  });

  it('passes the request signal into workflow execution', async () => {
    const controller = new AbortController();

    await handleCallTool({
      name: TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
      args: { flowId: 'flow-1' },
      signal: controller.signal,
    });

    expect(mocks.flowRunExecute).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'flow-1' }),
      { signal: controller.signal, deadlineAt: expect.any(Number) },
    );
  });

  it('cleans up page-change observers when a tool call is aborted during execution', async () => {
    const updatedListeners: Array<(...args: any[]) => void> = [];
    (chrome.tabs as any).onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
    (chrome.tabs as any).onUpdated = {
      addListener: vi.fn((l: any) => updatedListeners.push(l)),
      removeListener: vi.fn((l: any) => {
        const idx = updatedListeners.indexOf(l);
        if (idx >= 0) updatedListeners.splice(idx, 1);
      }),
    };
    const controller = new AbortController();
    mocks.clickExecute.mockImplementationOnce(async () => {
      controller.abort();
      return { content: [{ type: 'text', text: '{"success":true}' }], isError: false };
    });

    await expect(
      handleCallTool({
        name: TOOL_NAMES.BROWSER.CLICK,
        args: { ref: 'ref_1' },
        meta: { mcpSessionId: 'session-1', source: 'mcp' },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(updatedListeners).toHaveLength(0);
  });
});
