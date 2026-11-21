import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BaseBrowserToolExecutor,
  INJECTED_SCRIPT_PING_ACTIONS,
} from '@/entrypoints/background/tools/base-browser';

class ProbeTool extends BaseBrowserToolExecutor {
  // Deliberately a tool whose own name differs from the helper it injects.
  name = 'chrome_click_element';
  async execute() {
    return { content: [], isError: false };
  }
  inject(...args: Parameters<BaseBrowserToolExecutor['injectContentScript']>) {
    return this.injectContentScript(...args);
  }
}

const A11Y = 'inject-scripts/accessibility-tree-helper.js';
const INTERACTIVE = 'inject-scripts/interactive-elements-helper.js';

function installChrome(pongFor: string[]) {
  const sendMessage = vi.fn(async (_tabId: number, message: { action?: string }) =>
    pongFor.includes(String(message?.action)) ? { status: 'pong' } : undefined,
  );
  const executeScript = vi.fn().mockResolvedValue([]);
  (globalThis.chrome as any).tabs.sendMessage = sendMessage;
  (globalThis.chrome as any).scripting = { executeScript };
  return { sendMessage, executeScript };
}

describe('BaseBrowserToolExecutor.injectContentScript', () => {
  let tool: ProbeTool;
  beforeEach(() => {
    tool = new ProbeTool();
  });

  it('pings the injected script in the top frame instead of the calling tool', async () => {
    const { sendMessage, executeScript } = installChrome([
      INJECTED_SCRIPT_PING_ACTIONS[A11Y],
    ]);

    await tool.inject(7, [A11Y]);

    expect(sendMessage).toHaveBeenCalledWith(
      7,
      { action: 'chrome_read_page_ping' },
      { frameId: 0 },
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      7,
      { action: 'chrome_click_element_ping' },
      expect.anything(),
    );
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('injects a helper even when a different helper answers its own ping', async () => {
    // The accessibility helper is loaded, the interactive-elements helper is not.
    const { executeScript } = installChrome([INJECTED_SCRIPT_PING_ACTIONS[A11Y]]);

    await tool.inject(7, [INTERACTIVE]);

    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 }, files: [INTERACTIVE] }),
    );
  });

  it('only injects the scripts that are not initialized yet', async () => {
    const { executeScript } = installChrome([INJECTED_SCRIPT_PING_ACTIONS[A11Y]]);

    await tool.inject(7, [A11Y, INTERACTIVE]);

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript.mock.calls[0][0].files).toEqual([INTERACTIVE]);
  });

  it('pings the requested frame and injects into it', async () => {
    const { sendMessage, executeScript } = installChrome([]);

    await tool.inject(7, [A11Y], false, 'ISOLATED', false, [3]);

    expect(sendMessage).toHaveBeenCalledWith(
      7,
      { action: 'chrome_read_page_ping' },
      { frameId: 3 },
    );
    expect(executeScript.mock.calls[0][0].target).toEqual({ tabId: 7, frameIds: [3] });
  });

  it('injects into every frame without trusting a single-frame ping', async () => {
    const { sendMessage, executeScript } = installChrome([
      INJECTED_SCRIPT_PING_ACTIONS[A11Y],
    ]);

    await tool.inject(7, [A11Y], false, 'ISOLATED', true);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(executeScript.mock.calls[0][0].target).toEqual({ tabId: 7, allFrames: true });
  });

  it('treats a rejected ping as a missing helper', async () => {
    const { sendMessage, executeScript } = installChrome([]);
    sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist.'));

    await tool.inject(7, [A11Y]);

    expect(executeScript).toHaveBeenCalledTimes(1);
  });
});
