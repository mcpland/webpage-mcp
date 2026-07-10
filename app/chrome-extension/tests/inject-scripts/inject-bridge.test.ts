import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = (
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

describe('inject-bridge request lifecycle', () => {
  let messageListener: RuntimeListener | null;
  let removeListener: ReturnType<typeof vi.fn>;
  let executeRequests: any[];
  let executeHandler: ((event: Event) => void) | null;

  const loadBridge = async () => {
    delete (window as any).__INJECT_SCRIPT_TOOL_UNIVERSAL_BRIDGE_LOADED__;
    messageListener = null;
    removeListener = vi.fn();
    executeRequests = [];
    executeHandler = (event) => executeRequests.push((event as CustomEvent).detail);
    window.addEventListener('webpage-mcp:execute', executeHandler);

    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: RuntimeListener) => {
            messageListener = listener;
          }),
          removeListener,
        },
      },
    });

    // @ts-expect-error The browser-injected bridge intentionally has no TypeScript declaration.
    await import('@/inject-scripts/inject-bridge.js');
    expect(messageListener).not.toBeNull();
  };

  const sendMainRequest = (sendResponse: (response: any) => void) => {
    const handled = messageListener!(
      {
        action: 'userscript:command',
        payload: { value: 1 },
        scriptId: 'script-a',
        targetWorld: 'MAIN',
      },
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );
    expect(handled).toBe(true);
    return executeRequests.at(-1);
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    await loadBridge();
  });

  afterEach(() => {
    window.dispatchEvent(new CustomEvent('webpage-mcp:cleanup'));
    if (executeHandler) window.removeEventListener('webpage-mcp:execute', executeHandler);
    delete (window as any).__INJECT_SCRIPT_TOOL_UNIVERSAL_BRIDGE_LOADED__;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('times out unanswered MAIN world requests and ignores late responses', async () => {
    const sendResponse = vi.fn();
    const request = sendMainRequest(sendResponse);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(sendResponse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(sendResponse).toHaveBeenCalledOnce();
    expect(sendResponse).toHaveBeenCalledWith({
      error: 'MAIN world userscript request timed out after 30000ms.',
    });

    window.dispatchEvent(
      new CustomEvent('webpage-mcp:response', {
        detail: { requestId: request.requestId, data: 'late' },
      }),
    );
    expect(sendResponse).toHaveBeenCalledOnce();
  });

  it('clears the timeout as soon as a MAIN world response arrives', async () => {
    const sendResponse = vi.fn();
    const request = sendMainRequest(sendResponse);

    window.dispatchEvent(
      new CustomEvent('webpage-mcp:response', {
        detail: { requestId: request.requestId, data: 'done' },
      }),
    );
    expect(sendResponse).toHaveBeenCalledWith({ data: 'done', error: undefined });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendResponse).toHaveBeenCalledOnce();
  });

  it('rejects every pending request when the bridge is cleaned up', () => {
    const firstResponse = vi.fn();
    const secondResponse = vi.fn();
    sendMainRequest(firstResponse);
    sendMainRequest(secondResponse);
    const cleanupResponse = vi.fn();

    const handled = messageListener!(
      { type: 'webpage-mcp:cleanup' },
      {} as chrome.runtime.MessageSender,
      cleanupResponse,
    );

    expect(handled).toBe(true);
    expect(firstResponse).toHaveBeenCalledWith({
      error: 'Userscript bridge was cleaned up before receiving a response.',
    });
    expect(secondResponse).toHaveBeenCalledWith({
      error: 'Userscript bridge was cleaned up before receiving a response.',
    });
    expect(cleanupResponse).toHaveBeenCalledWith({ success: true });
    expect(removeListener).toHaveBeenCalledWith(messageListener);
  });

  it('rejects pending requests when the page unloads', () => {
    const sendResponse = vi.fn();
    sendMainRequest(sendResponse);

    window.dispatchEvent(new Event('pagehide'));

    expect(sendResponse).toHaveBeenCalledWith({
      error: 'Userscript bridge page unloaded before receiving a response.',
    });
    expect(removeListener).toHaveBeenCalledWith(messageListener);
  });

  it('does not expose USER_SCRIPT commands to page DOM events', () => {
    const sendResponse = vi.fn();
    const handled = messageListener!(
      {
        action: 'userscript:command',
        payload: { secret: 'private' },
        scriptId: 'script-a',
        targetWorld: 'USER_SCRIPT',
      },
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );

    expect(handled).toBeUndefined();
    expect(executeRequests).toEqual([]);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
