import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = (
  request: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

const scriptPath = join(process.cwd(), 'inject-scripts', 'keyboard-helper.js');
const scriptSource = readFileSync(scriptPath, 'utf8');
const nativeKeyboardEvent = window.KeyboardEvent;

function executeHelper(reset = true): RuntimeListener {
  if (reset) {
    delete (window as any).__KEYBOARD_HELPER_INITIALIZED__;
    vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
  }
  runInThisContext(scriptSource, { filename: scriptPath });
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Keyboard helper did not register a listener');
  return listener as RuntimeListener;
}

function dispatch(listener: RuntimeListener, request: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    listener(request, {} as chrome.runtime.MessageSender, resolve);
  });
}

describe('keyboard-helper page protocol', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.stubGlobal(
      'KeyboardEvent',
      function KeyboardEventForTest(type: string, init: KeyboardEventInit = {}) {
        const { view: _view, ...portableInit } = init;
        return new nativeKeyboardEvent(type, portableInit);
      },
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.replaceChildren();
    delete (window as any).__KEYBOARD_HELPER_INITIALIZED__;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('initializes once and answers the synchronous health check', async () => {
    const listener = executeHelper();
    executeHelper(false);

    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    await expect(dispatch(listener, { action: 'chrome_keyboard_ping' })).resolves.toEqual({
      status: 'pong',
      initialized: true,
    });
  });

  it('dispatches bounded key sequences with modifiers to the selected element', async () => {
    const input = document.createElement('input');
    input.id = 'target';
    document.body.append(input);
    input.focus();
    const events: Array<{ type: string; key: string; ctrlKey: boolean; shiftKey: boolean }> = [];
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.addEventListener(type, (event) => {
        const keyboardEvent = event as KeyboardEvent;
        events.push({
          type,
          key: keyboardEvent.key,
          ctrlKey: keyboardEvent.ctrlKey,
          shiftKey: keyboardEvent.shiftKey,
        });
      });
    }
    const listener = executeHelper();

    const response = await dispatch(listener, {
      action: 'simulateKeyboard',
      selector: '#target',
      keys: 'Ctrl+Shift+A, Enter',
      delay: 0,
    });

    expect(response).toMatchObject({
      success: true,
      results: [
        { keyCombination: 'Ctrl+Shift+A', success: true },
        { keyCombination: 'Enter', success: true },
      ],
      targetElement: { tagName: 'INPUT', id: 'target' },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'keydown', key: 'A', ctrlKey: true, shiftKey: true },
        { type: 'keyup', key: 'A', ctrlKey: true, shiftKey: true },
        { type: 'keydown', key: 'Enter', ctrlKey: false, shiftKey: false },
      ]),
    );
  });

  it('reports missing targets and malformed key combinations without dispatching', async () => {
    const listener = executeHelper();

    await expect(
      dispatch(listener, {
        action: 'simulateKeyboard',
        selector: '#missing',
        keys: 'Enter',
      }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('#missing') });

    await expect(
      dispatch(listener, {
        action: 'simulateKeyboard',
        keys: 'Ctrl+A+B',
      }),
    ).resolves.toMatchObject({
      success: false,
      results: [{ keyCombination: 'Ctrl+A+B', success: false }],
    });
  });
});
