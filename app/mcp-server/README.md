# webpage-mcp (MCP Server Package)

`webpage-mcp` is the Node.js MCP server package used by the Webpage MCP project.

It provides:

- `webpage-mcp`: CLI for registration, diagnostics, and maintenance
- `webpage-mcp-stdio`: MCP stdio server entry used by MCP clients

This package uses:

- MCP Client <-> MCP Server: `stdio`
- Chrome Extension <-> MCP Server: Chrome Native Messaging
- Internal bridge: local IPC socket / pipe

No localhost HTTP server or port is required.

## Requirements

- Node.js `>= 20`
- Chrome/Chromium with Webpage MCP extension installed

## Quick Start (npm users)

1. Install the Webpage MCP Chrome extension (release zip or unpacked build).
2. Register Native Messaging host once:

```bash
npx -y webpage-mcp@latest register --browser chrome --force --extension-id <your_extension_id>
```

Recommended: copy this command from extension popup/welcome page, because it already contains the current extension ID.

3. Run diagnostics and auto-fix common issues:

```bash
npx -y webpage-mcp@latest doctor --fix
```

4. Configure MCP client:

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

5. Open Chrome, make sure extension is enabled, and click `Connect` in popup if needed.

## Is Register One-Time?

Usually yes. Re-register only when one of these changes:

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
```

Notes:

- `register --force` is kept for compatibility; registration is idempotent.
- `register --system` requires admin/sudo privileges.
- `report` is intended for issue submission and troubleshooting.

## Local Development (this monorepo)

Build package:

```bash
pnpm --filter webpage-mcp build
```

Register using local build:

```bash
node app/mcp-server/dist/cli.js register --browser chrome --extension-id <your_extension_id>
node app/mcp-server/dist/cli.js doctor
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

## Optional Auth Token

Set an auth token if you want the extension to read it from the native host:

```bash
export WEBPAGE_MCP_AUTH_TOKEN="your-token"
```

Current behavior:

- Token is returned by native host `auth_get_token`.
- Token is not currently enforced as an auth check for MCP tool calls.

## Troubleshooting

If you see `ENOENT` / "Unable to connect to native bridge socket":

1. Confirm extension is enabled and connected.
2. Re-run registration with current extension ID:

```bash
npx -y webpage-mcp@latest register --browser chrome --force --extension-id <your_extension_id>
```

3. Run:

```bash
npx -y webpage-mcp@latest doctor --fix
```

4. Fully restart Chrome and retry.

## Related Docs

- Root project guide: [../../README.md](../../README.md)
- Troubleshooting: [../../docs/TROUBLESHOOTING.md](../../docs/TROUBLESHOOTING.md)
