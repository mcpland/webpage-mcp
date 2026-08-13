# webpage-mcp

[![CI](https://github.com/mcpland/webpage-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mcpland/webpage-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/webpage-mcp.svg)](https://www.npmjs.com/package/webpage-mcp)
![license](https://img.shields.io/npm/l/webpage-mcp)

`webpage-mcp` is the Node.js MCP server package used by the Webpage MCP project.

It provides:

- `webpage-mcp`: CLI for registration, diagnostics, and maintenance
- `webpage-mcp-stdio`: MCP stdio server entry used by MCP clients
- `webpage-mcp-server`: optional MCP Streamable HTTP server entry for remote clients

This package uses:

- Local MCP Client <-> MCP Server: `stdio` by default
- Remote MCP Client <-> MCP Server: opt-in Streamable HTTP
- Webpage MCP Connector (Chrome extension) <-> MCP Server: Chrome Native Messaging
- Both MCP transports <-> Native Messaging host: authenticated local IPC socket / pipe

No HTTP server or port is required for the normal stdio setup. The optional listener exists only while `webpage-mcp-server` is explicitly running; without it, the original stdio/native path is unchanged.

## Requirements

- Node.js `>= 22` (Node.js 24 LTS recommended)
- Google Chrome 135 or newer with the Webpage MCP Connector extension installed

The Connector's Chrome 135 minimum applies to the entire extension. To use its
user-script manager, enable **Developer mode** on `chrome://extensions` in
Chrome 135–137. In Chrome 138 or newer, open the Connector's Details page and
enable **Allow User Scripts** instead.

## Quick Start (npm users)

1. Install the Webpage MCP Connector Chrome extension (release zip or unpacked build).
2. Configure MCP client:

```json
{
  "mcpServers": {
    "webpage-mcp": {
      "command": "npx",
      "args": ["-y", "-p", "webpage-mcp@latest", "webpage-mcp-stdio"]
    }
  }
}
```

3. Start MCP client (with Chrome open and extension enabled).

`webpage-mcp-stdio` will silently bootstrap Native Messaging on startup (manifest/runtime check + user-level auto-register when needed).

4. If connection still fails, run fallback recovery:

```bash
npx -y webpage-mcp@latest register --browser chrome --force --extension-id <your_extension_id>
npx -y webpage-mcp@latest doctor --fix
```

Recommended: copy the register command from extension popup/welcome page, because it already includes the current extension ID.

## Optional Remote MCP Server

Start a loopback-only Streamable HTTP endpoint with the main CLI subcommand:

```bash
npx -y webpage-mcp@latest webpage-mcp-server
```

Or invoke the standalone bin directly:

```bash
npx -y -p webpage-mcp@latest webpage-mcp-server
```

The default URL is `http://127.0.0.1:12306/mcp`. Binding to a non-loopback address requires a separate `WEBPAGE_MCP_REMOTE_TOKEN` or private `--token-file`. Wildcard binds also require at least one `--allowed-host`, and plaintext requires `--allow-insecure-http`.

Example with direct TLS:

```bash
npx -y webpage-mcp@latest webpage-mcp-server \
  --host 0.0.0.0 \
  --allowed-host mcp-host.example.internal \
  --token-file "$HOME/.config/webpage-mcp/remote-token" \
  --tls-cert /path/to/fullchain.pem \
  --tls-key /path/to/private-key.pem
```

The remote process is only a gateway to the existing authenticated local bridge. Chrome must remain open and the Connector must be connected. See [Remote MCP Access](../../docs/REMOTE_MCP.md) for secure deployment, Agent/Codex configuration, probes, all options, and troubleshooting.

## Version Compatibility

The Webpage MCP Connector Chrome extension and this `webpage-mcp` npm package are built and released from the same CI pipeline, but Chrome Web Store review and rollout timing is not fixed. This means the latest npm package may be available before the matching Chrome extension version reaches users.

We aim to keep nearby versions compatible. If you run into connection, protocol, or tool behavior issues, first make sure the Chrome extension and the MCP npm package use the same version for the best compatibility.

## Is Register One-Time?

Usually yes. In many cases you do not need manual register because startup bootstrap handles it.

If manual register is used, re-register only when one of these changes:

- extension ID
- host install path
- Chrome profile/manifest files reset

Normal restarts (OS / Chrome / MCP client) do not require re-registering.

## CLI Commands

```bash
webpage-mcp register [--browser chrome|chromium|all] [--detect] [--system] [--extension-id <id1,id2>] [--force]
webpage-mcp doctor [--fix] [--json] [--browser chrome|chromium|all]
webpage-mcp report [--json] [--output <file>] [--copy] [--no-redact] [--include-logs none|tail|full] [--log-lines <n>] [--browser chrome|chromium|all]
webpage-mcp fix-permissions
webpage-mcp webpage-mcp-server [remote options]
# aliases/standalone forms:
webpage-mcp serve [remote options]
webpage-mcp-server [remote options]
```

Notes:

- `register --force` is kept for compatibility; registration is idempotent.
- `register --system` requires admin/sudo privileges.
- `report` is intended for issue submission and troubleshooting. Native-host
  logs are excluded by default; use `--include-logs tail` or `full` only when
  needed, and review the redacted report before sharing it.

## Local Development (this monorepo)

Build package:

```bash
pnpm --filter webpage-mcp build
```

Verify local build health:

```bash
node app/mcp-server/dist/cli.js doctor
```

`webpage-mcp-stdio` started from local build also performs silent bootstrap. Only run manual register if connection still fails:

```bash
node app/mcp-server/dist/cli.js register --detect
# or
node app/mcp-server/dist/cli.js register --browser chrome --extension-id <your_extension_id>
```

Use local stdio entry in MCP client config:

```json
{
  "mcpServers": {
    "webpage-mcp-local": {
      "command": "node",
      "args": [
        "/absolute/path/to/webpage-mcp/app/mcp-server/dist/mcp/mcp-server-stdio.js"
      ]
    }
  }
}
```

Start the local-build HTTP gateway only when testing remote transport:

```bash
node app/mcp-server/dist/mcp/mcp-server-http.js --help
node app/mcp-server/dist/cli.js webpage-mcp-server
```

## Environment Variables

- `WEBPAGE_MCP_NATIVE_SOCKET`
  - Explicit IPC socket/pipe path for both native host and stdio bridge.
- `WEBPAGE_MCP_NATIVE_SOCKET_DIR`
  - Unix only. Custom directory for default socket file.
- `WEBPAGE_MCP_STDIO_CONNECT_TIMEOUT_MS`
  - Max wait time (ms) for stdio bridge to connect to native socket.
- `WEBPAGE_MCP_STDIO_CONNECT_RETRY_INTERVAL_MS`
  - Retry interval (ms) for stdio bridge connection.
- `WEBPAGE_MCP_EXTENSION_ID` / `WEBPAGE_MCP_EXTENSION_IDS`
  - Override/add allowed extension IDs during registration.
- `WEBPAGE_MCP_ALLOWED_ORIGINS`
  - Additional allowed Chrome extension origins (comma or whitespace separated).
- `WEBPAGE_MCP_AUTH_TOKEN`
  - Optional token exposed to extension via `auth_get_token` (for UI display/copy and downstream use).
- `WEBPAGE_MCP_REMOTE_HOST` / `WEBPAGE_MCP_REMOTE_PORT`
  - Optional remote gateway listen address and port (defaults: `127.0.0.1:12306`).
- `WEBPAGE_MCP_REMOTE_TOKEN` / `WEBPAGE_MCP_REMOTE_TOKEN_FILE`
  - Dedicated remote Bearer credential; a private token file takes precedence.
- `WEBPAGE_MCP_REMOTE_ALLOWED_HOSTS` / `WEBPAGE_MCP_REMOTE_ALLOWED_ORIGINS`
  - Comma/whitespace-separated HTTP Host and exact browser Origin allowlists.
- `WEBPAGE_MCP_REMOTE_TLS_CERT` / `WEBPAGE_MCP_REMOTE_TLS_KEY`
  - Optional direct-listener PEM certificate and private key.

## Extension UI Token vs. Remote Authentication

Set an auth token if you want the extension to read it from the native host:

```bash
export WEBPAGE_MCP_AUTH_TOKEN="your-token"
```

Current behavior:

- Token is returned by native host `auth_get_token`.
- Token is not currently enforced as an auth check for MCP tool calls.
- It is intentionally not accepted as the remote HTTP credential. Use the separate `WEBPAGE_MCP_REMOTE_TOKEN` or `--token-file` for remote access.

## Troubleshooting

If you see `ENOENT` / "Unable to connect to native bridge socket":

1. Confirm extension is enabled and connected.
2. Check that the Chrome extension and `webpage-mcp` npm package versions match, especially after a fresh npm release.
3. Re-run registration with current extension ID:

```bash
npx -y webpage-mcp@latest register --browser chrome --force --extension-id <your_extension_id>
```

4. Run:

```bash
npx -y webpage-mcp@latest doctor --fix
```

5. Fully restart Chrome and retry.

For HTTP `401`, `403`, TLS, firewall, or `/readyz` failures, use the remote-specific checks in [Remote MCP Access](../../docs/REMOTE_MCP.md) and [Troubleshooting](../../docs/TROUBLESHOOTING.md).

## Related Docs

- Root project guide: [../../README.md](../../README.md)
- Remote MCP access: [../../docs/REMOTE_MCP.md](../../docs/REMOTE_MCP.md)
- Troubleshooting: [../../docs/TROUBLESHOOTING.md](../../docs/TROUBLESHOOTING.md)
