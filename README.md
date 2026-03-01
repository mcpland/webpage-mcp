# Webpage MCP

Turn your Chrome browser into a fully-featured [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server. Let AI assistants like Claude, Cursor, Windsurf, and other MCP-compatible clients control your browser - navigate pages, take screenshots, click elements, read content, capture network traffic, run JavaScript, and much more.

## How It Works

```
AI Client (Claude Desktop, Cursor, etc.)
    <-> MCP (Streamable HTTP / SSE / stdio)
Native Server (Node.js, default port 12306)
    <-> Chrome Native Messaging (stdin/stdout)
Chrome Extension (service worker)
    <-> Chrome APIs / DevTools Protocol
Your Browser
```

The **Chrome extension** exposes real browser capabilities as MCP tools. The **Native Server** acts as the bridge between AI clients and the Chrome extension using Chrome's [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) protocol. Any MCP-compatible AI client can connect via HTTP, SSE, or stdio transport.

## Features

### MCP Browser Tools

| Tool | Description |
|---|---|
| `get_windows_and_tabs` | Get all open browser windows and tabs |
| `chrome_navigate` | Navigate to a URL, refresh, or navigate history (back/forward) |
| `chrome_screenshot` | Take a screenshot of the page or a specific element |
| `chrome_read_page` | Get an accessibility tree of visible elements on the page |
| `chrome_computer` | Mouse and keyboard interaction with the browser (computer use) |
| `chrome_click_element` | Click elements via CSS selector, XPath, element ref, or coordinates |
| `chrome_fill_or_select` | Fill or select form elements (input, textarea, select, checkbox, radio) |
| `chrome_keyboard` | Simulate keyboard input (keys, combinations, or text) |
| `chrome_javascript` | Execute JavaScript code in a browser tab |
| `chrome_get_web_content` | Fetch and parse web page content |
| `chrome_network_request` | Send network requests from the browser context (with cookies) |
| `chrome_network_capture` | Capture network requests (start/stop, optional response bodies via CDP) |
| `chrome_console` | Capture console output (snapshot or persistent buffer mode) |
| `chrome_history` | Search and retrieve browsing history |
| `chrome_bookmark_search` | Search bookmarks by title and URL |
| `chrome_bookmark_add` | Add a new bookmark |
| `chrome_bookmark_delete` | Delete a bookmark |
| `chrome_switch_tab` | Switch to a specific tab |
| `chrome_close_tabs` | Close one or more tabs |
| `chrome_upload_file` | Upload files to web forms via CDP |
| `chrome_handle_dialog` | Handle JavaScript dialogs (alert/confirm/prompt) |
| `chrome_handle_download` | Wait for and retrieve download details |
| `chrome_request_element_selection` | Let the user manually select elements on the page |
| `chrome_gif_recorder` | Record browser activity as an animated GIF |
| `performance_start_trace` | Start a performance trace recording |
| `performance_stop_trace` | Stop the active performance trace |
| `performance_analyze_insight` | Get a lightweight summary of the last recorded trace |

### Additional Capabilities

- **AI Agent Chat Sidepanel** - Built-in sidepanel for chatting with AI agents (Claude Code CLI, OpenAI Codex CLI) directly from Chrome, with project management, session history, and streaming output
- **Record & Replay** - Record browser actions and replay them as automated flows; published flows are exposed as dynamic MCP tools (`flow.<slug>`)
- **Web Editor** - Visual in-page DOM editor overlay with property panel and transaction system (`Cmd+Shift+O`)
- **Quick Panel** - Keyboard-triggered floating AI chat accessible from any page (`Cmd+Shift+U`)
- **Semantic Search** - On-device embedding model ([all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)) with HNSW vector index for searching tab content
- **Element Marker** - Annotate DOM elements with names/selectors, accessible to AI tools via context menu

## Installation

### Prerequisites

- **Chrome** (or Chromium-based browser)
- **Node.js** >= 20.0.0
- **pnpm** (package manager)

### 1. Clone and Build

```bash
git clone https://github.com/mcpland/webpage-mcp.git
cd webpage-mcp

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### 2. Install the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `app/chrome-extension/.output/chrome-mv3` folder

> This repository does not currently commit binary release zip files. To generate one locally, run `pnpm --filter webpage-mcp-server zip` and use the artifact from `app/chrome-extension/.output/`.

### 3. Register the Native Messaging Host

```bash
# Register for detected browsers
cd app/native-server
npx webpage-mcp register --detect

# Or specify the browser explicitly
npx webpage-mcp register --browser chrome
```

This places a JSON manifest in Chrome's `NativeMessagingHosts/` directory so the browser can launch the native server process.

### 4. Verify Installation

```bash
# Diagnose installation issues
npx webpage-mcp doctor

# Generate a full diagnostic report
npx webpage-mcp report
```

Open Chrome and click the extension icon - it should show a connected status.

## Configuration

### Connecting AI Clients

The MCP server runs on `http://127.0.0.1:12306` by default. It supports three transport modes:

#### Streamable HTTP (recommended)

Endpoint: `http://127.0.0.1:12306/mcp`

#### SSE (legacy)

Endpoints: `http://127.0.0.1:12306/sse` (event stream) + `http://127.0.0.1:12306/messages` (messages)

#### stdio

Use the `webpage-mcp-stdio` binary, which proxies stdio to the HTTP server:

```json
{
  "mcpServers": {
    "webpage-mcp": {
      "command": "npx",
      "args": ["-y", "webpage-mcp@latest", "webpage-mcp-stdio"]
    }
  }
}
```

`webpage-mcp-stdio` resolves its upstream endpoint in this order:

1. `WEBPAGE_MCP_URL` (full URL)
2. `WEBPAGE_MCP_PORT` / `MCP_HTTP_PORT` (builds `http://127.0.0.1:<port>/mcp`)
3. `app/native-server/dist/mcp/stdio-config.json` (or packaged equivalent)

### Claude Desktop Configuration

Add to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "webpage-mcp": {
      "command": "webpage-mcp-stdio"
    }
  }
}
```

Or if using npx:

```json
{
  "mcpServers": {
    "webpage-mcp": {
      "command": "npx",
      "args": ["-y", "webpage-mcp@latest", "webpage-mcp-stdio"]
    }
  }
}
```

### Port Configuration

Use a strict 1:1 port mapping:

1. Set the server port in the extension popup (default `12306`).
2. Point `webpage-mcp-stdio` to that same port:

```bash
npx webpage-mcp update-port 12306
```

`update-port` edits `app/native-server/dist/mcp/stdio-config.json` (or packaged equivalent).
If the popup port changes, run `update-port` with the same value.

For multiple MCP server instances, each instance must use a unique port.

### Optional Local Auth Token

If you want to require auth on local MCP/agent endpoints, set:

```bash
export WEBPAGE_MCP_AUTH_TOKEN="your-random-token"
```

When set, requests to `/mcp`, `/sse`, `/messages`, `/agent/*`, and `/ask-extension` must include either:

- `Authorization: Bearer <token>`
- `x-webpage-mcp-token: <token>`

`webpage-mcp-stdio` will forward this token automatically when `WEBPAGE_MCP_AUTH_TOKEN` is present in its environment.

When the extension is connected, the popup also shows a copyable auth token block (if token auth is enabled on the native server).

## Project Structure

```
webpage-mcp/
|- app/
|  |- chrome-extension/          # Chrome extension (WXT + React)
|  |  |- entrypoints/
|  |  |  |- background/          # Service worker (native host, tools, engines)
|  |  |  |- popup/               # Extension popup UI
|  |  |  |- sidepanel/           # AI agent chat sidepanel
|  |  |  |- options/             # Options page
|  |  |  |- offscreen/           # GIF encoding, keepalive
|  |  |  |- web-editor-v2/       # Visual DOM editor
|  |  |  '- shared/              # Shared composables and utilities
|  |  '- common/                 # Shared types and constants
|  '- native-server/             # Node.js native messaging host + MCP server
|     '- src/
|        |- mcp/                 # MCP server (HTTP + stdio proxy)
|        |- server/              # Fastify HTTP server + agent API
|        |- cli.ts               # CLI commands (register, doctor, report)
|        '- native-messaging-host.ts  # Chrome native messaging bridge
|- packages/
|  |- shared/                    # Shared library (tool schemas, types, constants)
|  '- wasm-simd/                 # Rust/WASM SIMD cosine similarity
'- releases/                     # Release docs and optional artifacts
```

## Development

### Quick Start

```bash
# Install dependencies
pnpm install

# Start all packages in dev mode (shared builds first, then parallel)
pnpm dev
```

### Individual Package Commands

```bash
# Chrome extension
pnpm dev:extension        # Dev mode with HMR
pnpm build:extension      # Production build

# Native server
pnpm dev:native           # Dev mode with auto-reload
pnpm build:native         # Production build

# Shared library
pnpm dev:shared           # Watch mode
pnpm build:shared         # Production build

# WASM SIMD (requires Rust toolchain)
pnpm build:wasm           # Build and copy to extension
```

### Testing

```bash
# Chrome extension tests (Vitest)
cd app/chrome-extension && pnpm test

# Native server tests (Jest)
cd app/native-server && pnpm test
```

### Linting & Formatting

```bash
pnpm lint          # Run ESLint across all packages
pnpm lint:fix      # Auto-fix lint issues
pnpm format        # Format with Prettier
pnpm typecheck     # TypeScript type checking
```

## CI/CD

This repository uses GitHub Actions workflows in `.github/workflows/`:

- `ci.yml`
  - Trigger: pushes and pull requests on `main`/`develop`
  - Runs: install, lint, typecheck (native/shared + extension), tests, build

- `release.yml`
  - Trigger: tag push `v*` and manual dispatch
  - Builds release assets:
    - Chrome extension zip (`app/chrome-extension/.output/*.zip`)
    - Native server npm tarball (`.tgz`)
    - `SHA256SUMS.txt`
  - On tag pushes, it also creates a GitHub Release and uploads the assets
  - Optional manual npm publish for `webpage-mcp` via `workflow_dispatch` input `publish_npm=true` (requires `NPM_AUTH_TOKEN` secret)

## CLI Reference

The `webpage-mcp` CLI provides the following commands:

| Command | Description |
|---|---|
| `register` | Register the Native Messaging host manifest |
| `fix-permissions` | Fix execution permissions for native host files |
| `update-port <port>` | Update stdio proxy target port in `mcp/stdio-config.json` |
| `doctor` | Diagnose installation and environment issues |
| `report` | Export a diagnostic report for troubleshooting |

### Register Options

```bash
webpage-mcp register [options]

Options:
  -f, --force              Force overwrite existing registration
  -s, --system             System-level install (requires sudo/admin)
  -b, --browser <browser>  Target browser: chrome, chromium, or all
  -d, --detect             Auto-detect installed browsers
```

## Tech Stack

| Layer | Technology |
|---|---|
| Extension framework | [WXT](https://wxt.dev/) (Vite-based) |
| Extension UI | React 18 + TailwindCSS v4 |
| Flow builder | @xyflow/react (ReactFlow) |
| Native server | Fastify v5 + @fastify/cors |
| MCP SDK | @modelcontextprotocol/sdk |
| Agent SDK | @anthropic-ai/claude-agent-sdk |
| Database | SQLite (better-sqlite3 + drizzle-orm) |
| Semantic search | @xenova/transformers (ONNX) + hnswlib-wasm |
| SIMD math | Rust/WASM (wasm-bindgen + wide) |
| GIF recording | gifenc |
| Testing | Vitest (extension), Jest (native server) |
| Package manager | pnpm workspaces |

## Troubleshooting

### Extension fails to connect

1. Ensure the native host is registered: `webpage-mcp doctor`
2. Check that Node.js >= 20 is available at the registered path
3. Try re-registering: `webpage-mcp register --force --detect`

### MCP client can't reach the server

1. Verify the server is running: `curl http://127.0.0.1:12306/ping`
2. Check if another process is using port 12306
3. If you use stdio proxy, align proxy target with server port: `webpage-mcp update-port <port>`

### Tools return errors or time out

1. Make sure Chrome is open with the extension enabled
2. Check the extension's service worker console for errors (`chrome://extensions/` > Inspect views)
3. Some tools (e.g., `chrome_network_capture`) require specific page states

### Generate a diagnostic report

```bash
webpage-mcp report --copy    # Copies to clipboard
webpage-mcp doctor --fix     # Auto-fix common issues
```

## License

MIT

## Acknowledgements

This project is based on [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome).  
Special thanks to the original author and all contributors for their foundational work.
