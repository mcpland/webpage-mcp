import type { ChildProcess, SpawnOptions } from 'node:child_process';
import spawn from 'cross-spawn';

export const CHILD_PROCESS_TERMINATION_GRACE_MS = 750;

export interface ChildProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface TerminableChildProcess {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'spawn', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  removeListener(event: 'spawn', listener: () => void): this;
  removeListener(event: 'error', listener: (error: Error) => void): this;
  removeListener(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

interface TaskkillProcess {
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null) => void): this;
}

type SpawnCommand = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => TaskkillProcess;

interface TimerHandle {
  unref?: () => void;
}

interface LifecycleScheduler {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const defaultScheduler: LifecycleScheduler = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

const defaultSpawnCommand: SpawnCommand = (command, args, options) =>
  spawn(command, [...args], options) as ChildProcess;

export interface ChildProcessLifecycleOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  timeoutError: () => Error;
  abortError: () => Error;
  onTerminationRequested?: () => void;
  platform?: NodeJS.Platform;
  terminationGraceMs?: number;
  scheduler?: LifecycleScheduler;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  spawnCommand?: SpawnCommand;
}

/**
 * Returns true when a spawned process should become a new POSIX process group.
 * Windows process trees are terminated with taskkill instead.
 */
export function shouldDetachChildProcess(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/**
 * Owns cancellation, timeout, and close observation for one child process.
 * Its completion never settles for cancellation/timeout until the child emits
 * close, so callers can safely clean up resources only after the process exits.
 */
export class ChildProcessLifecycle {
  public readonly completion: Promise<ChildProcessExit>;

  private readonly platform: NodeJS.Platform;
  private readonly scheduler: LifecycleScheduler;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly spawnCommand: SpawnCommand;
  private readonly terminationGraceMs: number;
  private resolveCompletion!: (exit: ChildProcessExit) => void;
  private rejectCompletion!: (error: Error) => void;
  private timeoutHandle: TimerHandle | null = null;
  private forceKillHandle: TimerHandle | null = null;
  private terminationError: Error | null = null;
  private forceKillSent = false;
  private spawned = false;
  private closed = false;

  public constructor(
    private readonly child: TerminableChildProcess,
    private readonly options: ChildProcessLifecycleOptions,
  ) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive finite number');
    }

    this.platform = options.platform ?? process.platform;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.spawnCommand = options.spawnCommand ?? defaultSpawnCommand;
    this.terminationGraceMs = options.terminationGraceMs ?? CHILD_PROCESS_TERMINATION_GRACE_MS;

    if (!Number.isFinite(this.terminationGraceMs) || this.terminationGraceMs < 0) {
      throw new RangeError('terminationGraceMs must be a non-negative finite number');
    }

    this.completion = new Promise<ChildProcessExit>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });

    child.once('spawn', this.handleSpawn);
    child.on('error', this.handleError);
    child.once('close', this.handleClose);

    if (options.signal) {
      options.signal.addEventListener('abort', this.handleAbort, {
        once: true,
      });
    }

    this.timeoutHandle = this.scheduler.setTimeout(this.handleTimeout, options.timeoutMs);
    this.timeoutHandle.unref?.();

    if (options.signal?.aborted) {
      this.handleAbort();
    }
  }

  public get isTerminationRequested(): boolean {
    return this.terminationError !== null;
  }

  /** Request process-tree termination. The first terminal reason wins. */
  public terminate(error: Error): void {
    if (this.closed || this.terminationError) return;
    this.terminationError = error;

    try {
      this.options.onTerminationRequested?.();
    } catch {
      // Resource cleanup is best-effort and must not prevent process termination.
    }

    if (this.platform === 'win32') {
      this.terminateWindowsProcessTree();
      return;
    }

    this.signalUnixProcessGroup('SIGTERM', true);
    this.forceKillHandle = this.scheduler.setTimeout(() => {
      this.forceKillHandle = null;
      if (!this.closed) {
        this.forceKillUnixProcessGroup(true);
      }
    }, this.terminationGraceMs);
    this.forceKillHandle.unref?.();
  }

  private readonly handleSpawn = (): void => {
    this.spawned = true;
  };

  private readonly handleAbort = (): void => {
    this.terminate(this.options.abortError());
  };

  private readonly handleTimeout = (): void => {
    this.timeoutHandle = null;
    this.terminate(this.options.timeoutError());
  };

  private readonly handleError = (error: Error): void => {
    // A spawn failure has no live process and may not be followed by close on
    // every ChildProcess implementation. Other process errors still require
    // termination and close observation.
    if (!this.spawned && this.child.pid === undefined) {
      this.settle({ code: null, signal: null }, error);
      return;
    }
    this.terminate(error);
  };

  private readonly handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (this.terminationError && this.platform !== 'win32' && !this.forceKillSent) {
      // The leader may exit on SIGTERM while descendants keep running. One
      // final group signal removes any remaining descendants before settling.
      this.forceKillUnixProcessGroup(false);
    }
    this.settle({ code, signal }, this.terminationError);
  };

  private settle(exit: ChildProcessExit, error: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    if (error) {
      this.rejectCompletion(error);
    } else {
      this.resolveCompletion(exit);
    }
  }

  private cleanup(): void {
    if (this.timeoutHandle) {
      this.scheduler.clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (this.forceKillHandle) {
      this.scheduler.clearTimeout(this.forceKillHandle);
      this.forceKillHandle = null;
    }
    if (this.options.signal) {
      this.options.signal.removeEventListener('abort', this.handleAbort);
    }
    this.child.removeListener('spawn', this.handleSpawn);
    this.child.removeListener('error', this.handleError);
    this.child.removeListener('close', this.handleClose);
  }

  private signalUnixProcessGroup(signal: NodeJS.Signals, fallbackToChild: boolean): void {
    const pid = this.child.pid;
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
      try {
        this.killProcess(-pid, signal);
        return;
      } catch {
        // Fall through to the direct-child fallback when the group is absent
        // or could not be signalled.
      }
    }

    if (!fallbackToChild) return;
    try {
      this.child.kill(signal);
    } catch {
      // SIGKILL cannot be handled further if both group and child signalling fail.
    }
  }

  private forceKillUnixProcessGroup(fallbackToChild: boolean): void {
    this.forceKillSent = true;
    this.signalUnixProcessGroup('SIGKILL', fallbackToChild);
  }

  private terminateWindowsProcessTree(): void {
    const pid = this.child.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
      this.killWindowsChildFallback();
      return;
    }

    let fallbackUsed = false;
    const fallback = (): void => {
      if (fallbackUsed || this.closed) return;
      fallbackUsed = true;
      if (this.forceKillHandle) {
        this.scheduler.clearTimeout(this.forceKillHandle);
        this.forceKillHandle = null;
      }
      this.killWindowsChildFallback();
    };

    try {
      const taskkill = this.spawnCommand('taskkill', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      taskkill.once('error', fallback);
      taskkill.once('close', (code) => {
        if (code !== 0) {
          fallback();
          return;
        }
        if (this.forceKillHandle) {
          this.scheduler.clearTimeout(this.forceKillHandle);
          this.forceKillHandle = null;
        }
      });
      // taskkill itself can hang (for example when Windows management
      // services are unhealthy). Do not let that prevent the direct child
      // from receiving a final, unhandleable signal.
      this.forceKillHandle = this.scheduler.setTimeout(fallback, this.terminationGraceMs);
      this.forceKillHandle.unref?.();
    } catch {
      fallback();
    }
  }

  private killWindowsChildFallback(): void {
    try {
      this.child.kill('SIGKILL');
    } catch {
      // taskkill and the direct-child fallback both failed.
    }
  }
}
