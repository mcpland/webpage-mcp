/** Stop waiting for a read-only browser operation even if Chrome delays its reply. */
export async function readWithSignal<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return read();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
