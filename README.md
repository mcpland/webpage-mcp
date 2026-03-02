<p align="center">
  <img src="logo.png" alt="Webpage MCP" width="160" />
</p>

<h1 align="center">Webpage MCP</h1>

<p align="center">
  <strong>Turn your webpage into a fully-featured MCP server</strong>
</p>

<p align="center">
  <a href="https://github.com/mcpland/webpage-mcp/actions/workflows/ci.yml"><img src="https://github.com/mcpland/webpage-mcp/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/webpage-mcp"><img src="https://img.shields.io/npm/v/webpage-mcp.svg" alt="npm" /></a>
  <a href="https://github.com/mcpland/webpage-mcp/releases"><img src="https://img.shields.io/github/v/release/mcpland/webpage-mcp.svg" alt="Release" /></a>
  <a href="https://github.com/mcpland/webpage-mcp/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/webpage-mcp" alt="License" /></a>
  <a href="https://github.com/mcpland/webpage-mcp/releases"><img src="https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Extension" /></a>
</p>

<p align="center">
  Let AI assistants like Claude, Cursor, Windsurf, and other <a href="https://modelcontextprotocol.io/">MCP</a>-compatible clients control your webpage — navigate pages, take screenshots, click elements, read content, capture network traffic, run JavaScript, and much more.
</p>

---

## How It Works

```
┌──────────┐     MCP stdio    ┌───────────────┐
│ AI Client├─────────────────►│   MCP Server  │
└──────────┘                  └───────┬───────┘
       Native Messaging stdin/stdout  │
                                      │
┌─────────────┐  Chrome APIs ┌────────▼────────┐
│ Your Webpage│◄─────────────┤ Chrome Extension│
└─────────────┘   DevTools   └─────────────────┘
```

The **Chrome extension** exposes real browser capabilities as MCP tools. The **MCP Server** bridges AI clients and the extension using Chrome [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). MCP clients connect over stdio only (no localhost HTTP transport).

## Core Features

|                        | Feature                       | Description                                                                                              |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| :grinning:             | **Chatbot/Model Agnostic**    | Let any LLM, chatbot client, or agent automate your browser                                              |
| :star:                 | **Use Your Original Browser** | Seamlessly integrate with your existing browser environment (configs, login states, etc.)                |
| :computer:             | **Fully Local**               | Pure local MCP server ensuring user privacy                                                              |
| :electric_plug:        | **Native Stdio Transport**    | Native Messaging + stdio only (no localhost HTTP port)                                                   |
| :racing_car:           | **Cross-Tab**                 | Cross-tab context support                                                                                |
| :brain:                | **Semantic Search**           | Built-in vector database for intelligent browser tab content discovery                                   |
| :mag:                  | **Smart Content Analysis**    | AI-powered text extraction and similarity matching                                                       |
| :globe_with_meridians: | **20+ Tools**                 | Screenshots, network monitoring, interactive operations, bookmark management, browsing history, and more |
| :rocket:               | **SIMD-Accelerated AI**       | Custom WebAssembly SIMD optimization for 4-8x faster vector operations                                   |

## Comparison with Similar Projects

| Dimension                  | Playwright-based MCP Server                                    | Chrome Extension-based MCP Server                                |
| -------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| **First-time Setup**       | :white_check_mark: Usually simpler: install & run              | :warning: Requires one-time Native Messaging host registration   |
| **Resource Usage**         | :x: Launches a separate automation browser                     | :white_check_mark: Reuses the user's already-open Chrome         |
| **User Session Reuse**     | :x: Often requires separate login/state management             | :white_check_mark: Reuses existing profile session/cookies       |
| **Real-user Environment**  | :warning: Automation-oriented environment                      | :white_check_mark: Real user profile, settings, extensions, tabs |
| **API Access Surface**     | :warning: Constrained by Playwright API boundaries             | :white_check_mark: Chrome extension platform + native APIs       |
| **CI / Headless Fit**      | :white_check_mark: Strong fit for CI and headless workflows    | :warning: Better suited for local interactive workflows          |
| **Determinism**            | :white_check_mark: Stronger reproducibility in controlled runs | :warning: Affected by live user environment/state                |
| **Startup Latency**        | :x: Needs browser automation bootstrap                         | :white_check_mark: Mainly extension/native bridge activation     |
| **Request Overhead**       | :warning: Extra orchestration adds overhead                    | :white_check_mark: Lower overhead in long-lived local sessions   |
| **Post-setup Reliability** | :warning: More moving parts can increase failure surface       | :white_check_mark: One-time registration; stable across restarts |

## MCP Browser Tools

| Tool                               | Description                                                             |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `get_windows_and_tabs`             | Get all open browser windows and tabs                                   |
| `chrome_navigate`                  | Navigate to a URL, refresh, or navigate history (back/forward)          |
| `chrome_screenshot`                | Take a screenshot of the page or a specific element                     |
| `chrome_read_page`                 | Get an accessibility tree of visible elements on the page               |
| `chrome_computer`                  | Mouse and keyboard interaction with the browser (computer use)          |
| `chrome_click_element`             | Click elements via CSS selector, XPath, element ref, or coordinates     |
| `chrome_fill_or_select`            | Fill or select form elements (input, textarea, select, checkbox, radio) |
| `chrome_keyboard`                  | Simulate keyboard input (keys, combinations, or text)                   |
| `chrome_javascript`                | Execute JavaScript code in a browser tab                                |
| `chrome_get_web_content`           | Fetch and parse web page content                                        |
| `chrome_network_request`           | Send network requests from the browser context (with cookies)           |
| `chrome_network_capture`           | Capture network requests (start/stop, optional response bodies via CDP) |
| `chrome_console`                   | Capture console output (snapshot or persistent buffer mode)             |
| `chrome_history`                   | Search and retrieve browsing history                                    |
| `chrome_bookmark_search`           | Search bookmarks by title and URL                                       |
| `chrome_bookmark_add`              | Add a new bookmark                                                      |
| `chrome_bookmark_delete`           | Delete a bookmark                                                       |
| `chrome_switch_tab`                | Switch to a specific tab                                                |
| `chrome_close_tabs`                | Close one or more tabs                                                  |
| `chrome_upload_file`               | Upload files to web forms via CDP                                       |
| `chrome_handle_dialog`             | Handle JavaScript dialogs (alert/confirm/prompt)                        |
| `chrome_handle_download`           | Wait for and retrieve download details                                  |
| `chrome_request_element_selection` | Let the user manually select elements on the page                       |
| `chrome_gif_recorder`              | Record browser activity as an animated GIF                              |
| `performance_start_trace`          | Start a performance trace recording                                     |
| `performance_stop_trace`           | Stop the active performance trace                                       |
| `performance_analyze_insight`      | Get a lightweight summary of the last recorded trace                    |

## Additional Capabilities

- **AI Agent Chat Sidepanel** — Built-in sidepanel for chatting with AI agents (Claude Code CLI, OpenAI Codex CLI) directly from Chrome, with project management, session history, and streaming output
- **Record & Replay** — Record browser actions and replay them as automated flows; published flows are exposed as dynamic MCP tools (`flow.<slug>`)
- **Web Editor** — Visual in-page DOM editor overlay with property panel and transaction system (`Cmd+Shift+O`)
- **Quick Panel** — Keyboard-triggered floating AI chat accessible from any page (`Cmd+Shift+U`)
- **Semantic Search** — On-device embedding model ([all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)) with HNSW vector index for searching tab content
- **Element Marker** — Annotate DOM elements with names/selectors, accessible to AI tools via context menu

---

## Installation

### Prerequisites

- **Chrome** (or Chromium-based browser)
- **Node.js** >= 20.0.0
- **pnpm** (only needed when building from source)

### Quick Start (Published npm Package)

**1.** Install the Chrome extension first (store package or unpacked build).

**2.** Open extension `welcome.html` or popup and copy the one-time registration command (it already includes the current extension ID), then run it in terminal:

```bash
npx -y webpage-mcp@latest register --browser chrome --force --extension-id <extension_id_from_popup_or_welcome>
```

> `--force` in the generated command is optional (registration is currently idempotent).

**3.** Run one command to auto-fix common setup issues (permissions, node path, registration):

```bash
npx -y webpage-mcp@latest doctor --fix
```

**4.** Add `webpage-mcp` to your MCP client config:

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

**5.** Open Chrome, click the extension popup **Connect** button once, then restart your MCP client.

<details>
<summary><strong>When do I need to re-register?</strong></summary>

Registration is typically one-time per machine/profile. You do **not** need to re-run it for normal restarts (OS/Chrome/MCP client). Re-run only when:

- Extension ID changes
- Manifest path changes
- Installation path changes
- Chrome profile data is reset

</details>

### Build From Source (Developers)

<details>
<summary><strong>Click to expand</strong></summary>

#### 1. Clone and Build

```bash
git clone https://github.com/mcpland/webpage-mcp.git
cd webpage-mcp

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

#### 2. Install the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `app/chrome-extension/.output/chrome-mv3` folder

> This repository does not currently commit binary release zip files. To generate one locally, run `pnpm --filter webpage-mcp-server zip` and use the artifact from `app/chrome-extension/.output/`.

#### 3. Register the Native Messaging Host

```bash
# From repo root, use the built local CLI entry
node app/native-server/dist/cli.js register --detect

# Or specify the browser explicitly
node app/native-server/dist/cli.js register --browser chrome
```

This places a JSON manifest in Chrome's `NativeMessagingHosts/` directory so the browser can launch the MCP server process.

#### 4. Verify Installation

```bash
# Diagnose installation issues
node app/native-server/dist/cli.js doctor

# Generate a full diagnostic report
node app/native-server/dist/cli.js report
```

Open Chrome and click the extension icon — it should show a connected status.

</details>

---

## Configuration

### Connecting AI Clients

Use stdio transport via `npx`:

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

### Claude Desktop Configuration

Add to your Claude Desktop MCP config (`claude_desktop_config.json`) — use the same `npx` stdio config above.

### Local Absolute Path (Dev)

<details>
<summary><strong>Click to expand</strong></summary>

For local development, you can point MCP directly to the built stdio entry:

```json
{
  "mcpServers": {
    "webpage-mcp-local": {
      "command": "node",
      "args": [
        "/Users/your-user/path/to/webpage-mcp/app/native-server/dist/mcp/mcp-server-stdio.js"
      ]
    }
  }
}
```

Important:

- This stdio process still depends on the native bridge socket created by the Chrome Native host.
- Keep Chrome open and ensure the extension is connected to native host.
- Default bridge socket path (macOS/Linux): `~/.webpage-mcp/native-<uid>.sock`.
- If you customized `WEBPAGE_MCP_NATIVE_SOCKET`, both processes must use the same value.

</details>

### Notes

- The current architecture is fully native/stdio and does not expose localhost MCP/agent HTTP endpoints.
- Multiple instances are identified by `instanceId`; data transport is native/stdio only.
- For `npx` usage, keep `-p webpage-mcp@latest` in args so `webpage-mcp-stdio` resolves as the executed bin.

---

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

# MCP server
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

# MCP server tests (Jest)
cd app/native-server && pnpm test
```

### Linting & Formatting

```bash
pnpm lint          # Run ESLint across all packages
pnpm lint:fix      # Auto-fix lint issues
pnpm format        # Format with Prettier
pnpm typecheck     # TypeScript type checking
```

---

## CLI Reference

| Command           | Description                                     |
| ----------------- | ----------------------------------------------- |
| `register`        | Register the Native Messaging host manifest     |
| `fix-permissions` | Fix execution permissions for native host files |
| `doctor`          | Diagnose installation and environment issues    |
| `report`          | Export a diagnostic report for troubleshooting  |

### Register Options

```bash
npx -y webpage-mcp@latest register [options]

Options:
  -f, --force              Compatibility flag (accepted; registration is currently idempotent)
  -s, --system             System-level install (requires sudo/admin)
  -b, --browser <browser>  Target browser: chrome, chromium, or all
  -d, --detect             Auto-detect installed browsers
  -e, --extension-id <id>  Override extension ID(s) for allowed_origins (comma-separated)
```

<details>
<summary><strong>Additional registration details</strong></summary>

When `--browser chrome` is used, the installer also writes channel-compatible manifests on macOS/Linux (for example Chrome Stable/Beta/Canary/Chrome for Testing paths) to reduce "native host not found" channel mismatch issues. The installer also attempts to discover local unpacked Webpage MCP extension IDs from browser profiles and add them to `allowed_origins`.

For unpacked extensions with a custom ID, you can re-register with:

```bash
npx -y webpage-mcp@latest register --browser chrome --extension-id <your_extension_id>
```

The extension popup and welcome page can generate this command automatically using `chrome.runtime.id`, which avoids manual ID lookup mistakes. The generated command may include `--force`; this flag is optional.

</details>

---

## Tech Stack

| Layer               | Technology                                 |
| ------------------- | ------------------------------------------ |
| Extension framework | [WXT](https://wxt.dev/) (Vite-based)       |
| Extension UI        | React 18 + TailwindCSS v4                  |
| Flow builder        | @xyflow/react (ReactFlow)                  |
| MCP server          | Node.js Native Messaging + local IPC       |
| MCP SDK             | @modelcontextprotocol/sdk                  |
| Agent SDK           | @anthropic-ai/claude-agent-sdk             |
| Database            | SQLite (better-sqlite3 + drizzle-orm)      |
| Semantic search     | @xenova/transformers (ONNX) + hnswlib-wasm |
| SIMD math           | Rust/WASM (wasm-bindgen + wide)            |
| GIF recording       | gifenc                                     |
| Testing             | Vitest (extension), Jest (MCP server)      |
| Package manager     | pnpm workspaces                            |

---

## Troubleshooting

<details>
<summary><strong>Extension fails to connect</strong></summary>

1. Ensure the native host is registered: `npx -y webpage-mcp@latest doctor`
2. Check that Node.js >= 20 is available at the registered path
3. Prefer the exact register command generated in extension popup/welcome and run it once
4. Fully restart Chrome (quit all Chrome processes), then click Connect again

</details>

<details>
<summary><strong>MCP client can't reach the server</strong></summary>

1. Ensure Chrome is open and the extension is enabled
2. Ensure native host is connected (`npx -y webpage-mcp@latest doctor`)
3. Use npx stdio config in your MCP client (`command: "npx"`, `args: ["-y", "-p", "webpage-mcp@latest", "webpage-mcp-stdio"]`)

</details>

<details>
<summary><strong>Tools return errors or time out</strong></summary>

1. Make sure Chrome is open with the extension enabled
2. Check the extension's service worker console for errors (`chrome://extensions/` > Inspect views)
3. Some tools (e.g., `chrome_network_capture`) require specific page states

</details>

<details>
<summary><strong>Generate a diagnostic report</strong></summary>

```bash
npx -y webpage-mcp@latest report --copy    # Copies to clipboard
npx -y webpage-mcp@latest doctor --fix     # Auto-fix common issues
```

</details>

---

## CI/CD

<details>
<summary><strong>GitHub Actions workflows</strong></summary>

**`ci.yml`**

- Trigger: pushes and pull requests on `main`/`develop`
- Runs: install, lint, typecheck (native/shared + extension), tests, build

**`release.yml`**

- Trigger: tag push `v*` and manual dispatch
- Builds release assets:
  - Chrome extension zip (`app/chrome-extension/.output/*.zip`)
  - MCP server npm tarball (`.tgz`)
  - `SHA256SUMS.txt`
- On tag pushes, creates a GitHub Release and uploads assets
- On tag pushes (`v*`), publishes `webpage-mcp` to npm (requires `NPM_AUTH_TOKEN` secret)
- Manual npm publish available via `workflow_dispatch` with `publish_npm=true`

</details>

---

## License

MIT

## Acknowledgements

This project is based on [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome). Special thanks to the original author and all contributors for their foundational work.
