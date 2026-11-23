import { describe, expect, it } from 'vitest';
import { runInTabQueue, runInTabRequestQueue } from '@/entrypoints/background/tab-queue';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runInTabQueue', () => {
  it('serializes tasks on the same tab', async () => {
    const order: string[] = [];
    const first = deferred();
    const a = runInTabQueue(1, async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = runInTabQueue(1, async () => {
      order.push('b');
    });
    await tick();
    expect(order).toEqual(['a:start']);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('releases the queue when a running task is aborted even if it never settles', async () => {
    const controller = new AbortController();
    const stuck = runInTabQueue(2, () => new Promise<never>(() => {}), {
      signal: controller.signal,
    });
    let ran = false;
    const next = runInTabQueue(2, async () => {
      ran = true;
      return 'next';
    });
    await tick();
    expect(ran).toBe(false);

    controller.abort();
    await expect(next).resolves.toBe('next');
    expect(ran).toBe(true);
    void stuck;
  });

  it('never runs a task that was cancelled while waiting', async () => {
    const blocker = deferred();
    const running = runInTabQueue(3, () => blocker.promise);
    const controller = new AbortController();
    let ran = false;
    const waiting = runInTabQueue(
      3,
      async () => {
        ran = true;
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

    blocker.resolve();
    await running;
    await tick();
    expect(ran).toBe(false);
  });

  it('does not let a newcomer overtake a running task when a waiter aborts', async () => {
    const blocker = deferred();
    const order: string[] = [];
    const running = runInTabQueue(4, async () => {
      await blocker.promise;
      order.push('running');
    });
    const controller = new AbortController();
    const waiter = runInTabQueue(4, async () => order.push('waiter'), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });

    const newcomer = runInTabQueue(4, async () => {
      order.push('newcomer');
    });
    await tick();
    expect(order).toEqual([]);
    blocker.resolve();
    await Promise.all([running, newcomer]);
    expect(order).toEqual(['running', 'newcomer']);
  });

  it('retains an admitted workflow lease while its deadline cancellation settles', async () => {
    const finish = deferred();
    const deadline = new AbortController();
    const order: string[] = [];
    const running = runInTabRequestQueue(7, async () => {
      order.push('admitted');
      await finish.promise;
    }, { waitSignal: deadline.signal });
    await tick();
    deadline.abort();
    const next = runInTabRequestQueue(7, async () => order.push('next'));
    await tick();
    expect(order).toEqual(['admitted']);
    finish.resolve();
    await Promise.all([running, next]);
    expect(order).toEqual(['admitted', 'next']);
  });

  it('keeps different tabs independent', async () => {
    const blocker = deferred();
    void runInTabQueue(5, () => blocker.promise);
    await expect(runInTabQueue(6, async () => 'other tab')).resolves.toBe('other tab');
    blocker.resolve();
  });
});
