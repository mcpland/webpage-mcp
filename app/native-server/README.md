# webpage-mcp (Native Server)

Node.js Native Messaging host for Webpage MCP.

## What This Package Does

- Bridges Chrome extension <-> local MCP clients via Native Messaging + local IPC
- Runs MCP over stdio only via `webpage-mcp-stdio`
- Provides CLI utilities for registration and diagnostics

No localhost MCP HTTP endpoint is required.

## Prerequisites

- Node.js >= 20
- pnpm >= 8 (recommended in this monorepo)

## Install and Build

From repository root:

```bash
pnpm install
pnpm --filter webpage-mcp build
```

Or inside this package:

```bash
cd app/native-server
pnpm install
pnpm build
```

## Development

```bash
# Auto-rebuild + auto-register dev host
pnpm --filter webpage-mcp dev

# Run tests
pnpm --filter webpage-mcp test
```

## CLI Commands

After build (or via `npx`):

```bash
# Register Native Messaging host
webpage-mcp register --detect
webpage-mcp register --browser chrome
webpage-mcp register --browser chromium

# Diagnose installation
webpage-mcp doctor

# Export diagnostic report
webpage-mcp report

# Fix file execution permissions
webpage-mcp fix-permissions
```

## Transport Model

- Chrome Extension <-> Native Server: Chrome Native Messaging
- MCP Client <-> Native Server: stdio (`webpage-mcp-stdio`)
- Internal bridge: local IPC socket/pipe (configurable by `WEBPAGE_MCP_NATIVE_SOCKET`)

## Optional Auth Token

Set `WEBPAGE_MCP_AUTH_TOKEN` to require auth for internal protected routes used by native RPC.

- Allowed token formats:
  - `Authorization: Bearer <token>`
  - `x-webpage-mcp-token: <token>`

If `WEBPAGE_MCP_AUTH_TOKEN` is unset, auth is not enforced.

## Browser Support

- Google Chrome
- Chromium

Supported on Linux, macOS, and Windows (registration paths differ by OS).

## Key Source Files

- `src/cli.ts` - CLI entry and commands
- `src/native-messaging-host.ts` - Native Messaging protocol + IPC bridge
- `src/server/index.ts` - Internal route runtime (no external HTTP listener)
- `src/mcp/mcp-server-stdio.ts` - stdio MCP server entry
- `src/mcp/register-tools.ts` - MCP tool registration and forwarding
