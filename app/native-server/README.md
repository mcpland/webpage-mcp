# webpage-mcp-bridge (Native Server)

Node.js Native Messaging host and MCP HTTP server for Webpage MCP.

## What This Package Does

- Bridges Chrome extension <-> local MCP clients via Native Messaging
- Exposes MCP endpoints (`/mcp`, `/sse`, `/messages`)
- Provides CLI utilities for registration and diagnostics

## Prerequisites

- Node.js >= 20
- pnpm >= 8 (recommended in this monorepo)

## Install and Build

From the repository root:

```bash
pnpm install
pnpm --filter webpage-mcp-bridge build
```

Or inside this package directory:

```bash
cd app/native-server
pnpm install
pnpm build
```

## Development

```bash
# Auto-rebuild + auto-register dev host
pnpm --filter webpage-mcp-bridge dev

# Run tests
pnpm --filter webpage-mcp-bridge test
```

## CLI Commands

After build (or via `npx`):

```bash
# Register Native Messaging host
webpage-mcp-bridge register --detect
webpage-mcp-bridge register --browser chrome
webpage-mcp-bridge register --browser chromium

# Diagnose installation
webpage-mcp-bridge doctor

# Export diagnostic report
webpage-mcp-bridge report

# Update stdio proxy target URL port
webpage-mcp-bridge update-port 12307

# Fix file execution permissions
webpage-mcp-bridge fix-permissions
```

## Port Behavior

Two different port settings exist:

1. Native server listen port
- Default is `12306`.
- The actual listen port is provided by the Chrome extension when it sends the `start` command.
- In normal usage, you change this from the extension popup "Port" field.

2. stdio proxy target port
- `update-port` only updates `mcp/stdio-config.json` used by `webpage-mcp-stdio`.
- It does not directly change the running native server listen port.

## Optional Auth Token

Set `WEBPAGE_MCP_AUTH_TOKEN` to require authentication for local API endpoints:

- Protected routes: `/mcp`, `/sse`, `/messages`, `/agent/*`, `/ask-extension`
- Send token via either:
  - `Authorization: Bearer <token>`
  - `x-webpage-mcp-token: <token>`

If `WEBPAGE_MCP_AUTH_TOKEN` is not set, behavior remains unchanged (no auth required).

## Browser Support

- Google Chrome
- Chromium

Supported on Linux, macOS, and Windows (registration paths differ by OS).

## Key Source Files

- `src/cli.ts` - CLI entry and commands
- `src/native-messaging-host.ts` - Native Messaging protocol handling
- `src/server/index.ts` - Fastify HTTP + MCP transport routes
- `src/mcp/register-tools.ts` - MCP tool registration and forwarding
