# Troubleshooting

This guide covers common issues when setting up and using Webpage MCP.

## Table of Contents

- [Extension fails to connect to native host](#extension-fails-to-connect-to-native-host)
- [Native host registration fails](#native-host-registration-fails)
- [Permission denied (macOS / Linux)](#permission-denied-macos--linux)
- [MCP client can't reach the server](#mcp-client-cant-reach-the-server)
- [stdio transport not working](#stdio-transport-not-working)
- [Tools return errors or time out](#tools-return-errors-or-time-out)
- [Port conflicts](#port-conflicts)
- [Node.js version issues](#nodejs-version-issues)
- [Windows-specific issues](#windows-specific-issues)
- [Using diagnostic tools](#using-diagnostic-tools)
- [Auth token issues](#auth-token-issues)
- [Reporting an issue](#reporting-an-issue)

---

## Extension fails to connect to native host

**Symptoms:** The extension popup shows a disconnected status; clicking "Connect" does nothing or shows an error.

**Steps to fix:**

1. Run the built-in diagnostics:
   ```bash
   webpage-mcp doctor
   ```
2. If `doctor` reports errors, try the automatic fix:
   ```bash
   webpage-mcp doctor --fix
   ```
3. Re-register the native messaging host:
   ```bash
   webpage-mcp register --force --detect
   ```
4. Reload the extension: go to `chrome://extensions/`, find **Webpage MCP**, and click the refresh icon.
5. Restart Chrome completely (close all windows, then reopen).

---

## Native host registration fails

**Symptoms:** `webpage-mcp register` exits with an error or the manifest file is not created.

**Common causes and fixes:**

- **Node.js not found** — Make sure Node.js >= 20 is installed and available in your PATH:
  ```bash
  node -v   # Should print v20.x.x or higher
  ```
- **Permission issues on macOS/Linux** — Try registering with elevated permissions:
  ```bash
  sudo webpage-mcp register --detect
  ```
- **Wrong browser target** — Specify the browser explicitly:
  ```bash
  webpage-mcp register --browser chrome
  webpage-mcp register --browser chromium
  ```

**Manifest locations (user-level):**

| OS | Chrome | Chromium |
|---|---|---|
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` | `~/Library/Application Support/Chromium/NativeMessagingHosts/` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/` | `~/.config/chromium/NativeMessagingHosts/` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\` | `%LOCALAPPDATA%\Chromium\User Data\NativeMessagingHosts\` |

You can verify the manifest exists:
```bash
# macOS
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.webpagemcp.nativehost.json

# Linux
cat ~/.config/google-chrome/NativeMessagingHosts/com.webpagemcp.nativehost.json

# Windows (PowerShell)
Get-Content "$env:LOCALAPPDATA\Google\Chrome\User Data\NativeMessagingHosts\com.webpagemcp.nativehost.json"
```

---

## Permission denied (macOS / Linux)

**Symptoms:** The extension connects but immediately disconnects, or `doctor` reports `run_host.sh is not executable`.

**Cause:** Some package managers (e.g., pnpm) may not preserve execute permissions on shell scripts.

**Fix:**
```bash
webpage-mcp fix-permissions
```

Or manually:
```bash
chmod +x "$(npm root -g)/webpage-mcp/dist/run_host.sh"
```

---

## MCP client can't reach the server

**Symptoms:** Your AI client (Claude Desktop, Cursor, etc.) reports connection errors or cannot discover tools.

**Steps to fix:**

1. Make sure the extension is connected — open the extension popup and check the status.
2. Verify the server is running:
   ```bash
   curl http://127.0.0.1:12306/ping
   ```
   A successful response means the server is up.
3. If using **Streamable HTTP**, confirm the MCP URL in your client is:
   ```
   http://127.0.0.1:12306/mcp
   ```
4. If using **SSE (legacy)**, confirm you have both endpoints configured:
   - Event stream: `http://127.0.0.1:12306/sse`
   - Messages: `http://127.0.0.1:12306/messages`
5. If you changed the port in the extension popup, update your client configuration to match.

---

## stdio transport not working

**Symptoms:** Claude Desktop or another stdio-based client can't connect.

**Steps to fix:**

1. Make sure `webpage-mcp-stdio` is available:
   ```bash
   npx -y webpage-mcp@latest webpage-mcp-stdio --help
   ```
2. Ensure the extension popup is connected and the native server is running.
3. Check that the stdio proxy port matches the server port:
   ```bash
   webpage-mcp update-port 12306
   ```
4. You can set the upstream URL explicitly via environment variables:
   ```bash
   export WEBPAGE_MCP_URL="http://127.0.0.1:12306/mcp"
   ```
   Or just the port:
   ```bash
   export WEBPAGE_MCP_PORT=12306
   ```

**Claude Desktop config example** (`claude_desktop_config.json`):
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

---

## Tools return errors or time out

**Symptoms:** MCP tool calls fail with errors or no response.

**Steps to fix:**

1. Make sure Chrome is open with at least one tab.
2. Check that the extension is enabled at `chrome://extensions/`.
3. Inspect the extension's service worker for errors:
   - Go to `chrome://extensions/`
   - Find **Webpage MCP** and click **Inspect views > service worker**
   - Check the Console tab for error messages
4. Some tools require specific conditions:
   - `chrome_network_capture` — Needs an active page to capture traffic from.
   - `chrome_handle_dialog` — Only works when a JavaScript dialog (alert/confirm/prompt) is showing.
   - `chrome_handle_download` — Requires a download to be in progress.
   - `chrome_upload_file` — Requires a file input element on the page.
5. Reload the extension and reconnect from the popup.

---

## Port conflicts

**Symptoms:** The server fails to start or `curl` returns "Connection refused" even though the extension shows connected.

**Steps to fix:**

1. Check if another process is using port 12306:
   ```bash
   # macOS / Linux
   lsof -i :12306

   # Windows
   netstat -ano | findstr :12306
   ```
2. If the port is occupied, change the port in the extension popup and update the stdio config:
   ```bash
   webpage-mcp update-port <new-port>
   ```
3. Update your MCP client config to use the new port.

> **Note:** This guide assumes a single active server endpoint.
> Keep a 1:1 mapping between the extension port and MCP server port.
> If you change the port in the extension popup, run `webpage-mcp update-port <same-port>` so `webpage-mcp-stdio` forwards to the same target.

---

## Node.js version issues

**Symptoms:** `doctor` reports "Node.js is too old" or the native host crashes on startup.

**Requirements:** Node.js >= 20.0.0

**Fix:**
```bash
# Check your version
node -v

# Install/update using your preferred method
# nvm
nvm install 20
nvm use 20

# Homebrew (macOS)
brew install node@20

# fnm
fnm install 20
fnm use 20
```

If you use a Node version manager (nvm, fnm, volta, asdf), the native host tries to find Node in this order:

1. `WEBPAGE_MCP_NODE_PATH` environment variable
2. `node_path.txt` file (written by `webpage-mcp register`)
3. Relative path from the package
4. Volta, asdf, fnm, nvm default
5. Common system paths (`/opt/homebrew/bin/node`, `/usr/local/bin/node`, etc.)
6. `PATH`

If the wrong Node version is being picked up, set the path explicitly:
```bash
export WEBPAGE_MCP_NODE_PATH="$(which node)"
webpage-mcp doctor --fix
```

---

## Windows-specific issues

### Registry entry not found

The native messaging host uses Windows Registry entries. If `doctor` reports registry issues:

```bash
webpage-mcp register --browser chrome
```

For system-level registration (requires Administrator Command Prompt):
```bash
webpage-mcp register --system
```

### Antivirus blocking

Some antivirus software may block the native messaging host. Add an exception for the `webpage-mcp` installation directory:
```
%APPDATA%\npm\node_modules\webpage-mcp\
```

---

## Using diagnostic tools

### `webpage-mcp doctor`

Runs a comprehensive check of your installation:

```bash
webpage-mcp doctor              # Standard check
webpage-mcp doctor --fix        # Auto-fix common issues
webpage-mcp doctor --json       # Machine-readable output
webpage-mcp doctor --browser chrome  # Check specific browser
```

**What it checks:**
- Package installation and version
- Host files (wrapper script, entry point, stdio config)
- File permissions (macOS/Linux)
- Node.js executable resolution and version
- Native messaging manifest per browser
- Windows Registry entries (Windows only)
- Port configuration consistency
- Server connectivity (ping test)
- Logs directory

### `webpage-mcp report`

Generates a diagnostic report for sharing in bug reports:

```bash
webpage-mcp report              # Print to stdout
webpage-mcp report --copy       # Copy to clipboard
webpage-mcp report --output report.md  # Save to file
webpage-mcp report --json       # JSON format
webpage-mcp report --include-logs full  # Include full wrapper logs
```

Sensitive information (usernames, file paths, tokens) is automatically redacted. Use `--no-redact` if you need full paths.

---

## Auth token issues

If you have set `WEBPAGE_MCP_AUTH_TOKEN`, all requests to MCP endpoints require authentication.

**Symptoms:** 401 Unauthorized errors from the MCP server.

**Fix:** Ensure your MCP client sends the token via one of:
- `Authorization: Bearer <token>` header
- `x-webpage-mcp-token: <token>` header

For stdio transport, `webpage-mcp-stdio` forwards the token automatically when `WEBPAGE_MCP_AUTH_TOKEN` is set in its environment.

If you no longer need auth, unset the variable:
```bash
unset WEBPAGE_MCP_AUTH_TOKEN
```

---

## Reporting an issue

If none of the above resolves your problem:

1. Generate a diagnostic report:
   ```bash
   webpage-mcp report --copy
   ```
2. Open an issue at [github.com/mcpland/webpage-mcp/issues](https://github.com/mcpland/webpage-mcp/issues)
3. Paste the diagnostic report into the issue body
4. Include:
   - What you were trying to do
   - What happened instead
   - Your MCP client name and version
   - Any relevant error messages from the service worker console
