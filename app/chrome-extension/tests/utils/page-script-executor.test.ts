import { beforeEach, describe, expect, it, vi } from 'vitest';

const { withSession, sendCommand } = vi.hoisted(() => ({
  withSession: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: { withSession, sendCommand },
}));

import {
  PAGE_SCRIPT_EXECUTION_LIMITS,
  executePageScript,
} from '@/utils/page-script-executor';

describe('page script executor', () => {
  let debuggerListeners: Array<
    (source: chrome.debugger.Debuggee, method: string, params?: object) => void
  >;

  beforeEach(() => {
    withSession.mockImplementation(
      async (
        _tabId: number,
        _owner: string,
        callback: () => Promise<unknown>,
      ) => await callback(),
    );
    sendCommand.mockReset();
    debuggerListeners = [];
    (chrome.debugger as any).onEvent = {
      addListener: vi.fn((listener) => debuggerListeners.push(listener)),
      removeListener: vi.fn((listener) => {
        debuggerListeners = debuggerListeners.filter(
          (candidate) => candidate !== listener,
        );
      }),
    };
    (chrome.webNavigation as any).getAllFrames = vi.fn(async () => []);
  });

  it('executes Function-body code through CDP with bounded JSON arguments', async () => {
    sendCommand.mockResolvedValueOnce({ result: { value: { answer: 3 } } });

    await expect(
      executePageScript({
        tabId: 7,
        code: 'return { answer: count + 1 };',
        args: { count: 2 },
        owner: 'test-script',
      }),
    ).resolves.toEqual({ answer: 3 });

    expect(sendCommand).toHaveBeenCalledWith(
      7,
      'Runtime.evaluate',
      expect.objectContaining({
        expression: expect.stringContaining(
          'const count = __webpageMcpArgs["count"]',
        ),
        awaitPromise: true,
        returnByValue: true,
      }),
    );
  });

  it('creates a CDP isolated world without using extension eval', async () => {
    sendCommand
      .mockResolvedValueOnce({ frameTree: { frame: { id: 'root-frame' } } })
      .mockResolvedValueOnce({ executionContextId: 42 })
      .mockResolvedValueOnce({ result: { value: true } });

    await expect(
      executePageScript({
        tabId: 7,
        frameId: 0,
        code: 'true',
        mode: 'raw',
        world: 'ISOLATED',
      }),
    ).resolves.toBe(true);

    expect(sendCommand).toHaveBeenNthCalledWith(
      2,
      7,
      'Page.createIsolatedWorld',
      {
        frameId: 'root-frame',
        worldName: 'webpage-mcp-workflow',
        grantUniveralAccess: false,
      },
    );
    expect(sendCommand).toHaveBeenNthCalledWith(
      3,
      7,
      'Runtime.evaluate',
      expect.objectContaining({ contextId: 42 }),
    );
  });

  it('maps a unique extension subframe to its MAIN CDP execution context', async () => {
    (
      chrome.webNavigation.getAllFrames as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: 'https://example.com/' },
      { frameId: 2, parentFrameId: 0, url: 'https://example.com/frame' },
    ]);
    sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'root-frame', url: 'https://example.com/' },
            childFrames: [
              {
                frame: {
                  id: 'child-frame',
                  url: 'https://example.com/frame',
                },
              },
            ],
          },
        };
      }
      if (method === 'Runtime.enable') {
        for (const listener of debuggerListeners) {
          listener({ tabId: 7 }, 'Runtime.executionContextCreated', {
            context: {
              id: 73,
              auxData: { frameId: 'child-frame', isDefault: true },
            },
          });
        }
        return {};
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: 'frame-result' } };
      }
      return {};
    });

    await expect(
      executePageScript({
        tabId: 7,
        frameId: 2,
        code: 'document.title',
        mode: 'raw',
      }),
    ).resolves.toBe('frame-result');
    expect(sendCommand).toHaveBeenCalledWith(
      7,
      'Runtime.evaluate',
      expect.objectContaining({ contextId: 73 }),
    );
  });

  it('fails closed for ambiguous frames, oversized code, exceptions, and results', async () => {
    (
      chrome.webNavigation.getAllFrames as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: 'https://example.com/' },
      { frameId: 2, parentFrameId: 0, url: 'about:blank' },
    ]);
    sendCommand.mockResolvedValueOnce({
      frameTree: {
        frame: { id: 'root', url: 'https://example.com/' },
        childFrames: [
          { frame: { id: 'a', url: 'about:blank' } },
          { frame: { id: 'b', url: 'about:blank' } },
        ],
      },
    });
    await expect(
      executePageScript({ tabId: 7, frameId: 2, code: 'return 1;' }),
    ).rejects.toThrow('ambiguous');

    await expect(
      executePageScript({
        tabId: 7,
        code: 'x'.repeat(PAGE_SCRIPT_EXECUTION_LIMITS.maxCodeBytes + 1),
      }),
    ).rejects.toThrow('code exceeds');

    sendCommand.mockResolvedValueOnce({
      exceptionDetails: {
        exception: { description: 'ReferenceError: secret is not defined' },
      },
    });
    await expect(
      executePageScript({ tabId: 7, code: 'return secret;' }),
    ).rejects.toThrow('ReferenceError');

    sendCommand.mockResolvedValueOnce({
      result: {
        value: 'x'.repeat(PAGE_SCRIPT_EXECUTION_LIMITS.maxResultBytes + 1),
      },
    });
    await expect(
      executePageScript({ tabId: 7, code: 'return value;' }),
    ).rejects.toThrow('result exceeds');
  });
});
