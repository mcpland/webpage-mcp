/**
 * Tab Cursor Integration Tests (M3-full batch 2)
 *
 * Purpose:
 *   Test tab management operations (openTab, switchTab) and verify their behavior,
 *   including ctx.tabId cursor updates after tab operations (M3 requirement).
 *
 * Test Strategy:
 *   - Use real HybridStepExecutor + real ActionRegistry + real tab handlers
 *   - Mock only environment boundaries (chrome.* APIs)
 *
 * Coverage:
 *   - Basic tab operations: openTab with newWindow, switchTab by urlContains
 *   - Tab cursor sync: ctx.tabId updated and used by subsequent steps
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Mock Setup (using vi.hoisted for proper hoisting)
// =============================================================================

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
  locate: vi.fn(),
  tabsQuery: vi.fn(),
  tabsGet: vi.fn(),
  tabsCreate: vi.fn(),
  tabsUpdate: vi.fn(),
  windowsCreate: vi.fn(),
  windowsUpdate: vi.fn(),
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
const NEW_TAB_ID = 101;
const TARGET_TAB_ID = 42;
const TARGET_WINDOW_ID = 999;

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

// =============================================================================
// Test Suite
// =============================================================================

describe('tab cursor integration (M3-full batch 2)', () => {
  beforeEach(() => {
    // Reset all mocks
    Object.values(mocks).forEach((mock) => mock.mockReset());
    setupDefaultToolMock();

    // Default selector locate result
    mocks.locate.mockResolvedValue({ ref: 'ref_default', frameId: 0, resolvedBy: 'css' });

    // Default tabs.query returns current tab
    mocks.tabsQuery.mockResolvedValue([
      {
        id: TAB_ID,
        url: 'https://example.com/',
        title: 'Example',
        windowId: 1,
        status: 'complete',
      },
    ]);

    // Default tabs.get returns tab info
    mocks.tabsGet.mockImplementation(async (tabId: number) => ({
      id: tabId,
      url: 'https://example.com/',
      windowId: TARGET_WINDOW_ID,
      status: 'complete',
    }));

    // Default tab/window creation
    mocks.tabsCreate.mockResolvedValue({ id: NEW_TAB_ID });
    mocks.tabsUpdate.mockResolvedValue({});
    mocks.windowsCreate.mockResolvedValue({ tabs: [{ id: NEW_TAB_ID }] });
    mocks.windowsUpdate.mockResolvedValue({});

    // Stub chrome.* globals
    vi.stubGlobal('chrome', {
      tabs: {
        query: mocks.tabsQuery,
        get: mocks.tabsGet,
        create: mocks.tabsCreate,
        update: mocks.tabsUpdate,
      },
      windows: {
        create: mocks.windowsCreate,
        update: mocks.windowsUpdate,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ===========================================================================
  // ctx.tabId Sync Tests
  // ===========================================================================

  describe('ctx.tabId sync after tab operations', () => {
    it('openTab updates ctx.tabId for subsequent steps', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['openTab', 'click']) });
      const ctx = createMockExecCtx({ tabId: TAB_ID });

      const openStep: TestStep = {
        id: 'openTab_updates_ctx_tabId',
        type: 'openTab',
        newWindow: false,
      };

      await executor.execute(ctx, openStep as never, { tabId: ctx.tabId ?? TAB_ID });

      // ctx.tabId should be updated to the new tab
      expect(ctx.tabId).toBe(NEW_TAB_ID);

      // Verify subsequent step uses the new tabId
      mocks.locate.mockResolvedValueOnce(undefined);

      const clickStep: TestStep = {
        id: 'click_after_openTab',
        type: 'click',
        target: {
          candidates: [{ type: 'css', value: '#btn' }],
        },
      };

      await executor.execute(ctx, clickStep as never, { tabId: ctx.tabId ?? TAB_ID });

      // The click tool should be called with the NEW_TAB_ID
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.objectContaining({ tabId: NEW_TAB_ID }),
        }),
      );
    });

    it('switchTab updates ctx.tabId for subsequent steps', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['switchTab', 'click']) });
      const ctx = createMockExecCtx({ tabId: TAB_ID });

      // Setup tabs.query to return multiple tabs
      mocks.tabsQuery.mockResolvedValueOnce([
        {
          id: TAB_ID,
          url: 'https://example.com/',
          title: 'Example',
          windowId: 1,
          status: 'complete',
        },
        {
          id: TARGET_TAB_ID,
          url: 'https://docs.example.com/',
          title: 'Docs',
          windowId: TARGET_WINDOW_ID,
          status: 'complete',
        },
      ]);

      const switchStep: TestStep = {
        id: 'switchTab_updates_ctx_tabId',
        type: 'switchTab',
        urlContains: 'docs.example.com',
      };

      await executor.execute(ctx, switchStep as never, { tabId: ctx.tabId ?? TAB_ID });

      // ctx.tabId should be updated to the target tab
      expect(ctx.tabId).toBe(TARGET_TAB_ID);

      // Verify subsequent step uses the new tabId
      mocks.locate.mockResolvedValueOnce(undefined);

      const clickStep: TestStep = {
        id: 'click_after_switchTab',
        type: 'click',
        target: {
          candidates: [{ type: 'css', value: '#btn' }],
        },
      };

      await executor.execute(ctx, clickStep as never, { tabId: ctx.tabId ?? TAB_ID });

      // The click tool should be called with the TARGET_TAB_ID
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.objectContaining({ tabId: TARGET_TAB_ID }),
        }),
      );
    });
  });

  // ===========================================================================
  // Basic Tab Operations Tests
  // ===========================================================================

  describe('basic tab operations', () => {
    it('openTab success with new window', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['openTab']) });
      const ctx = createMockExecCtx();

      const step: TestStep = {
        id: 'openTab_newWindow_success',
        type: 'openTab',
        newWindow: true,
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.windowsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'about:blank', focused: true }),
      );
    });

    it('openTab success with new tab in current window', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['openTab']) });
      const ctx = createMockExecCtx();

      const step: TestStep = {
        id: 'openTab_newTab_success',
        type: 'openTab',
        url: 'https://example.com/new-page',
        newWindow: false,
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.tabsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com/new-page', active: true }),
      );
    });

    it('switchTab finds tab by urlContains', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['switchTab']) });
      const ctx = createMockExecCtx();

      // Setup tabs.query to return multiple tabs
      mocks.tabsQuery.mockResolvedValueOnce([
        {
          id: TAB_ID,
          url: 'https://example.com/',
          title: 'Example',
          windowId: 1,
          status: 'complete',
        },
        {
          id: TARGET_TAB_ID,
          url: 'https://docs.example.com/',
          title: 'Docs',
          windowId: TARGET_WINDOW_ID,
          status: 'complete',
        },
      ]);

      // Setup tabs.get to return the target tab
      mocks.tabsGet.mockResolvedValueOnce({
        id: TARGET_TAB_ID,
        url: 'https://docs.example.com/',
        windowId: TARGET_WINDOW_ID,
        status: 'complete',
      });

      const step: TestStep = {
        id: 'switchTab_urlContains_success',
        type: 'switchTab',
        urlContains: 'docs.example.com',
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.tabsUpdate).toHaveBeenCalledWith(TARGET_TAB_ID, { active: true });
      expect(mocks.windowsUpdate).toHaveBeenCalledWith(TARGET_WINDOW_ID, { focused: true });
    });

    it('switchTab finds tab by titleContains', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['switchTab']) });
      const ctx = createMockExecCtx();

      // Setup tabs.query to return multiple tabs
      mocks.tabsQuery.mockResolvedValueOnce([
        {
          id: TAB_ID,
          url: 'https://example.com/',
          title: 'Home Page',
          windowId: 1,
          status: 'complete',
        },
        {
          id: TARGET_TAB_ID,
          url: 'https://example.com/settings',
          title: 'Settings - My Account',
          windowId: TARGET_WINDOW_ID,
          status: 'complete',
        },
      ]);

      mocks.tabsGet.mockResolvedValueOnce({
        id: TARGET_TAB_ID,
        url: 'https://example.com/settings',
        windowId: TARGET_WINDOW_ID,
        status: 'complete',
      });

      const step: TestStep = {
        id: 'switchTab_titleContains_success',
        type: 'switchTab',
        titleContains: 'Settings',
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.tabsUpdate).toHaveBeenCalledWith(TARGET_TAB_ID, { active: true });
    });

    it('switchTab by explicit tabId', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['switchTab']) });
      const ctx = createMockExecCtx();

      mocks.tabsGet.mockResolvedValueOnce({
        id: TARGET_TAB_ID,
        url: 'https://example.com/',
        windowId: TARGET_WINDOW_ID,
        status: 'complete',
      });

      const step: TestStep = {
        id: 'switchTab_byId_success',
        type: 'switchTab',
        tabId: TARGET_TAB_ID,
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.tabsUpdate).toHaveBeenCalledWith(TARGET_TAB_ID, { active: true });
      expect(mocks.windowsUpdate).toHaveBeenCalledWith(TARGET_WINDOW_ID, { focused: true });
    });

    it('switchTab fails when no matching tab found', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['switchTab']) });
      const ctx = createMockExecCtx();

      // Setup tabs.query to return only tabs that don't match
      mocks.tabsQuery.mockResolvedValueOnce([
        {
          id: TAB_ID,
          url: 'https://example.com/',
          title: 'Example',
          windowId: 1,
          status: 'complete',
        },
      ]);

      const step: TestStep = {
        id: 'switchTab_not_found',
        type: 'switchTab',
        urlContains: 'nonexistent.example.com',
      };

      await expect(executor.execute(ctx, step as never, { tabId: TAB_ID })).rejects.toThrow(
        /TAB_NOT_FOUND|no matching tab/i,
      );
    });
  });
});
