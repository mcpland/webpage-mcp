import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildProcessLifecycle, shouldDetachChildProcess } from './child-process-lifecycle';

class FakeChildProcess extends EventEmitter {
  public constructor(public pid: number | undefined) {
    super();
  }

  public readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
}

class FakeTaskkillProcess extends EventEmitter {}

function observeSettlement(promise: Promise<unknown>): {
  isSettled: () => boolean;
} {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { isSettled: () => settled };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('shouldDetachChildProcess', () => {
  it('creates an independent process group only on POSIX platforms', () => {
    expect(shouldDetachChildProcess('linux')).toBe(true);
    expect(shouldDetachChildProcess('darwin')).toBe(true);
    expect(shouldDetachChildProcess('win32')).toBe(false);
  });
});

describe('ChildProcessLifecycle', () => {
  it('does not terminate a process that exits normally', async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess(4321);
    const killProcess = vi.fn();
    const abortController = new AbortController();
    const lifecycle = new ChildProcessLifecycle(child, {
      signal: abortController.signal,
      timeoutMs: 1_000,
      abortError: () => new Error('cancelled'),
      timeoutError: () => new Error('timed out'),
      killProcess,
      platform: 'linux',
    });

    child.emit('spawn');
    child.emit('close', 0, null);

    await expect(lifecycle.completion).resolves.toEqual({
      code: 0,
      signal: null,
    });
    abortController.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(killProcess).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('waits for close before settling a cancellation', async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess(4321);
    const killProcess = vi.fn();
    const abortController = new AbortController();
    const lifecycle = new ChildProcessLifecycle(child, {
      signal: abortController.signal,
      timeoutMs: 1_000,
      terminationGraceMs: 100,
      abortError: () => new Error('cancelled'),
      timeoutError: () => new Error('timed out'),
      killProcess,
      platform: 'linux',
    });
    const settlement = observeSettlement(lifecycle.completion);

    child.emit('spawn');
    abortController.abort();
    await Promise.resolve();

    expect(killProcess).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(settlement.isSettled()).toBe(false);

    child.emit('close', null, 'SIGTERM');

    await expect(lifecycle.completion).rejects.toThrow('cancelled');
    expect(killProcess).toHaveBeenCalledWith(-4321, 'SIGKILL');
  });

  it('escalates to SIGKILL when the process group ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess(4321);
    const killProcess = vi.fn();
    const abortController = new AbortController();
    const lifecycle = new ChildProcessLifecycle(child, {
      signal: abortController.signal,
      timeoutMs: 1_000,
      terminationGraceMs: 100,
      abortError: () => new Error('cancelled'),
      timeoutError: () => new Error('timed out'),
      killProcess,
      platform: 'linux',
    });
    const settlement = observeSettlement(lifecycle.completion);

    child.emit('spawn');
    abortController.abort();
    await vi.advanceTimersByTimeAsync(100);

    expect(killProcess.mock.calls).toEqual([
      [-4321, 'SIGTERM'],
      [-4321, 'SIGKILL'],
    ]);
    expect(settlement.isSettled()).toBe(false);

    child.emit('close', null, 'SIGKILL');
    await expect(lifecycle.completion).rejects.toThrow('cancelled');
  });

  it('falls back to signalling the direct child when group signalling fails', async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess(4321);
    const killProcess = vi.fn(() => {
      throw new Error('process group unavailable');
    });
    const abortController = new AbortController();
    const lifecycle = new ChildProcessLifecycle(child, {
      signal: abortController.signal,
      timeoutMs: 1_000,
      terminationGraceMs: 100,
      abortError: () => new Error('cancelled'),
      timeoutError: () => new Error('timed out'),
      killProcess,
      platform: 'linux',
    });

    child.emit('spawn');
    abortController.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', null, 'SIGKILL');
    await expect(lifecycle.completion).rejects.toThrow('cancelled');
  });

  it('terminates on timeout but rejects only after the child closes', async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess(4321);
    const killProcess = vi.fn();
    const lifecycle = new ChildProcessLifecycle(child, {
      timeoutMs: 50,
      terminationGraceMs: 100,
      abortError: () => new Error('cancelled'),
      timeoutError: () => new Error('timed out'),
      killProcess,
      platform: 'linux',
    });
    const settlement = observeSettlement(lifecycle.completion);

    child.emit('spawn');
    await vi.advanceTimersByTimeAsync(50);

    expect(killProcess).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(settlement.isSettled()).toBe(false);

    child.emit('close', null, 'SIGTERM');
    await expect(lifecycle.completion).rejects.toThrow('timed out');
  });

  it('uses safe taskkill arguments on Windows and falls back to child.kill', async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess(9876);
    const taskkill = new FakeTaskkillProcess();
    const spawnCommand = vi.fn(() => taskkill);
    const abortController = new AbortController();
    const lifecycle = new ChildProcessLifecycle(child, {
      signal: abortController.signal,
      timeoutMs: 1_000,
      abortError: () => new Error('cancelled'),
      timeoutError: () => new Error('timed out'),
      platform: 'win32',
      spawnCommand,
    });
    const settlement = observeSettlement(lifecycle.completion);

    child.emit('spawn');
    abortController.abort();

    expect(spawnCommand).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '9876', '/T', '/F'],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      }),
    );
    expect(settlement.isSettled()).toBe(false);

    taskkill.emit('error', new Error('taskkill unavailable'));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settlement.isSettled()).toBe(false);

    child.emit('close', null, 'SIGKILL');
    await expect(lifecycle.completion).rejects.toThrow('cancelled');
  });

  it('settles an idempotent spawn failure without waiting for close', async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess(undefined);
    const lifecycle = new ChildProcessLifecycle(child, {
      timeoutMs: 1_000,
      abortError: () => new Error('cancelled'),
      timeoutError: () => new Error('timed out'),
      platform: 'linux',
    });

    child.emit('error', new Error('spawn ENOENT'));
    child.emit('close', null, null);

    await expect(lifecycle.completion).rejects.toThrow('spawn ENOENT');
    expect(child.kill).not.toHaveBeenCalled();
  });
});
