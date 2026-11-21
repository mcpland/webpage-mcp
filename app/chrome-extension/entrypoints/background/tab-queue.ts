/**
 * Per-tab serialization of tool executions.
 *
 * Each entry holds the queue until its task settles or until its caller's
 * signal aborts. Releasing on abort matters because some browser operations
 * never settle on their own (for example a CDP click whose handler opened a
 * modal JavaScript dialog): a cancelled call must not leave every later call
 * on that tab waiting forever. A call cancelled while still waiting never runs.
 */

const tabQueueTails = new Map<number, Promise<void>>();

function createAbortError(): Error {
  const error = new Error('Tool execution cancelled');
  error.name = 'AbortError';
  return error;
}

function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

export async function runInTabQueue<T>(
  tabId: number,
  task: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const { signal } = options;
  const previous = tabQueueTails.get(tabId) ?? Promise.resolve();

  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const onAbort = (): void => release();
  if (signal) {
    if (signal.aborted) release();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // Later entries wait for every earlier entry, so an entry released early by
  // its own abort still never lets a newcomer overtake a task that is running.
  const tail = previous.then(() => released);
  tabQueueTails.set(tabId, tail);
  void tail.then(() => {
    if (tabQueueTails.get(tabId) === tail) tabQueueTails.delete(tabId);
  });

  try {
    await waitForTurn(previous, signal);
    return await task();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    release();
  }
}

export function clearTabQueue(tabId: number): void {
  if (!Number.isFinite(tabId)) {
    return;
  }
  tabQueueTails.delete(tabId);
}
