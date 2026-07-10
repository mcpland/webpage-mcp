import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConsoleBuffer,
  type ConsoleBufferOptions,
} from '@/entrypoints/background/tools/browser/console-buffer';
import {
  CONSOLE_ARGS_MAX_UTF8_BYTES,
  CONSOLE_DESCRIPTION_MAX_UTF8_BYTES,
  CONSOLE_STACK_MAX_UTF8_BYTES,
  CONSOLE_TEXT_MAX_UTF8_BYTES,
  CONSOLE_VALUE_MAX_UTF8_BYTES,
  measureConsoleJsonBytes,
  measureConsoleUtf8Bytes,
} from '@/entrypoints/background/tools/browser/console-limits';

type Listener = (...args: never[]) => void;

function createEvent<T extends Listener>() {
  const listeners = new Set<T>();
  return {
    api: {
      addListener: vi.fn((listener: T) => listeners.add(listener)),
      removeListener: vi.fn((listener: T) => listeners.delete(listener)),
    },
    emit: (...args: Parameters<T>) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function makeHarness(limits: Partial<ConsoleBufferOptions> = {}) {
  const debuggerEvent =
    createEvent<
      (
        source: chrome.debugger.Debuggee,
        method: string,
        params?: unknown,
      ) => void
    >();
  const debuggerDetach =
    createEvent<(source: chrome.debugger.Debuggee, reason: string) => void>();
  const tabRemoved = createEvent<(tabId: number) => void>();
  const tabUpdated =
    createEvent<
      (
        tabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
        tab: chrome.tabs.Tab,
      ) => void
    >();
  const tabsGet = vi.fn(async (tabId: number) => ({
    id: tabId,
    index: 0,
    windowId: 1,
    url: `https://example${tabId}.com/`,
    title: `Tab ${tabId}`,
  }));
  const sessionManager = {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async () => ({})),
  };
  const chromeApi = {
    debugger: {
      onEvent: debuggerEvent.api,
      onDetach: debuggerDetach.api,
    },
    tabs: {
      get: tabsGet,
      onRemoved: tabRemoved.api,
      onUpdated: tabUpdated.api,
    },
  } as unknown as typeof chrome;
  const buffer = new ConsoleBuffer({
    ...limits,
    chromeApi,
    sessionManager,
  });
  return {
    buffer,
    debuggerEvent,
    debuggerDetach,
    tabRemoved,
    sessionManager,
  };
}

const buffers: ConsoleBuffer[] = [];

afterEach(async () => {
  await Promise.all(buffers.splice(0).map((buffer) => buffer.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ConsoleBuffer resource bounds', () => {
  it('bounds hostile fields before retaining them in a byte ring', async () => {
    const maxMessageBytes = 256 * 1024;
    const maxExceptionBytes = 96 * 1024;
    const harness = makeHarness({
      maxMessages: 20,
      maxExceptions: 20,
      maxMessageBytes,
      maxExceptionBytes,
    });
    buffers.push(harness.buffer);
    await harness.buffer.ensureStarted(7);

    const huge = '🚀'.repeat(100_000);
    for (let index = 0; index < 40; index += 1) {
      harness.debuggerEvent.emit({ tabId: 7 }, 'Runtime.consoleAPICalled', {
        timestamp: index,
        type: 'log',
        args: Array.from({ length: 100 }, () => ({
          type: 'object',
          value: huge,
          description: huge,
          objectId: huge,
        })),
        stackTrace: {
          callFrames: Array.from({ length: 100 }, () => ({
            functionName: huge,
            url: huge,
          })),
        },
      });
      harness.debuggerEvent.emit({ tabId: 7 }, 'Runtime.exceptionThrown', {
        exceptionDetails: {
          timestamp: index,
          text: huge,
          exception: { description: huge },
          stackTrace: { callFrames: [{ functionName: huge, url: huge }] },
        },
      });
    }

    const result = harness.buffer.read(7);
    expect(result).not.toBeNull();
    expect(result!.droppedMessageCount).toBeGreaterThan(0);
    expect(result!.droppedExceptionCount).toBeGreaterThan(0);
    expect(
      result!.messages.reduce(
        (total, message) => total + measureConsoleJsonBytes(message),
        0,
      ),
    ).toBeLessThanOrEqual(maxMessageBytes);
    expect(
      result!.exceptions.reduce(
        (total, exception) => total + measureConsoleJsonBytes(exception),
        0,
      ),
    ).toBeLessThanOrEqual(maxExceptionBytes);

    const message = result!.messages.at(-1)!;
    const firstArg = message.args?.[0] as Record<string, unknown>;
    expect(measureConsoleUtf8Bytes(message.text)).toBeLessThanOrEqual(
      CONSOLE_TEXT_MAX_UTF8_BYTES,
    );
    expect(measureConsoleJsonBytes(message.text)).toBeLessThanOrEqual(
      CONSOLE_TEXT_MAX_UTF8_BYTES,
    );
    expect(measureConsoleJsonBytes(message.args)).toBeLessThanOrEqual(
      CONSOLE_ARGS_MAX_UTF8_BYTES,
    );
    expect(
      measureConsoleUtf8Bytes(String(firstArg.description)),
    ).toBeLessThanOrEqual(CONSOLE_DESCRIPTION_MAX_UTF8_BYTES);
    expect(measureConsoleJsonBytes(firstArg.description)).toBeLessThanOrEqual(
      CONSOLE_DESCRIPTION_MAX_UTF8_BYTES,
    );
    expect(measureConsoleUtf8Bytes(String(firstArg.value))).toBeLessThanOrEqual(
      CONSOLE_VALUE_MAX_UTF8_BYTES,
    );
    expect(measureConsoleJsonBytes(firstArg.value)).toBeLessThanOrEqual(
      CONSOLE_VALUE_MAX_UTF8_BYTES,
    );
    expect(measureConsoleJsonBytes(message.stackTrace)).toBeLessThanOrEqual(
      CONSOLE_STACK_MAX_UTF8_BYTES,
    );
    expect(firstArg).not.toHaveProperty('objectId');
  });
});

describe('ConsoleBuffer lifecycle', () => {
  it('keeps clear distinct from stop and enforces the global tab cap', async () => {
    const harness = makeHarness({ maxCapturedTabs: 2 });
    buffers.push(harness.buffer);
    await harness.buffer.ensureStarted(1);
    await harness.buffer.ensureStarted(2);

    await expect(harness.buffer.ensureStarted(3)).rejects.toThrow(
      'Console buffer capture limit reached (2 tabs)',
    );
    expect(harness.buffer.clear(1)).not.toBeNull();
    expect(harness.buffer.isCapturing(1)).toBe(true);
    expect(harness.sessionManager.detach).not.toHaveBeenCalled();
    harness.debuggerEvent.emit(
      { tabId: 1 },
      'Log.entryAdded',
      { entry: { timestamp: 1, level: 'log', text: 'after-clear' } },
    );
    expect(harness.buffer.read(1)?.messages).toEqual([
      expect.objectContaining({ text: 'after-clear' }),
    ]);

    await expect(harness.buffer.stop(1)).resolves.toBe(true);
    expect(harness.buffer.isCapturing(1)).toBe(false);
    expect(harness.sessionManager.detach).toHaveBeenCalledWith(
      1,
      'console-buffer',
    );
    await expect(harness.buffer.ensureStarted(3)).resolves.toBeUndefined();
  });

  it('expires idle captures and refreshes the TTL only on tool access', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ idleTtlMs: 1_000 });
    buffers.push(harness.buffer);
    await harness.buffer.ensureStarted(7);

    await vi.advanceTimersByTimeAsync(900);
    harness.debuggerEvent.emit({ tabId: 7 }, 'Log.entryAdded', {
      entry: {
        timestamp: 1,
        level: 'log',
        text: 'event traffic is not access',
      },
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.buffer.isCapturing(7)).toBe(false);
    expect(harness.sessionManager.detach).toHaveBeenCalledWith(
      7,
      'console-buffer',
    );

    await harness.buffer.ensureStarted(7);
    await vi.advanceTimersByTimeAsync(900);
    expect(harness.buffer.read(7)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(900);
    expect(harness.buffer.isCapturing(7)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.buffer.isCapturing(7)).toBe(false);
  });

  it('releases state and debugger ownership on tab close and external detach', async () => {
    const harness = makeHarness({ maxCapturedTabs: 2 });
    buffers.push(harness.buffer);
    await harness.buffer.ensureStarted(1);
    await harness.buffer.ensureStarted(2);

    harness.tabRemoved.emit(1);
    await vi.waitFor(() => expect(harness.buffer.isCapturing(1)).toBe(false));
    await vi.waitFor(() =>
      expect(harness.sessionManager.detach).toHaveBeenCalledWith(
        1,
        'console-buffer',
      ),
    );

    harness.debuggerDetach.emit({ tabId: 2 }, 'target_closed');
    expect(harness.buffer.isCapturing(2)).toBe(false);
    await vi.waitFor(() =>
      expect(harness.sessionManager.detach).toHaveBeenCalledWith(
        2,
        'console-buffer',
      ),
    );
    await expect(harness.buffer.ensureStarted(3)).resolves.toBeUndefined();
  });
});
