import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([false, true])('releases a timed-out command with another owner present: %s', async (shared) => {
  vi.useFakeTimers();
  vi.resetModules();
  let rejectOldCommand!: (reason: Error) => void;
  const stuck = new Promise<never>((_, reject) => { rejectOldCommand = reject; });
  const debuggerApi = {
    getTargets: vi.fn(async () => []),
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn().mockImplementationOnce(() => stuck).mockResolvedValue({}),
    onDetach: { addListener: vi.fn() },
    onEvent: { addListener: vi.fn() },
  };
  vi.stubGlobal('chrome', { ...chrome, debugger: debuggerApi });
  const { cdpSessionManager: manager } = await import('@/utils/cdp-session-manager');
  const { runCdpInputWithDialogs, PAGE_ENABLE_TIMEOUT_MS } = await import('@/utils/cdp-input');
  if (shared) await manager.attach(7, 'network-capture');

  const dispatch = vi.fn();
  const rejected = expect(runCdpInputWithDialogs(7, 'click', dispatch))
    .rejects.toMatchObject({ name: 'PageUnresponsiveError' });
  await vi.advanceTimersByTimeAsync(PAGE_ENABLE_TIMEOUT_MS + 1);
  await rejected;
  expect(dispatch).not.toHaveBeenCalled();
  if (shared) {
    expect(debuggerApi.detach).not.toHaveBeenCalled();
    await manager.detach(7, 'network-capture');
  }
  expect(debuggerApi.detach).toHaveBeenCalledTimes(1);

  await manager.attach(7, 'new-session');
  rejectOldCommand(new Error('Debugger is not attached to the tab'));
  await vi.advanceTimersByTimeAsync(0);
  expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
  expect(debuggerApi.attach).toHaveBeenCalledTimes(2);
  expect(debuggerApi.detach).toHaveBeenCalledTimes(1);
  await manager.detach(7, 'new-session');
});
