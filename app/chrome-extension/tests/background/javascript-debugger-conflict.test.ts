import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { withSession, sendCommand } = vi.hoisted(() => ({
  withSession: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: { withSession, sendCommand },
}));

describe('javascriptTool debugger ownership', () => {
  let javascriptTool: typeof import('@/entrypoints/background/tools/browser/javascript').javascriptTool;

  beforeEach(async () => {
    vi.resetModules();
    withSession.mockRejectedValue(
      new Error('Debugger is already attached to tab 7 by another client'),
    );
    ({ javascriptTool } =
      await import('@/entrypoints/background/tools/browser/javascript'));
    vi.spyOn(javascriptTool as any, 'tryGetTab').mockResolvedValue({
      id: 7,
      index: 0,
      windowId: 2,
      active: true,
      url: 'https://example.com/',
    } as chrome.tabs.Tab);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fails without executing code through an unapproved fallback', async () => {
    const result = await javascriptTool.execute({
      tabId: 7,
      code: 'return document.title;',
    });
    const body = JSON.parse(
      String((result.content[0] as { text?: string }).text || '{}'),
    );

    expect(result.isError).toBe(true);
    expect(body.engine).toBe('cdp');
    expect(body.error.kind).toBe('debugger_conflict');
    expect(body.warnings).toEqual([
      expect.stringContaining('was not executed'),
    ]);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(
      (chrome as typeof chrome & { userScripts?: unknown }).userScripts,
    ).toBeUndefined();
  });
});
