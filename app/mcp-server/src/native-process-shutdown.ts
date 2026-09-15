import { writeSync } from 'node:fs';

export const NATIVE_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Diagnostics must never enqueue another stream error on a broken stderr. */
export function reportNativeError(label: string, error: unknown): void {
  try {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    // One bounded, best-effort write. Never retry EPIPE, EAGAIN or partial writes.
    writeSync(2, Buffer.from(`[${label}] ${detail}\n`).subarray(0, 4096));
  } catch {
    // The log supervisor may already be gone; reporting cannot block shutdown.
  }
}

/** Share one exit path across signals, stream failures and fatal exceptions. */
export function createNativeProcessShutdown(cleanup: () => Promise<void>) {
  let started = false;
  let requestedExitCode = 0;
  return (exitCode: number, label?: string, error?: unknown): void => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (started) return;
    started = true;
    const deadline = setTimeout(() => process.exit(1), NATIVE_SHUTDOWN_TIMEOUT_MS);
    if (label) reportNativeError(label, error);
    void Promise.resolve()
      .then(cleanup)
      .catch((cleanupError) => {
        requestedExitCode = 1;
        reportNativeError('mcp-server shutdown failed', cleanupError);
      })
      .finally(() => {
        clearTimeout(deadline);
        process.exit(requestedExitCode);
      });
  };
}
