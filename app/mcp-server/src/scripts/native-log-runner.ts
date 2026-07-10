import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  BoundedLogFile,
  capExistingLogFile,
  consumeNativeLogPolicy,
  pruneNativeHostLogs,
  type NativeLogPolicy,
} from "./native-log-policy";

const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function appendStartupFailure(
  policy: NativeLogPolicy | undefined,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!policy) {
    process.stderr.write(
      `[webpage-mcp] Native log supervisor failed: ${message}\n`,
    );
    return;
  }

  try {
    appendFileSync(
      policy.stderrPath,
      `[webpage-mcp] Native log supervisor failed: ${message}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    capExistingLogFile(policy.stderrPath, policy.stderrMaxBytes);
  } catch {
    process.stderr.write(
      "[webpage-mcp] Native log supervisor failed to start\n",
    );
  }
}

function forwardSignals(child: ChildProcess): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = (): void => {
      try {
        child.kill(signal);
      } catch {
        // The child may already have exited.
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

function runNativeHost(
  policy: NativeLogPolicy,
  entrypoint: string,
  args: string[],
): void {
  pruneNativeHostLogs(policy);
  capExistingLogFile(policy.wrapperPath, policy.wrapperMaxBytes);

  const stderrLog = new BoundedLogFile(
    policy.stderrPath,
    policy.stderrMaxBytes,
  );
  const child = spawn(process.execPath, [entrypoint, ...args], {
    env: process.env,
    stdio: ["inherit", "inherit", "pipe"],
    windowsHide: true,
  });
  const stopForwardingSignals = forwardSignals(child);
  let finished = false;
  let logWritable = true;

  const closeLogBestEffort = (): void => {
    try {
      stderrLog.close();
    } catch {
      // A logging failure must not change native host lifecycle semantics.
    }
  };

  const writeLogBestEffort = (value: string | Uint8Array): void => {
    if (!logWritable) {
      return;
    }
    try {
      stderrLog.write(value);
    } catch {
      logWritable = false;
      closeLogBestEffort();
    }
  };

  const finish = (exitCode: number): void => {
    if (finished) {
      return;
    }
    finished = true;
    stopForwardingSignals();
    closeLogBestEffort();
    process.exitCode = exitCode;
  };

  child.stderr?.on("data", (chunk: Buffer) => {
    writeLogBestEffort(chunk);
  });
  child.once("error", (error) => {
    writeLogBestEffort(
      `[webpage-mcp] Unable to launch native host: ${error.message}\n`,
    );
    finish(1);
  });
  child.once("close", (code, signal) => {
    const signalExitCode = signal ? 1 : 0;
    finish(code ?? signalExitCode);
  });
}

let policy: NativeLogPolicy | undefined;
try {
  policy = consumeNativeLogPolicy(process.env);
  const [entrypoint, ...args] = process.argv.slice(2);
  if (!entrypoint) {
    throw new Error("Native host entrypoint was not provided");
  }
  runNativeHost(policy, entrypoint, args);
} catch (error) {
  appendStartupFailure(policy, error);
  process.exitCode = 1;
}
