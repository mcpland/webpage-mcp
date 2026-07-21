import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import spawn from 'cross-spawn';
import {
  ChildProcessLifecycle,
  type ChildProcessExit,
  shouldDetachChildProcess,
} from './child-process-lifecycle';
import {
  createRedactedDiagnosticError,
  redactDiagnosticText,
} from './diagnostic-redaction';
import { resolveTrustedExecutable } from './trusted-executable';

/** Keep a single SDK stderr callback from retaining or logging an arbitrary payload. */
export const CLAUDE_STDERR_CHUNK_MAX_BYTES = 16 * 1024;
export const DEFAULT_CLAUDE_ENGINE_TIMEOUT_MS = 15 * 60 * 1000;

export function resolveClaudeEngineTimeoutMs(
  configuredValue: string | undefined = process.env.CLAUDE_ENGINE_TIMEOUT_MS,
): number {
  const configuredTimeoutMs = Number.parseInt(configuredValue ?? '', 10);
  return Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : DEFAULT_CLAUDE_ENGINE_TIMEOUT_MS;
}

/** Mirror request cancellation into the controller expected by the SDK. */
export function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => undefined;
  if (source.aborted) {
    target.abort();
    return () => undefined;
  }

  const handleAbort = (): void => target.abort();
  source.addEventListener('abort', handleAbort, { once: true });
  return () => source.removeEventListener('abort', handleAbort);
}

type SpawnChildProcess = (
  command: string,
  args: string[],
  options: NodeSpawnOptions,
) => ChildProcess;

export interface ClaudeProcessSupervisorOptions {
  timeoutMs: number;
  onStderr?: (data: string) => void;
  onTerminationRequested?: () => void;
  platform?: NodeJS.Platform;
  terminationGraceMs?: number;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  spawnProcess?: SpawnChildProcess;
}

export interface SupervisedClaudeCodeProcess {
  process: SpawnedProcess;
  completion: Promise<ChildProcessExit>;
}

function requirePipe<T>(stream: T | null, name: string): T {
  if (!stream) {
    throw new Error(`ClaudeEngine: Claude Code ${name} pipe was not created`);
  }
  return stream;
}

/**
 * Spawn Claude Code under the same process-tree lifecycle used by Codex.
 *
 * The SDK treats `SpawnedProcess.killed` as equivalent to process exit, while
 * Node marks `ChildProcess.killed` as soon as a signal is sent. This adapter
 * intentionally reports termination only after `close`, and delays the SDK's
 * synthetic `exit` event until that same point so stdout/stderr are drained.
 */
export function spawnSupervisedClaudeCodeProcess(
  spawnOptions: ClaudeSpawnOptions,
  supervisorOptions: ClaudeProcessSupervisorOptions,
): SupervisedClaudeCodeProcess {
  const platform = supervisorOptions.platform ?? process.platform;
  const spawnProcess = supervisorOptions.spawnProcess ?? spawn;
  let executable: string;
  try {
    executable = resolveTrustedExecutable(spawnOptions.command, {
      env: spawnOptions.env,
      platform,
      untrustedCwd: spawnOptions.cwd,
    });
  } catch (error) {
    throw createRedactedDiagnosticError(error);
  }

  let child: ChildProcess;
  try {
    child = spawnProcess(executable, [...spawnOptions.args], {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: shouldDetachChildProcess(platform),
    });
  } catch (error) {
    throw createRedactedDiagnosticError(error);
  }

  let stdin: Writable;
  let stdout: Readable;
  let stderr: Readable;
  try {
    stdin = requirePipe(child.stdin, 'stdin');
    stdout = requirePipe(child.stdout, 'stdout');
    stderr = requirePipe(child.stderr, 'stderr');
  } catch (error) {
    try {
      child.kill('SIGKILL');
    } catch {
      // A malformed spawn result has no further safe cleanup path.
    }
    throw error;
  }

  const events = new EventEmitter();
  // EventEmitter throws when an error has no listener. The SDK installs its
  // listener immediately after this function returns, but keep spawn errors
  // safe even if an implementation reports one synchronously.
  events.on('error', () => undefined);

  let lifecycle: ChildProcessLifecycle | null = null;
  let closed = false;
  let observedExitCode: number | null = null;

  const spawnedProcess: SpawnedProcess = {
    stdin,
    stdout,
    get killed() {
      return closed;
    },
    get exitCode() {
      return observedExitCode;
    },
    kill(signal): boolean {
      if (closed) return false;
      lifecycle?.terminate(
        new Error(`ClaudeEngine: Claude Code process termination requested (${signal})`),
      );
      return true;
    },
    on(event, listener): void {
      events.on(event, listener);
    },
    once(event, listener): void {
      events.once(event, listener);
    },
    off(event, listener): void {
      events.off(event, listener);
    },
  };

  const handleError = (error: Error): void => {
    events.emit('error', createRedactedDiagnosticError(error));
  };
  const handleStderr = (data: Buffer | string): void => {
    if (!supervisorOptions.onStderr) return;
    const redacted = redactDiagnosticText(data, CLAUDE_STDERR_CHUNK_MAX_BYTES);
    if (redacted) supervisorOptions.onStderr(redacted);
  };
  const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (closed) return;
    closed = true;
    observedExitCode = code;
    stderr.removeListener('data', handleStderr);
    child.removeListener('error', handleError);
    child.removeListener('close', handleClose);
    // The SDK only exposes an `exit` event. Emit it after Node's stronger
    // `close` observation so SDK completion cannot race pipe/process cleanup.
    events.emit('exit', code, signal);
  };

  child.on('error', handleError);
  child.once('close', handleClose);
  stderr.on('data', handleStderr);

  lifecycle = new ChildProcessLifecycle(child, {
    signal: spawnOptions.signal,
    timeoutMs: supervisorOptions.timeoutMs,
    abortError: () => new Error('ClaudeEngine: execution was cancelled'),
    timeoutError: () => new Error('ClaudeEngine: execution timed out'),
    onTerminationRequested: supervisorOptions.onTerminationRequested,
    platform,
    terminationGraceMs: supervisorOptions.terminationGraceMs,
    killProcess: supervisorOptions.killProcess,
  });

  return {
    process: spawnedProcess,
    completion: lifecycle.completion,
  };
}
