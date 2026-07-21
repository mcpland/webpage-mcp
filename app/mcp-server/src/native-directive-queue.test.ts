import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NATIVE_DIRECTIVE_MAX_QUEUED_BYTES,
  NativeDirectiveQueue,
  NativeDirectiveQueueByteOverflowError,
  NativeDirectiveQueueClosedError,
  NativeDirectiveQueueEncodingError,
  NativeDirectiveQueueOverflowError,
} from './native-directive-queue';
import { CHROME_NATIVE_MESSAGE_MAX_INBOUND_BYTES } from './native-message-framing';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('NativeDirectiveQueue', () => {
  it('uses a bounded default well below the maximum native input frame', () => {
    expect(CHROME_NATIVE_MESSAGE_MAX_INBOUND_BYTES).toBe(64 * 1024 * 1024);
    expect(DEFAULT_NATIVE_DIRECTIVE_MAX_QUEUED_BYTES).toBe(32 * 1024 * 1024);
    expect(DEFAULT_NATIVE_DIRECTIVE_MAX_QUEUED_BYTES).toBeLessThan(CHROME_NATIVE_MESSAGE_MAX_INBOUND_BYTES);
  });

  it('runs directives serially in input order', async () => {
    const resolvers: Array<() => void> = [];
    const started: number[] = [];
    const queue = new NativeDirectiveQueue<number>(
      4,
      (value) => {
        started.push(value);
        return new Promise<void>((resolve) => resolvers.push(resolve));
      },
      vi.fn(),
    );

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    expect(started).toEqual([1]);
    expect(queue.pendingCount).toBe(3);
    expect(queue.pendingBytes).toBe(3);
    resolvers.shift()?.();
    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    resolvers.shift()?.();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    resolvers.shift()?.();
    await vi.waitFor(() => {
      expect(queue.pendingCount).toBe(0);
      expect(queue.pendingBytes).toBe(0);
    });
  });

  it('accepts one item exactly at the byte boundary using its actual Buffer length', async () => {
    const gate = deferred();
    const queue = new NativeDirectiveQueue<Buffer>(4, () => gate.promise, vi.fn(), 8);

    queue.enqueue(Buffer.alloc(8));

    expect(queue.pendingBytes).toBe(8);
    gate.resolve();
    await vi.waitFor(() => expect(queue.pendingBytes).toBe(0));
  });

  it('accounts non-Buffer items using their serialized UTF-8 byte length', async () => {
    const gate = deferred();
    const queue = new NativeDirectiveQueue<string>(4, () => gate.promise, vi.fn(), 4);

    // JSON.stringify('é') is four UTF-8 bytes: two quotes plus the two-byte character.
    queue.enqueue('é');

    expect(queue.pendingBytes).toBe(4);
    gate.resolve();
    await vi.waitFor(() => expect(queue.pendingBytes).toBe(0));
  });

  it('accepts an explicit retained byte length without serializing the item again', async () => {
    const gate = deferred();
    const queue = new NativeDirectiveQueue<unknown>(4, () => gate.promise, vi.fn(), 8);
    const circular: { self?: unknown } = {};
    circular.self = circular;

    queue.enqueue(circular, 7);

    expect(queue.pendingBytes).toBe(7);
    expect(() => queue.enqueue({}, 0)).toThrowError(RangeError);
    gate.resolve();
    await vi.waitFor(() => expect(queue.pendingBytes).toBe(0));
  });

  it('rejects multiple requests whose cumulative retained bytes exceed the budget', () => {
    const queue = new NativeDirectiveQueue<Buffer>(4, () => new Promise(() => {}), vi.fn(), 10);

    queue.enqueue(Buffer.alloc(4));
    queue.enqueue(Buffer.alloc(4));

    expect(() => queue.enqueue(Buffer.alloc(4))).toThrowError(NativeDirectiveQueueByteOverflowError);
    expect(queue.pendingCount).toBe(2);
    expect(queue.pendingBytes).toBe(8);
  });

  it('releases completed work so the byte capacity can be reused', async () => {
    const resolvers: Array<() => void> = [];
    const queue = new NativeDirectiveQueue<Buffer>(
      4,
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
      vi.fn(),
      10,
    );

    queue.enqueue(Buffer.alloc(6));
    queue.enqueue(Buffer.alloc(4));
    expect(queue.pendingBytes).toBe(10);

    resolvers.shift()?.();
    await vi.waitFor(() => expect(queue.pendingBytes).toBe(4));

    queue.enqueue(Buffer.alloc(6));
    expect(queue.pendingBytes).toBe(10);

    resolvers.shift()?.();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers.shift()?.();
    await vi.waitFor(() => expect(queue.pendingBytes).toBe(0));
  });

  it('rejects one oversized or unserializable item without changing accounting', () => {
    const queue = new NativeDirectiveQueue<unknown>(4, async () => {}, vi.fn(), 8);
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() => queue.enqueue(Buffer.alloc(9))).toThrowError(NativeDirectiveQueueByteOverflowError);
    expect(() => queue.enqueue(circular)).toThrowError(NativeDirectiveQueueEncodingError);
    expect(() => queue.enqueue(1n)).toThrowError(NativeDirectiveQueueEncodingError);
    expect(() => queue.enqueue(undefined)).toThrowError(NativeDirectiveQueueEncodingError);
    expect(queue.pendingCount).toBe(0);
    expect(queue.pendingBytes).toBe(0);
  });

  it('rejects input beyond its combined running and queued item limit', () => {
    const queue = new NativeDirectiveQueue<number>(2, () => new Promise(() => {}), vi.fn());

    queue.enqueue(1);
    queue.enqueue(2);

    expect(() => queue.enqueue(3)).toThrowError(NativeDirectiveQueueOverflowError);
    expect(queue.pendingCount).toBe(2);
  });

  it('reports handler failures, releases their bytes, and continues', async () => {
    const onHandlerError = vi.fn();
    const handled: Buffer[] = [];
    const queue = new NativeDirectiveQueue<Buffer>(
      3,
      (value) => {
        handled.push(value);
        if (value[0] === 1) throw new Error('failed');
        if (value[0] === 2) return Promise.reject(new Error('failed asynchronously'));
        return Promise.resolve();
      },
      onHandlerError,
      3,
    );

    queue.enqueue(Buffer.from([1]));
    queue.enqueue(Buffer.from([2]));
    queue.enqueue(Buffer.from([3]));

    await vi.waitFor(() => expect(handled).toHaveLength(3));
    await vi.waitFor(() => expect(queue.pendingBytes).toBe(0));
    expect(onHandlerError).toHaveBeenCalledWith(expect.objectContaining({ message: 'failed' }));
    expect(onHandlerError).toHaveBeenCalledWith(expect.objectContaining({ message: 'failed asynchronously' }));
  });

  it('drops queued bytes on close and releases the active item when it settles', async () => {
    const gate = deferred();
    const queue = new NativeDirectiveQueue<Buffer>(4, () => gate.promise, vi.fn(), 10);

    queue.enqueue(Buffer.alloc(4));
    queue.enqueue(Buffer.alloc(3));
    expect(queue.pendingBytes).toBe(7);

    queue.close();
    queue.close();

    expect(queue.pendingCount).toBe(1);
    expect(queue.pendingBytes).toBe(4);
    expect(() => queue.enqueue(Buffer.alloc(1))).toThrowError(NativeDirectiveQueueClosedError);

    gate.resolve();
    await vi.waitFor(() => {
      expect(queue.pendingCount).toBe(0);
      expect(queue.pendingBytes).toBe(0);
    });
  });

  it('never overlaps handlers while repeatedly draining concurrent enqueues', async () => {
    let activeHandlers = 0;
    let maximumActiveHandlers = 0;
    const handled: number[] = [];
    const queue = new NativeDirectiveQueue<Buffer>(
      64,
      async (value) => {
        activeHandlers += 1;
        maximumActiveHandlers = Math.max(maximumActiveHandlers, activeHandlers);
        await Promise.resolve();
        handled.push(value[0]);
        activeHandlers -= 1;
      },
      vi.fn(),
      64,
    );

    for (let index = 0; index < 64; index += 1) {
      queue.enqueue(Buffer.from([index]));
    }

    await vi.waitFor(() => expect(queue.pendingCount).toBe(0));
    expect(maximumActiveHandlers).toBe(1);
    expect(handled).toEqual(Array.from({ length: 64 }, (_, index) => index));
    expect(queue.pendingBytes).toBe(0);
  });
});
