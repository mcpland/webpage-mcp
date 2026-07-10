import { describe, expect, it, vi } from 'vitest';
import {
  NativeDirectiveQueue,
  NativeDirectiveQueueOverflowError,
} from './native-directive-queue';

describe('NativeDirectiveQueue', () => {
  it('runs directives serially in input order', async () => {
    const resolvers: Array<() => void> = [];
    const started: number[] = [];
    const queue = new NativeDirectiveQueue<number>(4, (value) => {
      started.push(value);
      return new Promise<void>((resolve) => resolvers.push(resolve));
    }, vi.fn());

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    expect(started).toEqual([1]);
    expect(queue.pendingCount).toBe(3);
    resolvers.shift()?.();
    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    resolvers.shift()?.();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    resolvers.shift()?.();
    await vi.waitFor(() => expect(queue.pendingCount).toBe(0));
  });

  it('rejects input beyond its combined running and queued limit', () => {
    const queue = new NativeDirectiveQueue<number>(2, () => new Promise(() => {}), vi.fn());

    queue.enqueue(1);
    queue.enqueue(2);

    expect(() => queue.enqueue(3)).toThrowError(NativeDirectiveQueueOverflowError);
    expect(queue.pendingCount).toBe(2);
  });

  it('reports handler failures and continues with the next directive', async () => {
    const onHandlerError = vi.fn();
    const handled: number[] = [];
    const queue = new NativeDirectiveQueue<number>(3, async (value) => {
      handled.push(value);
      if (value === 1) throw new Error('failed');
    }, onHandlerError);

    queue.enqueue(1);
    queue.enqueue(2);

    await vi.waitFor(() => expect(handled).toEqual([1, 2]));
    expect(onHandlerError).toHaveBeenCalledWith(expect.objectContaining({ message: 'failed' }));
  });
});
