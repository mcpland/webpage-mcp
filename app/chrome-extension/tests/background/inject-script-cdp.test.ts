import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { withSession, sendCommand } = vi.hoisted(() => ({
  withSession: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: { withSession, sendCommand },
}));

describe('legacy internal script injection', () => {
  let injectScriptTool: typeof import('@/entrypoints/background/tools/browser/inject-script').injectScriptTool;

  beforeEach(async () => {
    vi.resetModules();
    withSession.mockImplementation(
      async (
        _tabId: number,
        _owner: string,
        callback: () => Promise<unknown>,
      ) => await callback(),
    );
    sendCommand.mockResolvedValue({});
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(async () => ({
          id: 7,
          index: 0,
          windowId: 2,
          active: true,
          url: 'https://example.com/',
        })),
        query: vi.fn(async () => []),
        update: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => undefined),
        onRemoved: { addListener: vi.fn() },
      },
      windows: { update: vi.fn(async () => undefined) },
      scripting: { executeScript: vi.fn(async () => []) },
    });
    ({ injectScriptTool } =
      await import('@/entrypoints/background/tools/browser/inject-script'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('routes MAIN code through CDP after injecting only the packaged bridge', async () => {
    const result = await injectScriptTool.execute({
      tabId: 7,
      type: 'MAIN' as never,
      jsScript: 'globalThis.__injected = true;',
      background: true,
    });

    expect(result.isError).toBe(false);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['inject-scripts/inject-bridge.js'],
      world: 'ISOLATED',
    });
    expect(sendCommand).toHaveBeenCalledWith(
      7,
      'Runtime.evaluate',
      expect.objectContaining({
        expression: expect.stringContaining('globalThis.__injected = true;'),
        awaitPromise: true,
      }),
    );
  });

  it('rejects dynamic ISOLATED injection instead of using Function or eval', async () => {
    const result = await injectScriptTool.execute({
      tabId: 7,
      type: 'ISOLATED' as never,
      jsScript: 'globalThis.__injected = true;',
      background: true,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string }).text)).toContain(
      'not supported in Manifest V3',
    );
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
