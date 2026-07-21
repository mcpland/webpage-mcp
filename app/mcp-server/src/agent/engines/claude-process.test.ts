import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_STDERR_CHUNK_MAX_BYTES,
  DEFAULT_CLAUDE_ENGINE_TIMEOUT_MS,
  linkAbortSignal,
  resolveClaudeEngineTimeoutMs,
  spawnSupervisedClaudeCodeProcess,
} from './claude-process';
import { BoundedDiagnosticBuffer } from './diagnostic-redaction';

class FakeClaudeChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);

  public constructor(public pid: number | undefined = 4242) {
    super();
  }
}

function createSpawnOptions(signal = new AbortController().signal) {
  return {
    command: process.execPath,
    args: ['/sdk/cli.js', '--output-format', 'stream-json'],
    cwd: '/workspace/project',
    env: { PATH: '/usr/local/bin' },
    signal,
  };
}

function observeSettlement(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Claude process supervision', () => {
  it('redacts a synchronous CLI spawn failure before it leaves the supervisor', () => {
    const secret = 'claude-spawn-password-secret';

    expect(() =>
      spawnSupervisedClaudeCodeProcess(createSpawnOptions(), {
        timeoutMs: 1_000,
        platform: 'linux',
        spawnProcess: () => {
          throw new Error(`spawn failed password=${secret}; executable unavailable`);
        },
      }),
    ).toThrow('spawn failed password=[REDACTED]; executable unavailable');

    try {
      spawnSupervisedClaudeCodeProcess(createSpawnOptions(), {
        timeoutMs: 1_000,
        platform: 'linux',
        spawnProcess: () => {
          throw new Error(`spawn failed password=${secret}; executable unavailable`);
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('uses safe pipe spawning and a detached POSIX process group', async () => {
    vi.useFakeTimers();
    const child = new FakeClaudeChildProcess();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const supervised = spawnSupervisedClaudeCodeProcess(createSpawnOptions(), {
      timeoutMs: 1_000,
      platform: 'linux',
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ['/sdk/cli.js', '--output-format', 'stream-json'],
      expect.objectContaining({
        cwd: '/workspace/project',
        env: { PATH: '/usr/local/bin' },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      }),
    );
    expect(spawnProcess.mock.calls[0][2]).not.toHaveProperty('signal');

    child.emit('spawn');
    child.emit('close', 0, null);
    await expect(supervised.completion).resolves.toEqual({
      code: 0,
      signal: null,
    });
  });

  it('does not detach on Windows', async () => {
    vi.useFakeTimers();
    const child = new FakeClaudeChildProcess();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const supervised = spawnSupervisedClaudeCodeProcess(createSpawnOptions(), {
      timeoutMs: 1_000,
      platform: 'win32',
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: false }),
    );
    child.emit('spawn');
    child.emit('close', 0, null);
    await expect(supervised.completion).resolves.toEqual({
      code: 0,
      signal: null,
    });
  });

  it('reports killed and SDK exit only after the underlying close event', async () => {
    vi.useFakeTimers();
    const child = new FakeClaudeChildProcess();
    const supervised = spawnSupervisedClaudeCodeProcess(createSpawnOptions(), {
      timeoutMs: 1_000,
      platform: 'linux',
      spawnProcess: () => child as unknown as ChildProcess,
    });
    const onExit = vi.fn();
    supervised.process.on('exit', onExit);
    const isSettled = observeSettlement(supervised.completion);

    child.emit('spawn');
    child.emit('exit', 0, null);
    await Promise.resolve();

    expect(supervised.process.killed).toBe(false);
    expect(supervised.process.exitCode).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
    expect(isSettled()).toBe(false);

    child.emit('close', 0, null);

    expect(supervised.process.killed).toBe(true);
    expect(supervised.process.exitCode).toBe(0);
    expect(onExit).toHaveBeenCalledWith(0, null);
    await expect(supervised.completion).resolves.toEqual({
      code: 0,
      signal: null,
    });
  });

  it('escalates an ignored abort from TERM to KILL and waits for close', async () => {
    vi.useFakeTimers();
    const child = new FakeClaudeChildProcess();
    const abortController = new AbortController();
    const killProcess = vi.fn();
    const supervised = spawnSupervisedClaudeCodeProcess(
      createSpawnOptions(abortController.signal),
      {
        timeoutMs: 1_000,
        terminationGraceMs: 100,
        platform: 'linux',
        killProcess,
        spawnProcess: () => child as unknown as ChildProcess,
      },
    );
    const isSettled = observeSettlement(supervised.completion);

    child.emit('spawn');
    abortController.abort();
    expect(killProcess).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(supervised.process.killed).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(killProcess.mock.calls).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ]);
    expect(isSettled()).toBe(false);

    child.emit('close', null, 'SIGKILL');
    expect(supervised.process.killed).toBe(true);
    await expect(supervised.completion).rejects.toThrow('execution was cancelled');
  });

  it('routes an SDK kill request through supervised tree termination', async () => {
    vi.useFakeTimers();
    const child = new FakeClaudeChildProcess();
    const killProcess = vi.fn();
    const supervised = spawnSupervisedClaudeCodeProcess(createSpawnOptions(), {
      timeoutMs: 1_000,
      terminationGraceMs: 100,
      platform: 'linux',
      killProcess,
      spawnProcess: () => child as unknown as ChildProcess,
    });

    child.emit('spawn');
    expect(supervised.process.kill('SIGTERM')).toBe(true);
    expect(killProcess).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(supervised.process.killed).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(killProcess).toHaveBeenLastCalledWith(-4242, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(supervised.completion).rejects.toThrow('termination requested');
    expect(supervised.process.kill('SIGTERM')).toBe(false);
  });

  it('terminates at the configured timeout without settling before close', async () => {
    vi.useFakeTimers();
    const child = new FakeClaudeChildProcess();
    const killProcess = vi.fn();
    const supervised = spawnSupervisedClaudeCodeProcess(createSpawnOptions(), {
      timeoutMs: 50,
      terminationGraceMs: 100,
      platform: 'linux',
      killProcess,
      spawnProcess: () => child as unknown as ChildProcess,
    });
    const isSettled = observeSettlement(supervised.completion);

    child.emit('spawn');
    await vi.advanceTimersByTimeAsync(50);

    expect(killProcess).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(isSettled()).toBe(false);
    child.emit('close', null, 'SIGTERM');
    await expect(supervised.completion).rejects.toThrow('execution timed out');
  });

  it('does not signal a process that exits normally', async () => {
    vi.useFakeTimers();
    const child = new FakeClaudeChildProcess();
    const killProcess = vi.fn();
    const supervised = spawnSupervisedClaudeCodeProcess(createSpawnOptions(), {
      timeoutMs: 50,
      terminationGraceMs: 100,
      platform: 'linux',
      killProcess,
      spawnProcess: () => child as unknown as ChildProcess,
    });

    child.emit('spawn');
    child.emit('close', 0, null);
    await expect(supervised.completion).resolves.toEqual({
      code: 0,
      signal: null,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(killProcess).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('bounds forwarded stderr and detaches the data listener on close', async () => {
    vi.useFakeTimers();
    const child = new FakeClaudeChildProcess();
    const onStderr = vi.fn();
    const supervised = spawnSupervisedClaudeCodeProcess(createSpawnOptions(), {
      timeoutMs: 1_000,
      platform: 'linux',
      onStderr,
      spawnProcess: () => child as unknown as ChildProcess,
    });

    child.emit('spawn');
    child.stderr.emit('data', Buffer.from('x'.repeat(CLAUDE_STDERR_CHUNK_MAX_BYTES * 2)));
    expect(onStderr).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(onStderr.mock.calls[0][0], 'utf8')).toBeLessThanOrEqual(
      CLAUDE_STDERR_CHUNK_MAX_BYTES,
    );

    child.emit('close', 0, null);
    await supervised.completion;
    child.stderr.emit('data', Buffer.from('after close'));
    expect(onStderr).toHaveBeenCalledTimes(1);
  });

  it('preserves stderr line endings across process chunks', async () => {
    vi.useFakeTimers();
    const child = new FakeClaudeChildProcess();
    const diagnostics = new BoundedDiagnosticBuffer();
    const forwarded: string[] = [];
    const emitted: string[] = [];
    const supervised = spawnSupervisedClaudeCodeProcess(createSpawnOptions(), {
      timeoutMs: 1_000,
      platform: 'linux',
      onStderr(data) {
        forwarded.push(data);
        emitted.push(...diagnostics.push(data));
      },
      spawnProcess: () => child as unknown as ChildProcess,
    });

    child.emit('spawn');
    child.stderr.emit('data', Buffer.from('resume failed\n'));
    child.stderr.emit('data', Buffer.from('connection reset by peer\n'));

    expect(forwarded).toEqual(['resume failed\n', 'connection reset by peer\n']);
    expect(emitted).toEqual(['resume failed', 'connection reset by peer']);

    child.emit('close', 0, null);
    await supervised.completion;
  });

  it('redacts child stderr before forwarding it to the SDK callback', async () => {
    vi.useFakeTimers();
    const child = new FakeClaudeChildProcess();
    const onStderr = vi.fn();
    const supervised = spawnSupervisedClaudeCodeProcess(createSpawnOptions(), {
      timeoutMs: 1_000,
      platform: 'linux',
      onStderr,
      spawnProcess: () => child as unknown as ChildProcess,
    });
    const secret = 'claude-process-bearer-secret';

    child.emit('spawn');
    child.stderr.emit(
      'data',
      Buffer.from(`Authorization: Bearer ${secret}\nconnection reset by peer`),
    );

    expect(onStderr).toHaveBeenCalledTimes(1);
    expect(onStderr.mock.calls[0][0]).not.toContain(secret);
    expect(onStderr.mock.calls[0][0]).toContain('Authorization: [REDACTED]');
    expect(onStderr.mock.calls[0][0]).toContain('connection reset by peer');

    child.emit('close', 0, null);
    await supervised.completion;
  });
});

describe('Claude process configuration', () => {
  it('uses a configurable timeout with a 15 minute safe default', () => {
    expect(resolveClaudeEngineTimeoutMs('2500')).toBe(2_500);
    expect(resolveClaudeEngineTimeoutMs('0')).toBe(DEFAULT_CLAUDE_ENGINE_TIMEOUT_MS);
    expect(resolveClaudeEngineTimeoutMs('invalid')).toBe(DEFAULT_CLAUDE_ENGINE_TIMEOUT_MS);
    expect(resolveClaudeEngineTimeoutMs(undefined)).toBe(DEFAULT_CLAUDE_ENGINE_TIMEOUT_MS);
  });

  it('removes the external abort listener after execution cleanup', () => {
    const externalController = new AbortController();
    const internalController = new AbortController();
    const addListener = vi.spyOn(externalController.signal, 'addEventListener');
    const removeListener = vi.spyOn(externalController.signal, 'removeEventListener');

    const unlink = linkAbortSignal(externalController.signal, internalController);
    expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), {
      once: true,
    });
    unlink();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));

    externalController.abort();
    expect(internalController.signal.aborted).toBe(false);
  });
});
