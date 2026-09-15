# Native runtime disconnect regression (#22)

## Failure mechanism

[Issue #22](https://github.com/mcpland/webpage-mcp/issues/22) reports an orphaned
v0.10.0 native runtime consuming roughly one CPU core and ignoring SIGTERM.
The report does not contain a sampled stack, but the following controlled
reproduction produces those symptoms on macOS with Node 24.16.0:

1. Launch `dist/index.js` with isolated IPC and agent data directories, and
   stdin, stdout and stderr connected to parent-owned pipes.
2. Exchange a native message to establish that startup has completed.
3. Close the parent's stdout and stderr readers, keeping the child's stdin open.
4. Send an unknown native directive to trigger an error response.

Before the fix, a failed native output write only rejected queued messages and
logged to `process.stderr`. If the log supervisor had also disappeared, that
write failed too. The uncaught-exception handler logged another error through
stderr **before** checking whether shutdown had already started. Repeated stream
errors could monopolize Node's next-tick processing, starving cleanup, timers
and signal callbacks. A manual baseline probe measured 99% CPU and required
SIGKILL after SIGTERM failed to terminate the process.

Closing only stdout left a different defect: a runtime with an unusable native
transport remained alive and held its IPC socket. EOF alone exited normally.
The reporter's exact sequence is not available, so supervisor loss is a
reproduced trigger, not a claim about an observed stack from their machine.

## Corrected lifecycle

- Terminal native output errors and closure notify the owning host even when
  there is no pending write. Encoding and queue-capacity errors remain local
  message failures; they do not disconnect a healthy transport.
- Input EOF/close/error, output failure, SIGINT/SIGTERM/SIGHUP and fatal process
  errors use one shutdown coordinator. Cleanup runs once; a subsequent failure
  can upgrade a successful exit code to a failure.
- Fault diagnostics use a single bounded synchronous write to fd 2, catching
  failures without retrying or generating another Writable error event.
- Cleanup waits for in-progress IPC setup, removes input listeners, rejects
  buffered output and requests, cancels server work, and removes owned socket
  and credential files. It cannot attach new input handlers after shutdown.
- A five-second deadline terminates a process whose asynchronous cleanup cannot
  settle. This deadline is a fallback; eliminating the error-event loop is what
  allows timers and normal cleanup to run.

The native transport belongs to its Chrome connection. Losing it requires exit,
not an idle timeout or reuse of a runtime with dead pipes. Existing IPC socket
ownership checks prevent a second host from taking over a live listener. The
extension already has reconnect backoff (up to 60 seconds, followed by a
five-minute cooldown), so this fix does not add another reconnect loop.

## Regression verification

`src/native-runtime-lifecycle.test.ts` builds the real entrypoint and launches
isolated subprocesses. Its external watchdog can kill a starved child without
hanging the test runner. Both broken-output cases fail on the pre-fix revision
and pass with the fix; tests also verify socket/credential removal, normal EOF,
and SIGTERM after log-reader loss. Unit tests cover idle output failure,
shutdown during startup, close without EOF, pending-write cleanup, exit-code
escalation and the cleanup deadline.

These tests run through the normal MCP test command:

```bash
pnpm --filter webpage-mcp test
```

A source commit does not update an already registered `~/.webpage-mcp/runtime`.
Users must install/register a package containing the fix and restart Chrome.
Publishing that package is a separate release step.
