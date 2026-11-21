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
  PageUnresponsiveError,
  runCdpInputWithDialogs,
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
    expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'Page.enable');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(mocks.attach).toHaveBeenCalledWith(7, 'click');
    expect(mocks.detach).toHaveBeenCalledWith(7, 'click');
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
    });
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
