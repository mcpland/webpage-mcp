---
type: repo-overview
title: Webpage MCP
description: Browser-native MCP server, Chrome connector, workflows, and local Agent tooling.
owner: NEEDS_OWNER
status: proposed
tags: [mcp, chrome-extension, browser-automation]
---

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
  <a href="https://chromewebstore.google.com/detail/webpage-mcp-connector/iehgbogeakiedihodennfcnigojnncag?hl=en"><img src="https://img.shields.io/github/v/release/mcpland/webpage-mcp.svg" alt="Release" /></a>
  <a href="https://github.com/mcpland/webpage-mcp/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/webpage-mcp" alt="License" /></a>
  <a href="https://chromewebstore.google.com/detail/webpage-mcp-connector/iehgbogeakiedihodennfcnigojnncag?hl=en"><img src="https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Extension" /></a>
</p>

<p align="center">
  Let AI assistants like Claude, Cursor, Windsurf, Codex, and other <a href="https://modelcontextprotocol.io/">MCP</a>-compatible clients control your webpage — navigate pages, take screenshots, click elements, read content, capture network traffic, run JavaScript, and much more.
</p>

---

## How It Works

```
┌──────────┐     MCP stdio    ┌───────────────┐
│ AI Client├─────────────────►│   MCP Server  │
└──────────┘                  └───────┬───────┘
       Native Messaging stdin/stdout  │
                                      │
┌─────────────┐  Chrome APIs ┌────────▼───────┐
│ Your Webpage│◄─────────────┤  MCP Connector │
└─────────────┘   DevTools   └────────────────┘
```

The **Webpage MCP Connector** (Chrome extension) exposes real browser capabilities as MCP tools. The **MCP Server** bridges AI clients and the connector using Chrome [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). MCP clients connect over stdio only (no localhost HTTP transport).

Webpage MCP is best understood as a browser-native workflow layer for Chrome, not just a page-control bridge. Recent Chrome releases have made [Chrome DevTools MCP capable of connecting to active browser sessions](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session), which makes protocol-level control of existing tabs much easier. Webpage MCP complements that model by focusing on what DevTools MCP does not try to be: Chrome extension APIs, saved workflows, in-browser operator UI, semantic cross-tab memory, and page-to-code editing flows.

## Privacy and Data Flows

[Read the full Webpage MCP Privacy Policy](PRIVACY.md) before connecting an MCP
client, enabling Agent features, or using the extension on sensitive pages.

Webpage MCP has no hosted Webpage MCP relay: the extension-to-native-host bridge and MCP transport stay on the local machine. That local transport boundary does **not** mean all data processed through the product always stays local. Browser content can leave the machine when a connected AI client, a configured Agent engine, a browser/network tool, or the semantic-model downloader contacts an external service.

| Surface                                                 | Data that may be processed                                                                                                   | Destination and trigger                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP browser tools                                       | Page text, accessibility data, screenshots, console/network data, history, bookmarks, files, and tool results                | Sent over the local bridge to the connected MCP client when a tool is invoked. The client may then send that data to its configured model provider under that provider's retention and privacy terms.                                                                  |
| Quick Panel and Web Editor Agent                        | The instruction plus relevant page URL, selected text, element metadata, screenshots/attachments, or structured edit context | Passed through the native host to the user-selected Claude or Codex engine when the user starts an Agent action. Those engines may call Anthropic, OpenAI, or a configured compatible endpoint; their own authentication, network, and retention policies apply.       |
| Semantic search                                         | Indexed tab text and generated embeddings                                                                                    | Inference and the vector index run locally. On first use, pinned model artifacts are downloaded from Hugging Face and cached after size and SHA-256 verification; tab content is not uploaded to Hugging Face for embedding inference.                                 |
| Navigation, requests, workflows, uploads, and downloads | URLs, request bodies, files, cookies available to the browser context, and workflow inputs                                   | Sent to the requested website or endpoint when the corresponding tool/workflow runs. These operations can have real external side effects.                                                                                                                             |
| Local persistence and diagnostics                       | Agent projects, sessions, messages, image attachments, extension IndexedDB/Cache Storage, and bounded native-host logs       | Stored locally in the Chrome profile and, by default, under `~/.webpage-mcp-agent` plus the platform log directory. A generated diagnostic report can include redacted log excerpts; review it before sharing and use `--include-logs none` when logs are unnecessary. |

The extension requests broad capabilities including `<all_urls>`, `history`, `bookmarks`, `debugger`, `webRequest`, `downloads`, `scripting`, and `userScripts` because its advertised tools operate across the user's live browser profile. The `userScripts` permission runs scripts entered locally in the extension UI and places the privileged Web Editor runtime in a dedicated Chrome execution world so ordinary content scripts cannot impersonate it. Chrome requires the separate **Allow User Scripts** extension toggle described below for those features. Treat an enabled MCP client or Agent session as a privileged browser operator: use trusted clients/providers, keep Agent sandbox/permission settings constrained, avoid sensitive pages when the task does not require them, and inspect high-impact workflow actions before running them.

### Privacy verification

- Permissions and host access are owned by [`wxt.config.ts`](app/chrome-extension/wxt.config.ts); changes are visible in the generated manifest during release verification.
- Quick Panel context forwarding and resource bounds are covered by [`quick-panel-agent-handler.test.ts`](app/chrome-extension/tests/background/quick-panel-agent-handler.test.ts) and [`quick-panel-agent-bounds.test.ts`](app/chrome-extension/tests/background/quick-panel-agent-bounds.test.ts).
- Remote model provenance, integrity, and cache policy are covered by [`model-asset-integrity.test.ts`](app/chrome-extension/tests/security/model-asset-integrity.test.ts) and [`model-cache-manager-security.test.ts`](app/chrome-extension/tests/utils/model-cache-manager-security.test.ts).
- Private native Agent storage and log redaction boundaries are covered by [`storage-permissions.test.ts`](app/mcp-server/src/agent/storage-permissions.test.ts) and [`claude-secret-logging.test.ts`](app/mcp-server/src/agent/engines/claude-secret-logging.test.ts).

## Core Features

|                         | Feature                       | Description                                                                                                                              |
| ----------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| :grinning:              | **Chatbot/Model Agnostic**    | Let any LLM, chatbot client, or agent automate your browser                                                                              |
| :star:                  | **Use Your Original Browser** | Seamlessly integrate with your existing browser environment (configs, login states, etc.)                                                |
| :computer:              | **Local Bridge and Storage**  | Native/stdio transport and product-owned state stay local; configured AI providers and explicit network tools remain external data flows |
| :electric_plug:         | **Native Stdio Transport**    | Native Messaging + stdio only (no localhost HTTP port)                                                                                   |
| :racing_car:            | **Cross-Tab**                 | Cross-tab context support                                                                                                                |
| :control_knobs:         | **Workflow Runtime**          | Record, publish, trigger, and replay flows; expose saved browser workflows as MCP tools                                                  |
| :speech_balloon:        | **In-Browser Agent UX**       | Built-in sidepanel, Quick Panel, element picker, and workflow views keep the agent inside Chrome                                         |
| :building_construction: | **Apply-to-Code Web Editor**  | Visual in-page editing with transactions, undo/redo, and structured apply payloads for coding agents                                     |
| :brain:                 | **Semantic Search**           | Built-in vector database for intelligent browser tab content discovery                                                                   |
| :mag:                   | **Smart Content Analysis**    | AI-powered text extraction and similarity matching                                                                                       |
| :globe_with_meridians:  | **20+ Tools**                 | Screenshots, network monitoring, interactive operations, bookmark management, browsing history, and more                                 |
| :rocket:                | **SIMD Vector Math**          | Custom WebAssembly SIMD vector operations with reproducible artifacts and numerical correctness checks                                   |

## Comparison with Similar Projects

### Playwright-based MCP Servers

| Dimension                    | Playwright-based MCP Server                                    | Webpage MCP Connector + MCP Server                                                              |
| ---------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **First-time Setup**         | :white_check_mark: Usually simpler: install & run              | :white_check_mark: Usually install + configure; manual register is fallback                     |
| **Bootstrap / Self-healing** | :warning: Failures often require manual environment fixes      | :white_check_mark: Startup silent bootstrap (manifest/runtime check + auto user-level register) |
| **Resource Usage**           | :x: Launches a separate automation browser                     | :white_check_mark: Reuses the user's already-open Chrome                                        |
| **User Session Reuse**       | :x: Often requires separate login/state management             | :white_check_mark: Reuses existing profile session/cookies                                      |
| **Real-user Environment**    | :warning: Automation-oriented environment                      | :white_check_mark: Real user profile, settings, extensions, tabs                                |
| **API Access Surface**       | :warning: Constrained by Playwright API boundaries             | :white_check_mark: Chrome extension platform + native APIs                                      |
| **CI / Headless Fit**        | :white_check_mark: Strong fit for CI and headless workflows    | :warning: Better suited for local interactive workflows                                         |
| **Determinism**              | :white_check_mark: Stronger reproducibility in controlled runs | :warning: Affected by live user environment/state                                               |
| **Startup Latency**          | :x: Needs browser automation bootstrap                         | :white_check_mark: Mainly extension/native bridge activation                                    |
| **Request Overhead**         | :warning: Extra orchestration adds overhead                    | :white_check_mark: Lower overhead in long-lived local sessions                                  |
| **Post-setup Reliability**   | :warning: More moving parts can increase failure surface       | :white_check_mark: One-time registration; stable across restarts                                |

### Chrome DevTools MCP

Chrome DevTools MCP is an excellent choice when your primary goal is protocol-level debugging of an already-open browser session. Webpage MCP is most valuable one layer above that: browser-native workflows, persistent local automation, and Chrome extension APIs that CDP alone does not cover well.

| Dimension                    | Chrome DevTools MCP                                                                | Webpage MCP Connector + MCP Server                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Primary Strength**         | DevTools- and CDP-centric debugging, inspection, tracing, and performance analysis | Browser-native workflow automation, operator UX, and persistent local browser tooling                    |
| **Existing Browser Session** | :white_check_mark: Strong fit for active browser sessions                          | :white_check_mark: Strong fit for the user's real Chrome profile and tabs                                |
| **Chrome-Native APIs**       | :warning: Mostly limited to DevTools / CDP surfaces                                | :white_check_mark: Extension APIs such as bookmarks, history, sidepanel, context menus, alarms, and more |
| **Saved Workflows**          | :warning: Not the main product surface                                             | :white_check_mark: Built-in record/replay, publishing, dynamic tools, and reusable flow variables        |
| **Triggers and Scheduling**  | :warning: Typically external orchestration                                         | :white_check_mark: Built-in manual, URL, DOM, interval, once, command, and context-menu triggers         |
| **In-Browser UX**            | :warning: Usually operated from an external agent or CLI                           | :white_check_mark: Built-in sidepanel, Quick Panel, workflow views, and page-level pickers               |
| **Cross-Tab Memory**         | :warning: Not a built-in focus                                                     | :white_check_mark: Built-in semantic indexing and search across live tabs                                |
| **Visual Editing**           | :warning: Not a built-in focus                                                     | :white_check_mark: Web Editor with transactions, undo/redo, and apply-to-code payloads                   |
| **Best Fit**                 | Debugging pages, network, console, performance, and memory                         | Turning Chrome into a persistent local automation workspace for agents and human operators               |

### Best Used Together

A strong local setup is to use Chrome DevTools MCP as the debugging engine and Webpage MCP as the browser-native workflow layer. DevTools MCP can own deep protocol inspection, while Webpage MCP owns browser-native APIs, saved automations, in-browser UI, and page-to-code workflows.

## Installation

### Quick Start

**1.** Install the **Webpage MCP Connector** Chrome extension first in chrome web store. [https://chromewebstore.google.com/detail/webpage-mcp-connector/iehgbogeakiedihodennfcnigojnncag?hl=en](https://chromewebstore.google.com/detail/webpage-mcp-connector/iehgbogeakiedihodennfcnigojnncag?hl=en).

**2.** Add `webpage-mcp` to your MCP client config:

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

**3.** Start your MCP client (with Chrome open and extension enabled).

`webpage-mcp-stdio` now performs silent bootstrap on startup: it checks Native Messaging manifest/runtime and auto-registers user-level host when needed.

The Webpage MCP Connector as a whole requires Chrome 135 or newer; releases cannot be installed on older Chrome versions. The user-script manager and Web Editor have an additional browser toggle: in Chrome 135–137, enable **Developer mode** on `chrome://extensions`; in Chrome 138 or newer, open the extension's Details page and enable **Allow User Scripts** before using those features.

**4.** If extension still cannot connect, use fallback recovery:

1. Open extension `welcome.html` or popup and copy the register command (already includes current extension ID), then run it:

```bash
npx -y webpage-mcp@latest register --browser chrome --force --extension-id <extension_id_from_popup_or_welcome>
```

2. Run one-shot auto-fix:

```bash
npx -y webpage-mcp@latest doctor --fix
```

3. Use the extension popup status refresh button once to reconnect and sync status, then restart MCP client.

<details>
<summary><strong>When do I need to re-register?</strong></summary>

For most users, manual registration is not required because startup bootstrap handles it automatically.

If you did run manual registration, it is typically one-time per machine/profile. You do **not** need to re-run it for normal restarts (OS/Chrome/MCP client). Re-run only when:

- Extension ID changes
- Manifest path changes
- Installation path changes
- Chrome profile data is reset

</details>

### Version Compatibility

The Chrome extension and the `webpage-mcp` npm package are built and released from the same CI pipeline, but Chrome Web Store review and rollout timing is not fixed. This means the latest npm package may be available before the matching Chrome extension version reaches users.

We aim to keep nearby versions compatible. If you run into connection, protocol, or tool behavior issues, first make sure the Chrome extension and the MCP npm package use the same version for the best compatibility.

### Build From Source (Developers)

<details>
<summary><strong>Click to expand</strong></summary>

#### 1. Clone and Build

```bash
git clone https://github.com/mcpland/webpage-mcp.git
cd webpage-mcp

# Activate and install the exact pnpm release pinned by package.json
corepack enable
corepack install

# Install the committed dependency graph
pnpm install --frozen-lockfile

# Build all packages
pnpm build
```

#### 2. Install the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `app/chrome-extension/.output/chrome-mv3` folder

> This repository does not currently commit binary release zip files. To generate one locally, run `pnpm --filter webpage-mcp-connector zip` and use the artifact from `app/chrome-extension/.output/`.

#### 3. Start MCP Client First

Use the local stdio entry in your MCP client config (example below). On startup, `mcp-server-stdio` will attempt silent bootstrap (manifest/runtime check + user-level auto-register).

#### 4. Fallback: Manual Register (Only If Needed)

If the extension still cannot connect, run:

```bash
# From repo root, use the built local CLI entry
node app/mcp-server/dist/cli.js register --detect

# Or specify browser/extension id explicitly
node app/mcp-server/dist/cli.js register --browser chrome --extension-id <your_extension_id>
```

This writes/updates the JSON manifest in Chrome's `NativeMessagingHosts/` directory so Chrome can launch the MCP server process.

#### 5. Verify Installation

```bash
# Diagnose installation issues
node app/mcp-server/dist/cli.js doctor

# Generate a full diagnostic report
node app/mcp-server/dist/cli.js report
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

### Codex Configuration

Codex stores MCP configuration in `~/.codex/config.toml` by default. You can also use a project-local `.codex/config.toml` when the server should only be enabled for one repository.

Add `webpage-mcp` with a `[mcp_servers.<server-name>]` TOML table:

```toml
[mcp_servers."webpage-mcp"]
command = "npx"
args = ["-y", "-p", "webpage-mcp@latest", "webpage-mcp-stdio"]
```

`command` is required. `args` is optional and should be an array when used.

You can also add it with Codex CLI:

```bash
codex mcp add webpage-mcp -- npx -y -p webpage-mcp@latest webpage-mcp-stdio
```

After adding the server, restart Codex if needed and use `/mcp` in the Codex TUI to confirm `webpage-mcp` is enabled.

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
        "/Users/your-user/path/to/webpage-mcp/app/mcp-server/dist/mcp/mcp-server-stdio.js"
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

## MCP Browser Tools

| Tool                               | Description                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `get_windows_and_tabs`             | Get all open browser windows and tabs                                                     |
| `chrome_navigate`                  | Navigate the current tab or open a URL in a new tab/window; also supports refresh/history |
| `chrome_screenshot`                | Take a screenshot of the page or a specific element                                       |
| `chrome_read_page`                 | Get an accessibility tree of visible elements on the page                                 |
| `chrome_computer`                  | Mouse and keyboard interaction with the browser (computer use)                            |
| `chrome_click_element`             | Click elements via CSS selector, XPath, element ref, or coordinates                       |
| `chrome_fill_or_select`            | Fill or select form elements (input, textarea, select, checkbox, radio)                   |
| `chrome_keyboard`                  | Simulate keyboard input (keys, combinations, or text)                                     |
| `chrome_javascript`                | Execute JavaScript code in a browser tab                                                  |
| `chrome_get_web_content`           | Fetch and parse web page content                                                          |
| `chrome_network_request`           | Send network requests from the browser context (with cookies)                             |
| `chrome_network_capture`           | Capture network requests (start/stop, optional response bodies via CDP)                   |
| `chrome_console`                   | Capture console output (snapshot or persistent buffer mode)                               |
| `chrome_history`                   | Search and retrieve browsing history                                                      |
| `chrome_bookmark_search`           | Search bookmarks by title and URL                                                         |
| `chrome_bookmark_add`              | Add a new bookmark                                                                        |
| `chrome_bookmark_delete`           | Delete a bookmark                                                                         |
| `chrome_switch_tab`                | Switch to a specific tab                                                                  |
| `chrome_close_tabs`                | Close one or more tabs                                                                    |
| `chrome_upload_file`               | Upload files to web forms via CDP                                                         |
| `chrome_handle_dialog`             | Handle JavaScript dialogs (alert/confirm/prompt)                                          |
| `chrome_handle_download`           | Wait for and retrieve download details                                                    |
| `chrome_request_element_selection` | Let the user manually select elements on the page                                         |
| `chrome_gif_recorder`              | Record browser activity as an animated GIF                                                |
| `performance_start_trace`          | Start a performance trace recording                                                       |
| `performance_stop_trace`           | Stop the active performance trace                                                         |
| `performance_analyze_insight`      | Get a lightweight summary of the last recorded trace                                      |

## Additional Capabilities

- **Agent Setup Sidepanel** — Select the workspace and Agent session used by Quick Panel and Web Editor; new Claude and Codex sessions use constrained defaults, while bypass/full-access modes require an explicit risk confirmation
- **Record, Replay, and Publish** — Record browser actions, replay them as automated flows, publish reusable flows, and expose them as dynamic MCP tools (`flow.<slug>`)
- **Triggerable Browser Workflows** — Launch flows from URL matches, DOM appearance, intervals, one-time schedules, keyboard commands, and context-menu actions
- **Web Editor** — Visual in-page DOM editor overlay with a property panel, transaction system, undo/redo, and structured apply-to-code handoff (`Cmd+Shift+E`)
- **Quick Panel** — Keyboard-triggered floating AI chat accessible from any page, with page context and streaming responses (`Cmd+Shift+U`)
- **Semantic Search** — On-device [multilingual E5](https://huggingface.co/Xenova/multilingual-e5-small) embeddings with an HNSW vector index for searching tab content across live browser state. Remote tokenizer and model URLs use immutable Hugging Face commit revisions; downloaded ONNX binaries must also match the checked-in size and SHA-256 manifest before they are cached for offline reuse.
- **Element Marker** — Annotate DOM elements with stable names/selectors so agents and workflows can refer to page targets more reliably

---

## Development

### Quick Start

The root `packageManager` contract pins both pnpm 10.34.5 and its registry
SHA-512 digest. Use Corepack so local installs honor the same reviewed package
manager bytes as CI.

```bash
# Activate the repository-pinned pnpm and install dependencies
corepack enable
corepack install
pnpm install --frozen-lockfile

# Start all packages in dev mode (shared builds first, then parallel)
pnpm dev
```

### Individual Package Commands

```bash
# Chrome extension
pnpm dev:extension        # Dev mode with HMR
pnpm build:extension      # Production build

# MCP server
pnpm dev:mcp              # Dev mode with auto-reload
pnpm build:mcp            # Production build

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

# MCP server tests (Vitest)
cd app/mcp-server && pnpm test
```

### Linting & Formatting

```bash
pnpm lint          # Run ESLint across all packages
pnpm lint:fix      # Auto-fix lint issues
pnpm format        # Format with Prettier
pnpm typecheck     # TypeScript type checking
```

### Dependency License Inventory

`pnpm legal:check` verifies the committed, full production npm closures against
the frozen pnpm graph and lockfile without using the network. It also checks
locally available package metadata and license evidence, the exact Cargo notice
closure, and the reviewed legal-file digests.

After an intentional dependency or lockfile change, refresh the inventories
with `node scripts/legal-notices.mjs refresh`. Refresh downloads registry
tarballs without running dependency lifecycle scripts and accepts evidence only
after the complete tarball matches the lockfile SHA-512 integrity. Review the
resulting `THIRD_PARTY_COMPONENTS.json` files and notice changes before
committing them.

The machine-readable inventories describe production install/build inputs;
they do not assert that every component is emitted into a bundle. The release
artifacts include those inventories byte-for-byte. Human-readable
`THIRD_PARTY_NOTICES.md` files summarize distribution boundaries, while the
extension's `THIRD_PARTY_LICENSES.txt` covers emitted or vendored code and its
attributions.

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

When `--browser chrome` is used, the installer also writes channel-compatible manifests on macOS/Linux (for example Chrome Stable/Beta/Canary/Chrome for Testing paths) to reduce "native host not found" channel mismatch issues. The installer also attempts to discover local unpacked Webpage MCP Connector extension IDs from browser profiles and add them to `allowed_origins`.

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
| Testing             | Vitest                                     |
| Package manager     | pnpm workspaces                            |

---

## Troubleshooting

<details>
<summary><strong>Extension fails to connect</strong></summary>

1. Ensure the native host is registered: `npx -y webpage-mcp@latest doctor`
2. Check that Node.js >= 22 is available at the registered path (Node.js 24 LTS recommended)
3. Check that the Chrome extension and `webpage-mcp` npm package versions match, especially after a fresh npm release
4. Prefer the exact register command generated in extension popup/welcome and run it once
5. Fully restart Chrome (quit all Chrome processes), then click Connect again

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

Chrome Web Store submission and rollout are manual external steps. Before every
upload, review submission, or rollout, complete the
[Chrome Web Store release and privacy checklist](docs/CHROME_WEB_STORE_RELEASE.md);
the repository workflow does not validate Developer Dashboard fields or the
live store listing.

<details>
<summary><strong>GitHub Actions workflows</strong></summary>

**`ci.yml`**

- Trigger: pushes and pull requests on `main`/`develop`
- Runs: frozen install, production npm and Rust advisory gates, lint,
  typecheck (mcp/shared + extension), tests, build

**`dependency-security.yml`**

- Trigger: daily at 04:17 UTC and manual dispatch
- Audits the committed production pnpm and Cargo lockfile graphs without
  installing project dependencies or executing dependency lifecycle scripts
- Uses the same fail-closed npm and Rust advisory checks as CI and release, so
  newly disclosed advisories are detected even when source code is unchanged

The Rust gate installs the Linux x64 musl `cargo-deny` binary described by
`scripts/cargo-deny-tool.json`. The installer accepts only GitHub's fixed HTTPS
release-asset redirect, streams into a bounded temporary file, verifies both
the archive and extracted executable by exact byte count and SHA-256, installs
mode `0755` atomically, and probes the pinned version through an absolute path.
The workflow first validates the Cargo graph with `cargo metadata --locked`,
then runs `cargo-deny` without its `--locked`/`--offline` flags so the RustSec
database is refreshed on every gate; download, refresh, and scan failures remain
fatal.

Dependabot checks GitHub Actions, the root pnpm workspace, and the Rust/WASM
crate weekly. Live advisory databases can make an unchanged commit fail a
subsequent CI or release run; resolve or explicitly review the advisory rather
than weakening the gate.

**`release.yml`**

- Trigger: tag push `v*` and manual dispatch. A branch dispatch with
  `publish_npm=false` remains available as a build-only release dry run.
- Before artifact construction, the workflow binds the event to one immutable
  commit SHA and requires Linux, Windows, and macOS gates on that exact commit.
  Every gate performs a frozen workspace install, typechecks, tests, builds,
  and exchanges a native-message ping/pong through the built platform wrapper.
  Production npm and Rust advisory checks and coverage are collected only by
  the Linux gate rather than repeated on all three operating systems.
- Unified releases accept stable `x.y.z` versions only. Prerelease (`-rc.1`, `-beta.1`) and build-metadata (`+build.1`) versions are rejected before any artifact or publish step because Chrome's update version is numeric and must stay aligned with the npm package version.
- Builds release assets:
  - Chrome extension zip (`app/chrome-extension/.output/webpage-mcp-connector-<version>-chrome-extension.zip`)
  - MCP server npm tarball (`.tgz`)
  - `SHA256SUMS.txt`
- Verifies that each artifact contains the reviewed `LICENSE`,
  `THIRD_PARTY_NOTICES.md`, and `THIRD_PARTY_COMPONENTS.json` bytes; the
  extension ZIP must also contain its reviewed `THIRD_PARTY_LICENSES.txt`.
- On tag pushes, creates a GitHub Release and uploads assets
- On tag pushes (`v*`), publishes `webpage-mcp` to npm (requires `NPM_AUTH_TOKEN` secret)
- Manual npm publish is available via `workflow_dispatch` with
  `publish_npm=true` only when the selected ref is the exact matching
  `v<package-version>` tag. A branch dispatch that requests publishing fails
  closed.
- The npm mutation job uses the `npm-publish` GitHub Environment so repository
  administrators can configure required reviewers or other deployment
  protection rules.
- Formal release builds require the Actions repository variable `CHROME_EXTENSION_PUBLIC_KEY`. It must contain the single-line base64 DER public-key body from Chrome Web Store, never a PEM or private key, and must derive the configured official extension ID. Local builds may omit it, but then unpacked builds do not use the official stable extension ID.

</details>

---

## Verification

- Native/stdio packaging and registration helpers: `pnpm --filter webpage-mcp test`; the stable runtime dependency contract is covered by `app/mcp-server/src/scripts/stable-runtime-dependencies.test.ts`. End-to-end startup bootstrap across installed browser profiles is `Verification: Missing` and remains a manual `doctor` check.
- Release platform gates execute each built `run_host.sh` or `run_host.bat` and
  verify a native ping/pong frame, but they do not launch an installed browser
  profile or the packaged extension. The real browser → extension → registered
  native-host handshake on Linux, Windows, and macOS remains a manual release
  check.
- Agent project/session selection and missing-selection routing: `pnpm --filter webpage-mcp-connector exec vitest run tests/utils/agent-selection.test.ts tests/background/sidepanel-utils.test.ts tests/background/quick-panel-agent-handler.test.ts`.
- Safe session defaults and explicit dangerous-mode confirmation: `app/mcp-server/src/agent/session-security.test.ts` via `pnpm --filter webpage-mcp test`.
- Localized extension strings: `pnpm --filter webpage-mcp-connector i18n:check`.
- Stable-only unified release, artifact, version-setting, legal inventory,
  verified cargo-deny installer, and standalone npm channel rules:
  `pnpm test:release` and `pnpm legal:check`.
- Production npm advisories: `pnpm audit --prod`. The scheduled Rust advisory
  check validates `packages/wasm-simd/Cargo.lock` with Rust 1.94.0, then runs
  the verified cargo-deny 0.19.8 binary with all features and a freshly updated
  advisory database.

Human review is still required for the unresolved documentation owner (`NEEDS_OWNER`) and for installed-browser bootstrap behavior on each supported operating system.

---

## Acknowledgements

This project is based on [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome). Special thanks to the original author and all contributors for their foundational work.

## License

MIT
