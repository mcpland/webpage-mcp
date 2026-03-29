/**
 * High Risk Actions Integration Tests (M3-full batch 2)
 *
 * Purpose:
 *   Verify that high-risk step types (click, navigate, tabs) are properly routed
 *   based on hybrid allowlist configuration, and that skipNavWait policy works correctly.
 *
 * Test Strategy:
 *   - Use real HybridStepExecutor + real ActionRegistry + real handlers
 *   - Mock only environment boundaries:
 *     - chrome.* APIs (tabs, windows)
 *     - handleCallTool (tool bridge)
 *     - selectorLocator.locate (element location)
 *     - navigation wait functions
 *
 * Coverage:
 *   - Default hybrid: click/navigate/openTab/switchTab route to legacy
 *   - Opt-in: click/navigate can route to actions with custom allowlist
 *   - skipNavWait: controls whether navigate handler does internal nav-wait
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

// =============================================================================
// Mock Setup (using vi.hoisted for proper hoisting)
// =============================================================================

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
  locate: vi.fn(),
  tabsSendMessage: vi.fn(),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
  tabsCreate: vi.fn(),
  tabsUpdate: vi.fn(),
  windowsCreate: vi.fn(),
  windowsUpdate: vi.fn(),
  waitForNavigationDone: vi.fn(),
  ensureReadPageIfWeb: vi.fn(),
  maybeQuickWaitForNav: vi.fn(),
  waitForNetworkIdle: vi.fn(),
}));

// Mock tool bridge
vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));

// Mock selector locator
vi.mock('@/shared/selector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/selector')>();
  return {
    ...actual,
    createChromeSelectorLocator: () => ({
      locate: mocks.locate,
    }),
  };
});

// Mock navigation wait wrappers to avoid real webNavigation waiting
vi.mock('@/entrypoints/background/record-replay/engine/policies/wait', () => ({
  waitForNavigationDone: mocks.waitForNavigationDone,
  ensureReadPageIfWeb: mocks.ensureReadPageIfWeb,
  maybeQuickWaitForNav: mocks.maybeQuickWaitForNav,
  waitForNetworkIdle: mocks.waitForNetworkIdle,
}));

// =============================================================================
// Imports (after mocks)
// =============================================================================

import { createMockExecCtx } from './_test-helpers';
import { createHybridConfig } from '@/entrypoints/background/record-replay/engine/execution-mode';
import { HybridStepExecutor } from '@/entrypoints/background/record-replay/engine/runners/step-executor';
import { createReplayActionRegistry } from '@/entrypoints/background/record-replay/actions';

// =============================================================================
// Test Constants
// =============================================================================

const TAB_ID = 1;
const OTHER_TAB_ID = 2;
const FRAME_ID = 0;

// =============================================================================
// Helper Types and Functions
// =============================================================================

interface TestStep {
  id: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Create executor with configurable hybrid config
 */
function createExecutor(overrides?: Parameters<typeof createHybridConfig>[0]): HybridStepExecutor {
  const registry = createReplayActionRegistry();
  const config = createHybridConfig(overrides);
  return new HybridStepExecutor(registry, config);
}

/**
 * Setup default mock responses for handleCallTool
 */
function setupDefaultToolMock(): void {
  mocks.handleCallTool.mockImplementation(async () => ({}));
}

/**
 * Setup default mock responses for chrome.tabs.sendMessage
 */
function setupDefaultTabsMessageMock(): void {
  mocks.tabsSendMessage.mockImplementation(async (_tabId: number, message: unknown) => {
    const msg = message as { action?: string };
    switch (msg.action) {
      case TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR:
        return { success: true, ref: 'ref_from_selector', center: { x: 1, y: 1 } };
      case TOOL_MESSAGE_TYPES.RESOLVE_REF:
        return { success: true, rect: { width: 100, height: 20 }, center: { x: 1, y: 1 } };
      default:
        return { success: true };
    }
  });
}

/**
 * Setup default mock responses for chrome.tabs.query
 */
function setupDefaultTabsQueryMock(): void {
  mocks.tabsQuery.mockImplementation(async (queryInfo?: unknown) => {
    const q = queryInfo as Record<string, unknown> | undefined;
    if (q?.active === true) {
      return [{ id: TAB_ID, url: 'https://example.com/', status: 'complete', windowId: 1 }];
    }
    return [
      {
        id: TAB_ID,
        url: 'https://example.com/',
        title: 'Example',
        status: 'complete',
        windowId: 1,
      },
      {
        id: OTHER_TAB_ID,
        url: 'https://other.example.com/',
        title: 'Other',
        status: 'complete',
        windowId: 2,
      },
    ];
  });
}

/**
 * Setup default mock responses for chrome.tabs.get
 */
function setupDefaultTabsGetMock(): void {
  mocks.tabsGet.mockImplementation(async (tabId: number) => {
    if (tabId === TAB_ID) {
      return { id: TAB_ID, url: 'https://before.example/', status: 'complete', windowId: 1 };
    }
    if (tabId === OTHER_TAB_ID) {
      return {
        id: OTHER_TAB_ID,
        url: 'https://other.example.com/',
        status: 'complete',
        windowId: 2,
      };
    }
    return { id: tabId, url: 'https://unknown.example/', status: 'complete', windowId: 1 };
  });
}

// =============================================================================
// Test Suite
// =============================================================================

describe('high-risk actions integration (M3-full batch 2)', () => {
  beforeEach(() => {
    // Reset all mocks
    Object.values(mocks).forEach((mock) => mock.mockReset());

    // Default behaviors
    setupDefaultToolMock();
    setupDefaultTabsMessageMock();
    setupDefaultTabsQueryMock();
    setupDefaultTabsGetMock();

    // Default selector locate result
    mocks.locate.mockResolvedValue({ ref: 'ref_default', frameId: FRAME_ID, resolvedBy: 'css' });

    // Default tab/window operations
    mocks.tabsCreate.mockResolvedValue({ id: OTHER_TAB_ID });
    mocks.tabsUpdate.mockResolvedValue({});
    mocks.windowsCreate.mockResolvedValue({ tabs: [{ id: OTHER_TAB_ID }] });
    mocks.windowsUpdate.mockResolvedValue({});

    // Default wait wrappers (no-op)
    mocks.waitForNavigationDone.mockResolvedValue(undefined);
    mocks.ensureReadPageIfWeb.mockResolvedValue(undefined);
    mocks.maybeQuickWaitForNav.mockResolvedValue(undefined);
    mocks.waitForNetworkIdle.mockResolvedValue(undefined);

    // Stub chrome.* globals
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: mocks.tabsSendMessage,
        get: mocks.tabsGet,
        query: mocks.tabsQuery,
        create: mocks.tabsCreate,
        update: mocks.tabsUpdate,
      },
      windows: {
        create: mocks.windowsCreate,
        update: mocks.windowsUpdate,
      },
      webNavigation: {
        getAllFrames: vi.fn(async () => []),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ===========================================================================
  // Routing Tests (default hybrid allowlist)
  // ===========================================================================

  describe('routing (default hybrid allowlist)', () => {
    it('click routes to legacy', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'click_routing_legacy',
        type: 'click',
        target: { candidates: [{ type: 'css', value: '#btn' }] },
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('legacy');
      // Actions locator is only used by ActionRegistry handlers
      expect(mocks.locate).not.toHaveBeenCalled();
    });

    it('dblclick routes to legacy', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'dblclick_routing_legacy',
        type: 'dblclick',
        target: { candidates: [{ type: 'css', value: '#btn' }] },
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('legacy');
      expect(mocks.locate).not.toHaveBeenCalled();
    });

    it('navigate routes to legacy', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'navigate_routing_legacy',
        type: 'navigate',
        url: 'https://example.com/next',
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('legacy');
    });

    it('openTab routes to legacy', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'openTab_routing_legacy',
        type: 'openTab',
        url: 'https://example.com/new',
        newWindow: false,
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('legacy');
    });

    it('legacy openTab rejects local file URLs when execution forbids local file pages', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({
        frameId: FRAME_ID,
        execution: { disallowLocalFilePages: true },
      });

      const step: TestStep = {
        id: 'openTab_legacy_file_url_rejected',
        type: 'openTab',
        url: 'file:///tmp/secret.txt',
        newWindow: false,
      };

      await expect(executor.execute(ctx, step as never, { tabId: TAB_ID })).rejects.toThrow(
        'Public flow runs cannot open local file URLs. Use an HTTP(S) page instead.',
      );
      expect(mocks.tabsCreate).not.toHaveBeenCalled();
      expect(mocks.windowsCreate).not.toHaveBeenCalled();
    });

    it('switchTab routes to legacy', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'switchTab_routing_legacy',
        type: 'switchTab',
        urlContains: 'other.example.com',
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('legacy');
    });

    it('legacy switchTab rejects local file tabs when execution forbids local file pages', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({
        frameId: FRAME_ID,
        execution: { disallowLocalFilePages: true },
      });

      mocks.tabsQuery.mockResolvedValueOnce([
        {
          id: OTHER_TAB_ID,
          url: 'file:///tmp/secret.txt',
          title: 'Secret',
          status: 'complete',
          windowId: 2,
        },
      ]);

      const step: TestStep = {
        id: 'switchTab_legacy_file_tab_rejected',
        type: 'switchTab',
        urlContains: 'secret.txt',
      };

      await expect(executor.execute(ctx, step as never, { tabId: TAB_ID })).rejects.toThrow(
        'Public flow runs cannot switch to local file tabs. Use an HTTP(S) tab instead.',
      );
      expect(mocks.handleCallTool).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.SWITCH_TAB,
        }),
      );
    });
  });

  // ===========================================================================
  // Opt-in Actions Tests
  // ===========================================================================

  describe('click/navigate actions opt-in', () => {
    it('click routes to actions when allowlisted', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['click']) });
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'click_allowlisted_actions',
        type: 'click',
        target: { candidates: [{ type: 'css', value: '#btn' }] },
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.locate).toHaveBeenCalled();

      const toolCalls = mocks.handleCallTool.mock.calls.map(
        ([arg]) => (arg as { name: string }).name,
      );
      expect(toolCalls).toContain(TOOL_NAMES.BROWSER.READ_PAGE);
      expect(toolCalls).toContain(TOOL_NAMES.BROWSER.CLICK);

      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.CLICK,
          args: expect.objectContaining({ tabId: TAB_ID }),
        }),
      );
    });

    it('navigate skipNavWait=true skips beforeUrl read', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['navigate']) });
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'navigate_skipNavWait_true',
        type: 'navigate',
        url: 'https://example.com/next',
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      // When skipNavWait=true (default), handler skips reading beforeUrl
      expect(mocks.tabsGet).not.toHaveBeenCalled();
      expect(mocks.waitForNavigationDone).not.toHaveBeenCalled();
      expect(mocks.ensureReadPageIfWeb).not.toHaveBeenCalled();

      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.NAVIGATE,
          args: expect.objectContaining({ url: 'https://example.com/next', tabId: TAB_ID }),
        }),
      );
    });

    it('navigate skipNavWait=false does nav-wait', async () => {
      const executor = createExecutor({
        actionsAllowlist: new Set(['navigate']),
        skipActionsNavWait: false,
      });
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'navigate_skipNavWait_false',
        type: 'navigate',
        url: 'https://example.com/next',
        timeoutMs: 5000,
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      // When skipNavWait=false, handler reads beforeUrl and does nav-wait
      expect(mocks.tabsGet).toHaveBeenCalled();
      expect(mocks.waitForNavigationDone).toHaveBeenCalledWith(
        'https://before.example/',
        expect.any(Number),
        TAB_ID,
      );
      expect(mocks.ensureReadPageIfWeb).toHaveBeenCalledWith(TAB_ID);

      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.NAVIGATE,
          args: expect.objectContaining({ url: 'https://example.com/next', tabId: TAB_ID }),
        }),
      );
    });

    it('navigate with refresh=true calls NAVIGATE tool with refresh', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['navigate']) });
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'navigate_refresh',
        type: 'navigate',
        refresh: true,
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.NAVIGATE,
          args: expect.objectContaining({ refresh: true, tabId: TAB_ID }),
        }),
      );
    });

    it('click fails when element not visible', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['click']) });
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      // Mock resolveRef to return element not visible
      mocks.tabsSendMessage.mockImplementation(async (_tabId: number, message: unknown) => {
        const msg = message as { action?: string };
        if (msg.action === TOOL_MESSAGE_TYPES.RESOLVE_REF) {
          return { success: true, rect: { width: 0, height: 0 }, center: { x: 0, y: 0 } };
        }
        return { success: true };
      });

      const step: TestStep = {
        id: 'click_not_visible',
        type: 'click',
        target: { candidates: [{ type: 'css', value: '#hidden-btn' }] },
      };

      await expect(executor.execute(ctx, step as never, { tabId: TAB_ID })).rejects.toThrow(
        /not visible|ELEMENT_NOT_VISIBLE/i,
      );
    });

    it('click fails when CLICK tool returns error', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['click']) });
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      // Mock CLICK tool to return error
      mocks.handleCallTool.mockImplementation(async (req: { name: string }) => {
        if (req.name === TOOL_NAMES.BROWSER.CLICK) {
          return {
            isError: true,
            content: [{ text: 'Element not found in DOM' }],
          };
        }
        return {};
      });

      const step: TestStep = {
        id: 'click_tool_error',
        type: 'click',
        target: { candidates: [{ type: 'css', value: '#missing' }] },
      };

      await expect(executor.execute(ctx, step as never, { tabId: TAB_ID })).rejects.toThrow(
        /Element not found|failed|error/i,
      );
    });
  });
});
