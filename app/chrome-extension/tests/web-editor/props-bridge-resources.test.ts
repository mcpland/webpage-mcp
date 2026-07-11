import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type { ElementLocator } from '@/common/web-editor-types';
import {
  createPropsBridge,
  PROPS_BRIDGE_RESOURCE_LIMITS,
} from '@/entrypoints/web-editor/core/props-bridge';

const SURFACE_SESSION_ID = '42'.repeat(32);
const locator: ElementLocator = {
  selectors: ['#target'],
  fingerprint: 'div|id=target',
  path: [],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function requestFromCall(index = 0): any {
  return vi.mocked(chrome.runtime.sendMessage).mock.calls[index]![0];
}

function successfulExecution(message: any, stateDelta?: unknown): unknown {
  const targetGuard =
    (stateDelta as { componentGuard?: string } | undefined)?.componentGuard ??
    message.request.payload?.expectedTargetGuard ??
    message.request.payload?.originals?.[0]?.componentGuard ??
    (message.request.op === 'probe' ? undefined : 'Button');
  return {
    success: true,
    execution: {
      response: {
        v: 1,
        requestId: message.request.requestId,
        success: true,
        data: { hookStatus: 'READY' },
      },
      ...(targetGuard === undefined ? {} : { targetGuard }),
      ...(stateDelta === undefined ? {} : { stateDelta }),
    },
  };
}

function writeOriginal(
  message: any,
  encodedValue: unknown,
  componentGuard = 'Button',
) {
  return {
    kind: 'write_original',
    path: message.request.payload.propPath,
    existed: true,
    encodedValue,
    componentGuard,
  };
}

describe('props bridge background RPC boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(chrome.runtime.sendMessage).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses only the background RPC and binds every call to the surface session', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message) =>
      successfulExecution(message),
    );
    const eventSpy = vi.spyOn(window, 'dispatchEvent');
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });

    await expect(bridge.read(locator)).resolves.toMatchObject({ ok: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_EXECUTE,
        surfaceSessionId: SURFACE_SESSION_ID,
        request: expect.objectContaining({ op: 'read', locator }),
      }),
    );
    expect(eventSpy).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('caps live transports even after their UI timers expire', async () => {
    const calls = Array.from(
      { length: PROPS_BRIDGE_RESOURCE_LIMITS.maxPendingRequests },
      () => deferred<unknown>(),
    );
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      (_message, ..._args) => calls.shift()!.promise,
    );
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });
    const pending = Array.from(
      { length: PROPS_BRIDGE_RESOURCE_LIMITS.maxPendingRequests },
      () => bridge.probe(undefined, 200),
    );
    await vi.advanceTimersByTimeAsync(200);
    await expect(Promise.all(pending)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: false,
          error: expect.stringContaining('timeout'),
        }),
      ]),
    );
    await expect(bridge.probe()).resolves.toEqual({
      ok: false,
      error: 'Too many pending props requests',
    });
    bridge.dispose();
  });

  it('caps non-finite timeouts and rejects invalid inputs before messaging', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout');
    const bridge = createPropsBridge({
      defaultTimeoutMs: Infinity,
      surfaceSessionId: SURFACE_SESSION_ID,
    });
    const probe = bridge.probe(undefined, Infinity);
    await Promise.resolve();
    expect(timeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      PROPS_BRIDGE_RESOURCE_LIMITS.maxTimeoutMs,
    );

    const oversizedLocator: ElementLocator = {
      ...locator,
      selectors: Array.from(
        { length: PROPS_BRIDGE_RESOURCE_LIMITS.maxSelectors + 1 },
        (_, index) => `#target-${index}`,
      ),
    };
    await expect(bridge.read(oversizedLocator)).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      bridge.write(
        locator,
        ['x'.repeat(PROPS_BRIDGE_RESOURCE_LIMITS.maxPropSegmentBytes + 1)],
        1,
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      bridge.write(
        locator,
        ['value'],
        'x'.repeat(PROPS_BRIDGE_RESOURCE_LIMITS.maxValueBytes + 1),
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    bridge.dispose();
    await expect(probe).resolves.toMatchObject({
      ok: false,
      error: 'Invalid props response from background',
    });
  });

  it('rejects malformed or mismatched execution envelopes', async () => {
    vi.mocked(chrome.runtime.sendMessage)
      .mockResolvedValueOnce({
        success: true,
        execution: {
          response: { v: 1, requestId: 'wrong', success: true },
        },
      })
      .mockResolvedValueOnce({
        success: true,
        execution: { response: { v: 1 } },
      });
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });

    await expect(bridge.read(locator)).resolves.toEqual({
      ok: false,
      error: 'Invalid props response from MAIN world',
    });
    await expect(bridge.read(locator)).resolves.toEqual({
      ok: false,
      error: 'Invalid props response from MAIN world',
    });
    bridge.dispose();
  });

  it('absorbs a write original that arrives after the UI timeout', async () => {
    const lateWrite = deferred<unknown>();
    vi.mocked(chrome.runtime.sendMessage)
      .mockReturnValueOnce(lateWrite.promise)
      .mockImplementationOnce(async (message) =>
        successfulExecution(message, {
          kind: 'reset_result',
          appliedIndexes: [0],
          guardMismatch: false,
        }),
      );
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });
    const write = bridge.write(locator, ['count'], 2, 200);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    await expect(write).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('timeout'),
    });

    const writeMessage = requestFromCall(0);
    lateWrite.resolve({
      success: true,
      execution: {
        response: {
          v: 1,
          requestId: writeMessage.request.requestId,
          success: false,
          error: 'Props response exceeded the resource limit',
        },
        targetGuard: 'Button',
        stateDelta: writeOriginal(writeMessage, 1),
      },
    });
    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1),
    );
    await bridge.reset(locator);

    const resetMessage = requestFromCall(1);
    expect(resetMessage.request.payload.originals).toEqual([
      expect.objectContaining({
        path: ['count'],
        encodedValue: 1,
        componentGuard: 'Button',
      }),
    ]);
    bridge.dispose();
  });

  it('serializes concurrent writes so reset keeps the first pre-write value', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    vi.mocked(chrome.runtime.sendMessage)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockImplementationOnce(async (message) =>
        successfulExecution(message, {
          kind: 'reset_result',
          appliedIndexes: [0],
          guardMismatch: false,
        }),
      );
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });
    const firstWrite = bridge.write(locator, ['count'], 1, 200);
    const secondWrite = bridge.write(locator, ['count'], 2, 30_000);
    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    await expect(firstWrite).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('timeout'),
    });

    const firstMessage = requestFromCall(0);
    expect(firstMessage.request.payload.captureOriginal).toBe(true);
    first.resolve(
      successfulExecution(firstMessage, writeOriginal(firstMessage, 0)),
    );
    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2),
    );

    const secondMessage = requestFromCall(1);
    expect(secondMessage.request.payload).toMatchObject({
      captureOriginal: false,
      stateBudgetBytes: 0,
    });
    second.resolve(successfulExecution(secondMessage));
    await expect(secondWrite).resolves.toMatchObject({ ok: true });

    await bridge.reset(locator);
    expect(requestFromCall(2).request.payload.originals).toEqual([
      expect.objectContaining({ path: ['count'], encodedValue: 0 }),
    ]);
    bridge.dispose();
  });

  it('removes only reset entries reported as applied', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      async (message: any) => {
        if (message.request.op === 'write') {
          const original =
            message.request.payload.propPath[0] === 'one' ? 1 : 2;
          return successfulExecution(message, writeOriginal(message, original));
        }
        if (message.request.op === 'reset') {
          return successfulExecution(message, {
            kind: 'reset_result',
            appliedIndexes:
              message.request.payload.originals.length === 2 ? [0] : [0],
            guardMismatch: false,
          });
        }
        return successfulExecution(message);
      },
    );
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });
    await bridge.write(locator, ['one'], 10);
    await bridge.write(locator, ['two'], 20);
    await bridge.reset(locator);
    await bridge.reset(locator);

    const secondReset = requestFromCall(3);
    expect(secondReset.request.payload.originals).toHaveLength(1);
    expect(secondReset.request.payload.originals[0].path).toEqual(['two']);
    bridge.dispose();
  });

  it('cleans up originals locally without a MAIN-world request', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message) =>
      successfulExecution(message, writeOriginal(message, 'before')),
    );
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });
    await bridge.write(locator, ['label'], 'after');
    await bridge.cleanup();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(bridge.isDisposed()).toBe(true);
  });

  it('drains every accepted queued write before cleanup disposes the bridge', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    vi.mocked(chrome.runtime.sendMessage)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });
    const writeOne = bridge.write(locator, ['count'], 1);
    const writeTwo = bridge.write(locator, ['count'], 2);
    await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1));
    const cleanup = bridge.cleanup();
    let cleaned = false;
    void cleanup.then(() => {
      cleaned = true;
    });

    const firstMessage = requestFromCall(0);
    first.resolve(successfulExecution(firstMessage, writeOriginal(firstMessage, 0)));
    await expect(writeOne).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2));
    expect(cleaned).toBe(false);
    const secondMessage = requestFromCall(1);
    expect(secondMessage.request.payload).toMatchObject({
      captureOriginal: false,
      expectedTargetGuard: 'Button',
    });
    second.resolve(successfulExecution(secondMessage));
    await expect(writeTwo).resolves.toMatchObject({ ok: true });
    await cleanup;
    expect(cleaned).toBe(true);
    expect(bridge.isDisposed()).toBe(true);
  });

  it('deduplicates first originals across locator aliases', async () => {
    let writeNumber = 0;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: any) => {
      if (message.request.op === 'write') {
        const original = writeNumber++ === 0 ? 0 : 1;
        return successfulExecution(message, writeOriginal(message, original, 'shared-guard'));
      }
      if (message.request.op === 'reset') {
        return successfulExecution(message, {
          kind: 'reset_result',
          appliedIndexes: message.request.payload.originals.map((entry: any) => entry.index),
          guardMismatch: false,
        });
      }
      return successfulExecution(message);
    });
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });
    const alias = { ...locator, selectors: ['button'] };
    await bridge.write(locator, ['count'], 1);
    await bridge.write(alias, ['count'], 2);
    await bridge.reset(alias);

    const resetMessage = vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.map(([message]) => message as any)
      .find((message) => message.request.op === 'reset');
    expect(resetMessage.request.payload.originals).toEqual([
      expect.objectContaining({ encodedValue: 0, componentGuard: 'shared-guard' }),
    ]);
    bridge.dispose();
  });

  it('keeps captured locator aliases pinned across normal alias eviction', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: any) => {
      if (message.request.op === 'write') {
        return successfulExecution(message, writeOriginal(message, 0, 'pinned-guard'));
      }
      if (message.request.op === 'reset') {
        return successfulExecution(message, {
          kind: 'reset_result',
          appliedIndexes: [0],
          guardMismatch: false,
        });
      }
      return successfulExecution(message);
    });
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });
    await bridge.write(locator, ['count'], 1);
    for (let index = 0; index <= PROPS_BRIDGE_RESOURCE_LIMITS.maxTargetAliases; index += 1) {
      await bridge.read({ ...locator, selectors: [`[data-alias="${index}"]`] });
    }
    await bridge.reset(locator);
    const finalMessage = requestFromCall(
      vi.mocked(chrome.runtime.sendMessage).mock.calls.length - 1,
    );
    expect(finalMessage.request.op).toBe('reset');
    expect(finalMessage.request.payload.originals[0].encodedValue).toBe(0);
    bridge.dispose();
  });

  it('accepts 20 KiB originals and batches large reset requests under 64 KiB', async () => {
    const largeLocator: ElementLocator = {
      ...locator,
      selectors: ['#target'].concat(
        Array.from({ length: 9 }, (_, index) => `#x${index}${'a'.repeat(4_000)}`),
      ),
    };
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: any) => {
      if (message.request.op === 'write') {
        const value =
          message.request.payload.propPath[0] === 'large'
            ? 'x'.repeat(20 * 1024)
            : 'y'.repeat(600);
        return successfulExecution(message, writeOriginal(message, value, 'batch-guard'));
      }
      if (message.request.op === 'reset') {
        expect(JSON.stringify(message.request).length).toBeLessThanOrEqual(
          PROPS_BRIDGE_RESOURCE_LIMITS.maxRequestBytes,
        );
        return successfulExecution(message, {
          kind: 'reset_result',
          appliedIndexes: message.request.payload.originals.map((entry: any) => entry.index),
          guardMismatch: false,
        });
      }
      return successfulExecution(message);
    });
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });
    await bridge.write(largeLocator, ['large'], 'changed');
    for (let index = 0; index < 25; index += 1) {
      await bridge.write(largeLocator, [`path-${index}`], index);
    }
    await expect(bridge.reset(largeLocator)).resolves.toMatchObject({ ok: true });

    const resetCalls = vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.map(([message]) => message as any)
      .filter((message) => message.request.op === 'reset');
    expect(resetCalls.length).toBeGreaterThan(1);
    expect(resetCalls.flatMap((message) => message.request.payload.originals)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['large'], encodedValue: 'x'.repeat(20 * 1024) }),
      ]),
    );
    bridge.dispose();
  });

  it('finishes every reset batch accepted before cleanup closes the session', async () => {
    const largeLocator: ElementLocator = {
      ...locator,
      selectors: ['#target'].concat(
        Array.from({ length: 9 }, (_, index) => `#x${index}${'a'.repeat(4_000)}`),
      ),
    };
    const firstReset = deferred<unknown>();
    const secondReset = deferred<unknown>();
    const resetMessages: any[] = [];
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((message: any) => {
      if (message.request.op === 'write') {
        const value =
          message.request.payload.propPath[0] === 'large'
            ? 'x'.repeat(20 * 1024)
            : 'y'.repeat(600);
        return Promise.resolve(
          successfulExecution(message, writeOriginal(message, value, 'batch-guard')),
        );
      }
      if (message.request.op === 'reset') {
        resetMessages.push(message);
        if (resetMessages.length === 1) return firstReset.promise;
        if (resetMessages.length === 2) return secondReset.promise;
        return Promise.resolve(
          successfulExecution(message, {
            kind: 'reset_result',
            appliedIndexes: message.request.payload.originals.map(
              (entry: any) => entry.index,
            ),
            guardMismatch: false,
          }),
        );
      }
      return Promise.resolve(successfulExecution(message));
    });
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });
    await bridge.write(largeLocator, ['large'], 'changed');
    for (let index = 0; index < 25; index += 1) {
      await bridge.write(largeLocator, [`path-${index}`], index);
    }

    const resetting = bridge.reset(largeLocator, 30_000);
    await vi.waitFor(() => expect(resetMessages).toHaveLength(1));
    const cleanup = bridge.cleanup();
    let cleaned = false;
    void cleanup.then(() => {
      cleaned = true;
    });
    firstReset.resolve(
      successfulExecution(resetMessages[0], {
        kind: 'reset_result',
        appliedIndexes: resetMessages[0].request.payload.originals.map(
          (entry: any) => entry.index,
        ),
        guardMismatch: false,
      }),
    );

    await vi.waitFor(() => expect(resetMessages).toHaveLength(2));
    expect(cleaned).toBe(false);
    expect(resetMessages[0].surfaceSessionId).toBe(SURFACE_SESSION_ID);
    expect(resetMessages[1].surfaceSessionId).toBe(SURFACE_SESSION_ID);
    secondReset.resolve(
      successfulExecution(resetMessages[1], {
        kind: 'reset_result',
        appliedIndexes: resetMessages[1].request.payload.originals.map(
          (entry: any) => entry.index,
        ),
        guardMismatch: false,
      }),
    );

    await expect(resetting).resolves.toMatchObject({ ok: true });
    await cleanup;
    expect(cleaned).toBe(true);
    expect(bridge.isDisposed()).toBe(true);
  });

  it('rejects non-empty frame chains before messaging', async () => {
    const bridge = createPropsBridge({ surfaceSessionId: SURFACE_SESSION_ID });
    await expect(bridge.write({ ...locator, frameChain: ['iframe'] }, ['value'], 1)).resolves.toMatchObject({
      ok: false,
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    bridge.dispose();
  });
});
