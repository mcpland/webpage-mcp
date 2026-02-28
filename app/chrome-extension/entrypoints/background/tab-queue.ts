const tabQueues = new Map<number, Promise<unknown>>();

export async function runInTabQueue<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  tabQueues.set(tabId, next as Promise<unknown>);

  try {
    return await next;
  } finally {
    if (tabQueues.get(tabId) === (next as Promise<unknown>)) {
      tabQueues.delete(tabId);
    }
  }
}
