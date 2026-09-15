import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeProcessShutdown, NATIVE_SHUTDOWN_TIMEOUT_MS } from './native-process-shutdown';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('native process shutdown', () => {
  it('cleans up once and preserves a later failure exit code', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const shutdown = createNativeProcessShutdown(cleanup);
    shutdown(0);
    shutdown(1);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('forces an exit when resource cleanup never settles', async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const cleanup = vi.fn(() => new Promise<void>(() => {}));
    const shutdown = createNativeProcessShutdown(cleanup);
    shutdown(0);
    await vi.advanceTimersByTimeAsync(NATIVE_SHUTDOWN_TIMEOUT_MS);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
