import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseKeyboardInput } from '@/utils/cdp-keyboard';
import { computerTool } from '@/entrypoints/background/tools/browser/computer';
import { keyboardTool } from '@/entrypoints/background/tools/browser/keyboard';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

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

function sendKeys(listener: RuntimeListener, keys: string) {
  return dispatch(listener, { action: 'simulateKeyboard', keys, steps: parseKeyboardInput(keys) });
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

  it('activates non-text controls without editing them or submitting their form', async () => {
    document.body.innerHTML = '<form><input type="checkbox"><input type="button"></form>';
    const [box, button] = document.querySelectorAll('input');
    const submit = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')!.addEventListener('submit', submit);
    const click = vi.fn();
    button.addEventListener('click', click);
    const listener = executeHelper();
    box.focus();
    expect((await sendKeys(listener, 'Space')).success).toBe(true);
    expect(box.checked).toBe(true);
    button.focus();
    expect((await sendKeys(listener, 'Enter')).success).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it('obeys the first submit button and preserves its click and submitter', async () => {
    document.body.innerHTML = '<button form="f" disabled>Save</button><form id="f"><input><button>Other</button></form>';
    const button = document.querySelector('button')!;
    const form = document.querySelector('form')!;
    const submitters: Array<HTMLElement | null> = [];
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitters.push(event.submitter);
    });
    document.querySelector('input')!.focus();
    const listener = executeHelper();
    await sendKeys(listener, 'Enter');
    expect(submitters).toEqual([]);
    button.disabled = false;
    button.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await sendKeys(listener, 'Enter');
    expect(submitters).toEqual([]);
    await sendKeys(listener, 'Enter');
    expect(submitters).toEqual([button]);

    document.querySelectorAll('button').forEach((item) => item.remove());
    form.append(document.createElement('input'));
    await sendKeys(listener, 'Enter');
    expect(submitters).toEqual([button]);
    form.lastElementChild!.remove();
    await sendKeys(listener, 'Enter');
    expect(submitters).toEqual([button, null]);
  });

  it('moves focus in tab order and sends later keys to the new focus', async () => {
    document.body.innerHTML = '<input id="a" tabindex="1"><input disabled><input hidden><input id="b" tabindex="2">';
    const a = document.querySelector<HTMLElement>('#a')!;
    const b = document.querySelector<HTMLElement>('#b')!;
    const atB = vi.fn();
    b.addEventListener('keydown', atB);
    a.focus();
    const listener = executeHelper();
    expect((await sendKeys(listener, 'Tab,Escape')).success).toBe(true);
    expect(document.activeElement).toBe(b);
    expect(atB.mock.calls[0][0].key).toBe('Escape');
    expect((await sendKeys(listener, 'Shift+Tab')).success).toBe(true);
    expect(document.activeElement).toBe(a);
    const atA = vi.fn();
    a.addEventListener('keydown', atA);
    expect((await sendKeys(listener, 'Shift+Tab,Escape')).success).toBe(false);
    expect(atA).toHaveBeenCalledTimes(1);
  });

  it('moves the browser caret before deleting and supports extending the selection', async () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    const operations: string[] = [];
    const selection = document.getSelection()!;
    Object.defineProperty(selection, 'modify', { configurable: true, value: (...args: string[]) => operations.push(args.join(' ')) });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: (command: string) => { operations.push(command); return true; } });
    try {
      const result = await sendKeys(executeHelper(), 'ArrowLeft Backspace Shift+ArrowRight');
      expect(result.success).toBe(true);
      expect(operations).toEqual(['move left character', 'delete', 'extend right character']);
    } finally {
      Reflect.deleteProperty(selection, 'modify');
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

  it('honors beforeinput cancellation for whole literals, deletion and single keystrokes', async () => {
    document.body.innerHTML = '<input value="original">';
    const field = document.querySelector('input')!;
    field.focus();
    const edits: unknown[] = [];
    field.addEventListener('beforeinput', (event) => {
      const input = event as InputEvent;
      edits.push([input.inputType, input.data]);
      event.preventDefault();
    });
    const listener = executeHelper();
    for (const keys of ['35', 'Backspace', 'a']) expect((await sendKeys(listener, keys)).success).toBe(true);
    expect(edits).toEqual([['insertText', '35'], ['deleteContentBackward', null], ['insertText', 'a']]);
    expect(field.value).toBe('original');
    field.blur();
    expect((await sendKeys(listener, 'hello')).success).toBe(false);
  });

  it('abandons the edit if a beforeinput listener returns after the deadline', async () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    field.addEventListener('beforeinput', () => now.mockReturnValue(200));
    const result = await dispatch(executeHelper(), {
      action: 'simulateKeyboard', keys: 'ab', steps: parseKeyboardInput('ab'), deadline: 150,
    });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('expired') });
    expect(field.value).toBe('');
  });

  it('returns the failing stroke detail when a clear-only fallback has no label', async () => {
    const field = document.createElement('input');
    field.readOnly = true;
    document.body.append(field);
    field.focus();
    const result = await dispatch(executeHelper(), {
      action: 'simulateKeyboard', keys: '', steps: parseKeyboardInput('Backspace'),
    });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not editable') });
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

  it.each([
    ['type', 'Enter'],
    ['keyboard', 'Hello, 世界'],
  ])('edits the focused field through the %s fallback', async (tool, text) => {
    const input = document.createElement('input');
    input.value = 'old';
    document.body.append(input);
    input.focus();
    input.setSelectionRange(3, 3);
    const keydown: string[] = [];
    input.addEventListener('keydown', (event) => keydown.push(event.key));
    // jsdom has no editing commands. Model the native selection and edits they perform.
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (command: string, _ui: boolean, value: string) => {
        if (command === 'selectAll') input.select();
        else if (command === 'delete' || command === 'insertText') {
          input.setRangeText(value || '', input.selectionStart!, input.selectionEnd!, 'end');
        } else return false;
        return true;
      },
    });
    const listener = executeHelper();
    try {
      const tab = { id: 7, url: 'https://example.test/', active: true };
      vi.spyOn(cdpSessionManager, 'attach').mockRejectedValue(new Error('Debugger busy'));
      vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(tab);
      vi.spyOn(keyboardTool as any, 'tryGetTab').mockResolvedValue(tab);
      vi.spyOn(keyboardTool as any, 'injectContentScript').mockResolvedValue(undefined);
      vi.spyOn(keyboardTool as any, 'sendMessageToTab').mockImplementation(
        async (_tabId, request) => dispatch(listener, request as Record<string, unknown>),
      );
      const result = tool === 'type'
        ? await computerTool.execute({ action: 'type', text, clear: true, tabId: 7, background: true })
        : await keyboardTool.execute({ keys: text, tabId: 7, background: true });
      expect(result.isError).toBe(false);
      expect(input.value).toBe(tool === 'type' ? text : 'old' + text);
      expect(keydown).toEqual(tool === 'type' ? ['a', 'Backspace'] : []);
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
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
