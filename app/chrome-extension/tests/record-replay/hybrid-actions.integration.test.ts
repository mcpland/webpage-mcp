/**
 * Hybrid Actions Integration Tests (M3-full batch 1)
 *
 * Purpose:
 *   Verify that HybridStepExecutor correctly routes allowlisted action types
 *   through the ActionRegistry pipeline, exercising real handlers while
 *   mocking only environment boundaries.
 *
 * Test Strategy:
 *   - Use real HybridStepExecutor + real ActionRegistry + real handlers
 *   - Mock only environment boundaries:
 *     - chrome.* APIs (tabs.sendMessage, scripting.executeScript, etc.)
 *     - handleCallTool (tool bridge to content scripts)
 *     - selectorLocator.locate (element location)
 *
 * Coverage:
 *   - routing sanity: verify allowlist routing works
 *   - fill, key, scroll, wait, delay, assert, screenshot, drag
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

// =============================================================================
// Mock Setup (using vi.hoisted for proper hoisting)
// =============================================================================

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
  uploadLocalFileToInputInternal: vi.fn(),
  locate: vi.fn(),
  tabsSendMessage: vi.fn(),
  tabsGet: vi.fn(),
  scriptingExecuteScript: vi.fn(),
}));

// Mock tool bridge - all action handlers communicate with content scripts via this
vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));

vi.mock('@/entrypoints/background/tools/browser/file-upload', () => ({
  uploadLocalFileToInputInternal: mocks.uploadLocalFileToInputInternal,
}));

// Mock selector locator - prevents real DOM queries
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
 * Create executor with default hybrid config (MINIMAL_HYBRID_ACTION_TYPES)
 */
function createExecutor(): HybridStepExecutor {
  const registry = createReplayActionRegistry();
  const config = createHybridConfig();
  return new HybridStepExecutor(registry, config);
}

/**
 * Setup default mock responses for common chrome.tabs.sendMessage actions
 */
function setupDefaultTabsMessageMock(): void {
  mocks.tabsSendMessage.mockImplementation(async (_tabId: number, message: unknown) => {
    const msg = message as { action?: string };

    switch (msg.action) {
      case TOOL_MESSAGE_TYPES.RESOLVE_REF:
        return { success: true, selector: '#resolved', rect: { width: 100, height: 20 } };
      case 'getAttributeForSelector':
        return { value: 'text' }; // Not a file input
      case 'focusByRef':
        return { success: true };
      case 'waitForSelector':
      case 'waitForText':
        return { success: true };
      default:
        return { success: true };
    }
  });
}

/**
 * Setup default mock responses for handleCallTool
 */
function setupDefaultToolMock(): void {
  mocks.handleCallTool.mockImplementation(async (req: { name: string }) => {
    if (req.name === TOOL_NAMES.BROWSER.SCREENSHOT) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ base64Data: 'dGVzdGRhdGE=' }) }],
      };
    }
    return {};
  });
}

/**
 * Setup default mock responses for chrome.scripting.executeScript
 */
function setupDefaultScriptingMock(): void {
  mocks.scriptingExecuteScript.mockImplementation(
    async (details: { files?: string[]; args?: unknown[] }) => {
      // wait-helper injection path
      if (Array.isArray(details.files) && details.files.length > 0) {
        return [];
      }

      // assert handler expects { passed: boolean } result
      const firstArg = details.args?.[0];
      if (firstArg && typeof firstArg === 'object' && firstArg !== null && 'kind' in firstArg) {
        return [{ result: { passed: true } }];
      }

      // scroll handler expects boolean true
      return [{ result: true }];
    },
  );
}

// =============================================================================
// Test Suite
// =============================================================================

describe('hybrid mode actions integration (M3-full batch 1)', () => {
  beforeEach(() => {
    // Reset all mocks
    Object.values(mocks).forEach((mock) => mock.mockReset());

    // Setup default behaviors
    setupDefaultToolMock();
    mocks.uploadLocalFileToInputInternal.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });
    setupDefaultTabsMessageMock();
    setupDefaultScriptingMock();

    // Default selector locate result
    mocks.locate.mockResolvedValue({ ref: 'ref_default', frameId: FRAME_ID, resolvedBy: 'css' });
    mocks.tabsGet.mockResolvedValue({ id: TAB_ID, url: 'https://example.com/' });

    // Stub chrome.* globals
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: mocks.tabsSendMessage,
        get: mocks.tabsGet,
        query: vi.fn(async () => [{ id: TAB_ID, url: 'https://example.com/' }]),
      },
      scripting: {
        executeScript: mocks.scriptingExecuteScript,
      },
      webNavigation: {
        getAllFrames: vi.fn(async () => []),
      },
      windows: {
        create: vi.fn(),
        update: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ===========================================================================
  // Routing Sanity Tests
  // ===========================================================================

  describe('routing sanity', () => {
    it('routes allowlisted types to actions executor', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      // delay is in MINIMAL_HYBRID_ACTION_TYPES
      const step: TestStep = { id: 'delay_routing_test', type: 'delay', sleep: 0 };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
    });

    it('routes non-allowlisted types to legacy executor', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      // click is NOT in MINIMAL_HYBRID_ACTION_TYPES (high-risk)
      const step: TestStep = {
        id: 'click_routing_test',
        type: 'click',
        target: { candidates: [{ type: 'css', value: '#btn' }] },
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('legacy');
      // Verify actions path was NOT taken (selectorLocator is only used by action handlers)
      expect(mocks.locate).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Fill Action Tests
  // ===========================================================================

  describe('fill action', () => {
    it('routes through ActionRegistry and calls READ_PAGE + FILL tools', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      mocks.locate.mockResolvedValueOnce({ ref: 'ref_fill', frameId: FRAME_ID, resolvedBy: 'css' });

      const step: TestStep = {
        id: 'fill_test',
        type: 'fill',
        target: { candidates: [{ type: 'css', value: '#name' }] },
        value: 'test input',
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');

      // Verify tool calls
      const toolCalls = mocks.handleCallTool.mock.calls.map(([arg]) => arg.name);
      expect(toolCalls).toContain(TOOL_NAMES.BROWSER.READ_PAGE);
      expect(toolCalls).toContain(TOOL_NAMES.BROWSER.FILL);

      // Verify FILL was called with correct parameters
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.FILL,
          args: expect.objectContaining({
            tabId: TAB_ID,
            frameId: FRAME_ID,
            ref: 'ref_fill',
            value: 'test input',
          }),
        }),
      );
    });

    it('handles variable interpolation in fill value', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({
        frameId: FRAME_ID,
        vars: { username: 'john_doe' },
      });

      mocks.locate.mockResolvedValueOnce({ ref: 'ref_fill', frameId: FRAME_ID, resolvedBy: 'css' });

      const step: TestStep = {
        id: 'fill_var_test',
        type: 'fill',
        target: { candidates: [{ type: 'css', value: '#username' }] },
        value: '{username}',
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.FILL,
          args: expect.objectContaining({ value: 'john_doe' }),
        }),
      );
    });

    it('uses the internal file upload helper for file inputs', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({
        frameId: FRAME_ID,
        vars: { upload_path: '/tmp/demo.txt' },
      });

      mocks.locate.mockResolvedValueOnce({ ref: 'ref_fill', frameId: FRAME_ID, resolvedBy: 'css' });
      mocks.tabsSendMessage.mockImplementation(async (_tabId: number, message: unknown) => {
        const msg = message as { action?: string };
        switch (msg.action) {
          case 'getAttributeForSelector':
            return { value: 'file' };
          case TOOL_MESSAGE_TYPES.RESOLVE_REF:
            return { success: true, rect: { width: 100, height: 20 }, center: { x: 1, y: 1 } };
          default:
            return { success: true };
        }
      });

      const step: TestStep = {
        id: 'fill_file_test',
        type: 'fill',
        target: { candidates: [{ type: 'css', value: '#upload' }] },
        value: '{upload_path}',
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.uploadLocalFileToInputInternal).toHaveBeenCalledWith({
        selector: '#upload',
        filePath: '/tmp/demo.txt',
        tabId: TAB_ID,
      });

      const toolCalls = mocks.handleCallTool.mock.calls.map(([arg]) => arg.name);
      expect(toolCalls).toContain(TOOL_NAMES.BROWSER.READ_PAGE);
      expect(toolCalls).not.toContain(TOOL_NAMES.BROWSER.FILL);
      expect(toolCalls).not.toContain(TOOL_NAMES.BROWSER.FILE_UPLOAD);
    });
  });

  // ===========================================================================
  // Key Action Tests
  // ===========================================================================

  describe('key action', () => {
    it('routes to actions and calls KEYBOARD tool', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = { id: 'key_test', type: 'key', keys: 'Enter' };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.KEYBOARD,
          args: expect.objectContaining({ tabId: TAB_ID, keys: 'Enter' }),
        }),
      );
    });

    it('supports complex key combinations', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = { id: 'key_combo_test', type: 'key', keys: 'Control+a' };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.KEYBOARD,
          args: expect.objectContaining({ keys: 'Control+a' }),
        }),
      );
    });
  });

  // ===========================================================================
  // Scroll Action Tests
  // ===========================================================================

  describe('scroll action', () => {
    it('executes window scroll via chrome.scripting in offset mode', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'scroll_offset_test',
        type: 'scroll',
        mode: 'offset',
        offset: { x: 0, y: 200 },
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.scriptingExecuteScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ tabId: TAB_ID }),
          world: 'MAIN',
        }),
      );
    });
  });

  // ===========================================================================
  // Wait Action Tests
  // ===========================================================================

  describe('wait action', () => {
    it('injects helper and sends waitForSelector message', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'wait_selector_test',
        type: 'wait',
        condition: { kind: 'selector', selector: '#ready', visible: true },
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');

      // Verify wait helper injection
      expect(mocks.scriptingExecuteScript).toHaveBeenCalledWith(
        expect.objectContaining({
          files: ['inject-scripts/wait-helper.js'],
          world: 'ISOLATED',
        }),
      );

      // Verify wait request sent to content script
      expect(mocks.tabsSendMessage).toHaveBeenCalledWith(
        TAB_ID,
        expect.objectContaining({ action: 'waitForSelector', selector: '#ready' }),
        expect.objectContaining({ frameId: FRAME_ID }),
      );
    });

    it('supports text wait condition', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'wait_text_test',
        type: 'wait',
        condition: { kind: 'text', text: 'Loading complete' },
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.tabsSendMessage).toHaveBeenCalledWith(
        TAB_ID,
        expect.objectContaining({ action: 'waitForText', text: 'Loading complete' }),
        expect.anything(),
      );
    });
  });

  // ===========================================================================
  // Delay Action Tests
  // ===========================================================================

  describe('delay action', () => {
    it('awaits specified time using timers', async () => {
      vi.useFakeTimers();

      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = { id: 'delay_test', type: 'delay', sleep: 250 };

      const promise = executor.execute(ctx, step as never, { tabId: TAB_ID });
      await vi.advanceTimersByTimeAsync(250);
      const result = await promise;

      expect(result.executor).toBe('actions');
    });

    it('handles zero delay', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = { id: 'delay_zero_test', type: 'delay', sleep: 0 };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
    });
  });

  // ===========================================================================
  // Assert Action Tests
  // ===========================================================================

  describe('assert action', () => {
    it.each(['exists', 'visible'] as const)('handles %s assertion kind', async (kind) => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: `assert_${kind}_test`,
        type: 'assert',
        assert: { kind, selector: '#target' },
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.scriptingExecuteScript).toHaveBeenCalledWith(
        expect.objectContaining({
          args: [expect.objectContaining({ kind })],
        }),
      );
    });

    it('propagates assertion failure as thrown error', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      // Mock all calls to return failed assertion (assert handler polls)
      mocks.scriptingExecuteScript.mockImplementation(
        async (details: { files?: string[]; args?: unknown[] }) => {
          // wait-helper injection path - return empty for file injections
          if (Array.isArray(details.files) && details.files.length > 0) {
            return [];
          }
          // Always return assertion failed
          return [{ result: { passed: false, message: 'Element not found' } }];
        },
      );

      // Use very short timeout to minimize test duration
      // (adapter reads step.timeoutMs, default is 5000ms)
      const step: TestStep = {
        id: 'assert_fail_test',
        type: 'assert',
        assert: { kind: 'exists', selector: '#missing' },
        failStrategy: 'stop',
        timeoutMs: 50, // Very short to speed up test
      };

      // When assertion fails (or times out), adapter throws an error
      await expect(executor.execute(ctx, step as never, { tabId: TAB_ID })).rejects.toThrow(
        /ASSERTION_FAILED|Element not found|Timeout/i,
      );
    });
  });

  // ===========================================================================
  // Screenshot Action Tests
  // ===========================================================================

  describe('screenshot action', () => {
    it('stores base64 data in ctx.vars when saveAs is specified', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'screenshot_test',
        type: 'screenshot',
        fullPage: false,
        saveAs: 'capturedImage',
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(ctx.vars.capturedImage).toBe('dGVzdGRhdGE=');
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.SCREENSHOT,
          args: expect.objectContaining({ tabId: TAB_ID, storeBase64: true }),
        }),
      );
    });

    it('supports fullPage option', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      const step: TestStep = {
        id: 'screenshot_fullpage_test',
        type: 'screenshot',
        fullPage: true,
        saveAs: 'fullCapture',
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.SCREENSHOT,
          args: expect.objectContaining({ fullPage: true }),
        }),
      );
    });
  });

  // ===========================================================================
  // Drag Action Tests
  // ===========================================================================

  describe('drag action', () => {
    it('locates start/end targets and calls COMPUTER left_click_drag', async () => {
      const executor = createExecutor();
      const ctx = createMockExecCtx({ frameId: FRAME_ID });

      // Mock separate locate calls for start and end
      mocks.locate
        .mockResolvedValueOnce({ ref: 'ref_start', frameId: FRAME_ID, resolvedBy: 'css' })
        .mockResolvedValueOnce({ ref: 'ref_end', frameId: FRAME_ID, resolvedBy: 'css' });

      const step: TestStep = {
        id: 'drag_test',
        type: 'drag',
        start: { candidates: [{ type: 'css', value: '#drag-source' }] },
        end: { candidates: [{ type: 'css', value: '#drop-target' }] },
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');

      // Verify both endpoints were located
      expect(mocks.locate).toHaveBeenCalledTimes(2);

      // Verify first call was for start element
      expect(mocks.locate.mock.calls[0]?.[1]).toMatchObject({
        candidates: expect.arrayContaining([expect.objectContaining({ value: '#drag-source' })]),
      });

      // Verify second call was for end element
      expect(mocks.locate.mock.calls[1]?.[1]).toMatchObject({
        candidates: expect.arrayContaining([expect.objectContaining({ value: '#drop-target' })]),
      });

      // Verify COMPUTER tool called with drag action
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: TOOL_NAMES.BROWSER.COMPUTER,
          args: expect.objectContaining({
            action: 'left_click_drag',
            tabId: TAB_ID,
            startRef: 'ref_start',
            ref: 'ref_end',
          }),
        }),
      );
    });
  });
});
