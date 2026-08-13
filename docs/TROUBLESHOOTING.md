# Webpage MCP Troubleshooting

The browser side always uses the native bridge:

- Chrome Extension <-> MCP Server: Chrome Native Messaging
- Local MCP Client <-> MCP Server: stdio (`webpage-mcp-stdio`) by default
- Remote MCP Client <-> MCP Server: optional Streamable HTTP (`webpage-mcp-server`)
- Both MCP entries <-> Native Messaging host: authenticated local IPC socket/pipe

No HTTP port is required for the default setup. A listener exists only when `webpage-mcp-server` is explicitly started. If it is not running, the stdio/native path is unchanged.

## Quick Checks

1. Verify installation:

```bash
npx -y webpage-mcp@latest doctor
```

2. Re-register native host if needed:

```bash
npx -y webpage-mcp@latest register --detect
```

For Chrome channel mismatches (Stable/Beta/Canary/Chrome for Testing), prefer:

```bash
npx -y webpage-mcp@latest register --browser chrome --extension-id <your_extension_id>
```

Best practice:

- Prefer copying this command directly from extension popup/welcome, because it already includes the current `chrome.runtime.id`.
- The generated command may include `--force`; this flag is optional (registration is currently idempotent).

Then fully restart Chrome (quit all Chrome processes) before retrying.

3. Keep Chrome open with the extension enabled.

4. Ensure your MCP client uses `npx -y -p webpage-mcp@latest webpage-mcp-stdio`.

## Is Register One-Time?

Usually yes.

- Normal restarts (OS/Chrome/MCP client) do not require re-registering.
- Re-register only when extension ID changes, install path changes, manifest is removed, or browser profile data is reset.

## Extension Not Connected

Symptoms:

- Extension popup shows disconnected
- Tools fail immediately

Checks:

1. Confirm Google Chrome is version 135 or newer and the extension is enabled on `chrome://extensions`.
2. Developer mode is required to load an unpacked build. For the user-script manager and Web Editor, enable **Developer mode** in Chrome 135–137; in Chrome 138 or newer, enable **Allow User Scripts** on the extension's Details page.
3. Inspect extension service worker logs for native host errors.
4. Run:

```bash
npx -y webpage-mcp@latest doctor --fix
```

5. Re-register host:

```bash
npx -y webpage-mcp@latest register --detect
```

If you use unpacked extension, use the popup/welcome generated command with explicit `--extension-id`.

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

## Remote Streamable HTTP Cannot Connect

First verify the listener separately from Chrome/native readiness:

```bash
curl --fail http://127.0.0.1:12306/healthz
curl --fail \
  -H "Authorization: Bearer $WEBPAGE_MCP_REMOTE_TOKEN" \
  http://127.0.0.1:12306/readyz
```

Use the actual HTTPS hostname when TLS or a Host allowlist is configured. Interpret the result as follows:

- Connection refused: `webpage-mcp-server` is not running, the address/port is wrong, or a firewall blocks it.
- `/healthz` is `200` but `/readyz` is `503`: the listener is alive but the Native Messaging host is not connected. Open Chrome, connect the extension, and run `doctor`.
- `401 Unauthorized`: send `Authorization: Bearer <remote token>`. URL/query tokens and `WEBPAGE_MCP_AUTH_TOKEN` are not accepted.
- `403 Forbidden Host`: the hostname or IP used in the client URL is missing from `--allowed-host`.
- `403 Forbidden Origin`: the client sent an `Origin` that is missing from `--allowed-origin`. Normal server-side clients generally do not send this header.
- TLS certificate failure: use a certificate trusted by the remote client and make sure its SAN covers the hostname in the MCP URL.

The MCP URL must include `/mcp`, for example `https://mcp-host.example.internal:12306/mcp`. A non-loopback listener requires a dedicated remote token; wildcard binds require an allowed Host; plaintext also requires `--allow-insecure-http`. See [Remote MCP Access](REMOTE_MCP.md) for the complete secure setup.

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
2. In extension popup, use the status refresh button to reconnect and sync status.
3. Run:

```bash
npx -y webpage-mcp@latest doctor
```

4. If using custom socket path, make sure both sides use identical `WEBPAGE_MCP_NATIVE_SOCKET`.
5. Upgrade to latest `webpage-mcp`, then run:

```bash
npx -y webpage-mcp@latest register --detect
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

1. Copy the register command from extension popup/welcome (preferred), or copy extension ID from `chrome://extensions`.
2. Re-register manifest with explicit extension ID (this also writes Chrome channel-compatible manifest paths):

```bash
npx -y webpage-mcp@latest register --browser chrome --extension-id <your_extension_id>
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

1. Use Node.js >= 22 (Node.js 24 LTS recommended).
2. Run:

```bash
npx -y webpage-mcp@latest fix-permissions
```

3. Re-register host after permission changes:

```bash
npx -y webpage-mcp@latest register --detect
```

## Diagnostic Report

Generate a report for issues:

```bash
npx -y webpage-mcp@latest report
npx -y webpage-mcp@latest report --copy
npx -y webpage-mcp@latest report --json
```

Include the report and service worker logs when filing an issue.
