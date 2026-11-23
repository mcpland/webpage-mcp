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
const requestQueueTails = new Map<number, Promise<void>>();
const nativeMouseTails = new Map<number, Promise<void>>();
const nativeKeyTails = new Map<number, Promise<void>>();

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

async function runInQueue<T>(
  tails: Map<number, Promise<void>>,
  tabId: number,
  task: () => Promise<T>,
  options: { signal?: AbortSignal; waitSignal?: AbortSignal } = {},
): Promise<T> {
  const { signal } = options;
  const previous = tails.get(tabId) ?? Promise.resolve();

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
  tails.set(tabId, tail);
  void tail.then(() => {
    if (tails.get(tabId) === tail) tails.delete(tabId);
  });

  try {
    await waitForTurn(previous, options.waitSignal ?? signal);
    return await task();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    release();
  }
}

export function runInTabQueue<T>(tabId: number, task: () => Promise<T>, options?: { signal?: AbortSignal }) {
  return runInQueue(tabQueueTails, tabId, task, options);
}

/** A public workflow owns the request queue while its steps use the operation queue. */
export function runInTabRequestQueue<T>(tabId: number, task: () => Promise<T>, options?: { signal?: AbortSignal; waitSignal?: AbortSignal }) {
  return runInQueue(requestQueueTails, tabId, task, options);
}

/** A later press must not overtake the previous press's compensating release. */
export function runInNativeMouseQueue<T>(tabId: number, task: () => Promise<T>, signal: AbortSignal) {
  return runInQueue(nativeMouseTails, tabId, task, { waitSignal: signal });
}

/** Keep subsequent keystrokes behind any outstanding modifier releases. */
export function runInNativeKeyQueue<T>(tabId: number, task: () => Promise<T>, signal?: AbortSignal) {
  return runInQueue(nativeKeyTails, tabId, task, { waitSignal: signal });
}

export function clearTabQueue(tabId: number): void {
  if (!Number.isFinite(tabId)) {
    return;
  }
  tabQueueTails.delete(tabId);
  requestQueueTails.delete(tabId);
  nativeMouseTails.delete(tabId);
  nativeKeyTails.delete(tabId);
}
