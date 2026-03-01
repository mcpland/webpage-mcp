# Webpage MCP Troubleshooting

This project now uses a fully native transport stack:

- Chrome Extension <-> Native Server: Chrome Native Messaging
- MCP Client <-> Native Server: stdio (`webpage-mcp-stdio`)
- Internal bridge: local IPC socket/pipe

No localhost HTTP port is required.

## Quick Checks

1. Verify installation:

```bash
npx -y webpage-mcp@latest doctor
```

2. Re-register native host if needed:

```bash
npx -y webpage-mcp@latest register --force --detect
```

For Chrome channel mismatches (Stable/Beta/Canary/Chrome for Testing), prefer:

```bash
npx -y webpage-mcp@latest register --browser chrome --force --extension-id <your_extension_id>
```

Then fully restart Chrome (quit all Chrome processes) before retrying.

3. Keep Chrome open with the extension enabled.

4. Ensure your MCP client uses `npx -y -p webpage-mcp@latest webpage-mcp-stdio`.

## Extension Not Connected

Symptoms:

- Extension popup shows disconnected
- Tools fail immediately

Checks:

1. Open `chrome://extensions`, ensure Developer Mode is on, and the extension is enabled.
2. Inspect extension service worker logs for native host errors.
3. Run:

```bash
npx -y webpage-mcp@latest doctor --fix
```

4. Re-register host:

```bash
npx -y webpage-mcp@latest register --force --detect
```

## MCP Client Cannot List/Call Tools

Symptoms:

- MCP client reports startup failure for `webpage-mcp-stdio`
- Tool listing times out

Checks:

1. Confirm MCP client command is `npx` with args `["-y", "-p", "webpage-mcp@latest", "webpage-mcp-stdio"]`.
2. Ensure extension is connected first (the stdio bridge depends on native host availability).
3. If needed, set explicit native socket path for both processes:

```bash
export WEBPAGE_MCP_NATIVE_SOCKET="$HOME/.webpage-mcp/native-custom.sock"
```

Use the same env for Chrome-launched native host environment and MCP client environment.

## ENOENT Socket Missing

Symptoms:

- Startup fails with `connect ENOENT .../.webpage-mcp/native-<uid>.sock`
- (Older builds) may show `.../webpage-mcp-native-<uid>.sock`

Root cause:

- `webpage-mcp-stdio` started, but the native host socket was not created yet.
- Most commonly: extension is not connected to native host, auto-connect is disabled, or socket env mismatch.
- On older builds, native host and MCP client may compute different `TMPDIR`, resulting in different socket paths.

Fix:

1. Open Chrome and ensure extension is enabled.
2. In extension popup, ensure native connection is established (Connect / auto-connect on).
3. Run:

```bash
npx -y webpage-mcp@latest doctor
```

4. If using custom socket path, make sure both sides use identical `WEBPAGE_MCP_NATIVE_SOCKET`.
5. Upgrade to latest `webpage-mcp`, then run:

```bash
npx -y webpage-mcp@latest register --force --detect
```

6. Fully restart Chrome and retry.

## Extension ID Mismatch

Symptoms:

- Clicking Connect in extension does not actually launch native host
- MCP stdio keeps reporting socket `ENOENT`

Root cause:

- Native Messaging manifest `allowed_origins` does not include your current extension ID.
- This often happens with unpacked builds where extension ID is not fixed.

Fix:

1. Copy your extension ID from `chrome://extensions`.
2. Re-register manifest with explicit extension ID (this also writes Chrome channel-compatible manifest paths):

```bash
npx -y webpage-mcp@latest register --browser chrome --force --extension-id <your_extension_id>
```

Note: `register` also tries to auto-discover local unpacked Webpage MCP extension IDs, but explicit `--extension-id` remains the most reliable fix.

3. Fully restart Chrome, reload extension, and retry Connect.

## Stream / Realtime Status Not Updating

Symptoms:

- Request starts but UI status never progresses
- Quick Panel / Web Editor gets no live events

Checks:

1. Make sure the extension service worker stays alive during request execution.
2. Re-open sidepanel and retry once.
3. Inspect service worker logs for `agent_stream_subscribe` / `agent_stream_event` errors.

## Agent / Tool Timeouts

Symptoms:

- Long-running operations fail after timeout

Notes:

- Tool calls from native host to extension use bounded request timeouts.
- Very long tasks may still exceed MCP client timeout settings.

Checks:

1. Increase MCP client timeout if configurable.
2. Keep Chrome focused and avoid closing the tab/session mid-run.
3. Retry with smaller task scope.

## Node / Permission Issues

Symptoms:

- Native host fails to launch
- `doctor` reports permission or Node path issues

Checks:

1. Use Node.js >= 20.
2. Run:

```bash
npx -y webpage-mcp@latest fix-permissions
```

3. Re-register host after permission changes:

```bash
npx -y webpage-mcp@latest register --force --detect
```

## Diagnostic Report

Generate a report for issues:

```bash
npx -y webpage-mcp@latest report
npx -y webpage-mcp@latest report --copy
npx -y webpage-mcp@latest report --json
```

Include the report and service worker logs when filing an issue.
