import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
  onEvent: [] as Array<(source: any, method: string, params?: any) => void>,
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: mocks.attach,
    detach: mocks.detach,
    sendCommand: mocks.sendCommand,
  },
}));

import {
  CdpUnavailableError,
  PageUnresponsiveError,
  runCdpInputWithDialogs,
  withBackgroundClickFocus,
} from '@/utils/cdp-input';
import { dialogTracker, parseDialogResponse } from '@/utils/dialog-tracker';

function emit(method: string, params: Record<string, unknown> = {}) {
  for (const listener of mocks.onEvent) listener({ tabId: 7 }, method, params);
}

describe('runCdpInputWithDialogs', () => {
  beforeEach(() => {
    mocks.attach.mockReset().mockResolvedValue(undefined);
    mocks.detach.mockReset().mockResolvedValue(undefined);
    mocks.sendCommand.mockReset().mockResolvedValue({});
    (globalThis.chrome as any).debugger.onEvent.addListener = vi.fn((listener) =>
      mocks.onEvent.push(listener),
    );
    dialogTracker.ensureListening();
    dialogTracker.forget(7);
  });

  afterEach(() => {
    dialogTracker.forget(7);
    vi.useRealTimers();
  });

  it('enables the Page domain, dispatches input, and releases its lease', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);

    const result = await runCdpInputWithDialogs(7, 'click', dispatch, { graceMs: 0 });

    expect(result).toEqual({});
    expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'Page.enable', undefined, expect.any(AbortSignal));
    expect(dispatch).toHaveBeenCalledOnce();
    expect(mocks.attach).toHaveBeenCalledWith(7, 'click');
    expect(mocks.detach).toHaveBeenCalledWith(7, 'click');
  });

  it('restores background focus after failed input before a second click can start', async () => {
    const events: string[] = [];
    mocks.sendCommand.mockImplementation(async (_tabId, method, params) => {
      expect(method).toBe('Emulation.setFocusEmulationEnabled');
      events.push(params.enabled ? 'enable' : 'restore');
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const first = withBackgroundClickFocus(7, async () => {
      events.push('first');
      await barrier;
      throw new Error('input cancelled');
    });
    const second = withBackgroundClickFocus(7, async () => { events.push('second'); });
    await vi.waitFor(() => expect(events).toEqual(['enable', 'first']));
    release();
    await expect(first).rejects.toThrow('input cancelled');
    await second;
    expect(events).toEqual(['enable', 'first', 'restore', 'enable', 'second', 'restore']);
    expect(mocks.detach).toHaveBeenCalledTimes(2);
  });

  it('returns as soon as the input opens a dialog instead of waiting on the blocked page', async () => {
    const dispatch = vi.fn(() => {
      emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete item?' });
      return new Promise<void>(() => {}); // mouseReleased never acks while the dialog is open
    });

    const result = await runCdpInputWithDialogs(7, 'click', dispatch);

    expect(result.dialog).toEqual({ type: 'confirm', message: 'Delete item?', handled: false });
    expect(dialogTracker.get(7)).toMatchObject({ type: 'confirm' });
    // The tracker keeps the observing session attached until the dialog closes.
    expect(mocks.attach).toHaveBeenCalledWith(7, 'dialog-pending');
  });

  it('answers the dialog in the same call when asked to', async () => {
    let releaseInput!: () => void;
    const dispatch = vi.fn(() => {
      emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?' });
      return new Promise<void>((resolve) => {
        releaseInput = resolve;
      });
    });
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Page.handleJavaScriptDialog') {
        emit('Page.javascriptDialogClosed', { result: true });
        releaseInput();
      }
      return {};
    });

    const result = await runCdpInputWithDialogs(7, 'click', dispatch, {
      dialog: { action: 'accept', promptText: 'Ada' },
    });

    expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'Page.handleJavaScriptDialog', {
      accept: true,
      promptText: 'Ada',
    }, expect.any(AbortSignal));
    expect(result.dialog).toEqual({ type: 'prompt', message: 'Name?', handled: 'accept' });
    expect(dialogTracker.get(7)).toBeUndefined();
  });

  it('reports an unresponsive page when Page.enable is blocked by an existing dialog', async () => {
    vi.useFakeTimers();
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) =>
      method === 'Page.enable' ? new Promise(() => {}) : {},
    );
    const dispatch = vi.fn();

    const run = runCdpInputWithDialogs(7, 'click', dispatch);
    const assertion = expect(run).rejects.toBeInstanceOf(PageUnresponsiveError);
    await vi.advanceTimersByTimeAsync(2500);
    await assertion;
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.detach).toHaveBeenCalledWith(7, 'click');
  });

  it('fails fast with PageUnresponsiveError when a dialog is already tracked on the tab', async () => {
    emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Still open' });
    const dispatch = vi.fn();

    await expect(runCdpInputWithDialogs(7, 'click', dispatch)).rejects.toBeInstanceOf(
      PageUnresponsiveError,
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });

  it('throws CdpUnavailableError when pre-dispatch attach or Page.enable fails', async () => {
    mocks.attach.mockRejectedValueOnce(new Error('Debugger busy'));
    await expect(
      runCdpInputWithDialogs(7, 'click', vi.fn()),
    ).rejects.toBeInstanceOf(CdpUnavailableError);

    mocks.sendCommand.mockRejectedValueOnce(new Error('Target closed'));
    await expect(
      runCdpInputWithDialogs(7, 'click', vi.fn()),
    ).rejects.toBeInstanceOf(CdpUnavailableError);
  });

  it('aborts the dispatch signal when a dialog opens mid-sequence', async () => {
    let signalAborted = false;
    const dispatch = vi.fn(async (signal: AbortSignal) => {
      emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Mid-way?' });
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          signalAborted = true;
          resolve();
        });
      });
    });

    const result = await runCdpInputWithDialogs(7, 'click', dispatch);

    expect(result.dialog).toEqual({ type: 'confirm', message: 'Mid-way?', handled: false });
    expect(signalAborted).toBe(true);
  });

  it('surfaces a remaining open dialog after MAX_CHAINED_DIALOGS auto-responses', async () => {
    let count = 0;
    const openNext = () => {
      count += 1;
      emit('Page.javascriptDialogOpening', { type: 'alert', message: `dialog ${count}` });
    };
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Page.handleJavaScriptDialog') {
        emit('Page.javascriptDialogClosed', { result: true });
        if (count < 4) openNext();
      }
      return {};
    });

    const result = await runCdpInputWithDialogs(
      7,
      'click',
      async () => {
        openNext();
      },
      { dialog: { action: 'accept' } },
    );

    expect(result.dialog).toEqual({ type: 'alert', message: 'dialog 4', handled: false });
    expect(result.dialogs).toHaveLength(4);
    expect(result.dialogs?.map((d) => `${d.message}:${d.handled}`)).toEqual([
      'dialog 1:accept',
      'dialog 2:accept',
      'dialog 3:accept',
      'dialog 4:false',
    ]);
  });
});

describe('parseDialogResponse', () => {
  it('accepts shorthand and object forms', () => {
    expect(parseDialogResponse(undefined)).toBeUndefined();
    expect(parseDialogResponse('accept')).toEqual({ action: 'accept' });
    expect(parseDialogResponse({ action: 'dismiss' })).toEqual({ action: 'dismiss' });
    expect(parseDialogResponse({ action: 'accept', promptText: 'x' })).toEqual({
      action: 'accept',
      promptText: 'x',
    });
  });

  it('rejects malformed values', () => {
    expect(parseDialogResponse('yes')).toBeInstanceOf(Error);
    expect(parseDialogResponse({ action: 'ok' })).toBeInstanceOf(Error);
    expect(parseDialogResponse({ action: 'accept', promptText: 3 })).toBeInstanceOf(Error);
  });
});
