---
type: runbook
title: Webpage MCP Installation and Native Host Registration
description: Install, register, verify, and repair the local Native Messaging runtime.
owner: NEEDS_OWNER
status: proposed
tags: [installation, native-messaging, troubleshooting]
---

# Webpage MCP Installation Guide

This document covers installation and Native Messaging registration. The normal MCP client entry is `webpage-mcp-stdio`; it validates the stable runtime and user-level manifests on every startup before connecting to Chrome's native bridge.

## Installation Overview

Package-manager binaries come from the `bin` entries in `package.json`; the postinstall script does not copy executables into a global bin directory.

```
Install or npx resolution
├─ Package manager exposes webpage-mcp / webpage-mcp-stdio bins
├─ postinstall
│  ├─ Verify/fix packaged executable permissions
│  ├─ Global, non-elevated install → attempt user-level registration
│  └─ Local/npx install → print manual recovery guidance
└─ webpage-mcp-stdio startup
   ├─ Prepare a stable runtime copy and runtime dependencies
   ├─ Validate user-level browser manifests
   ├─ Auto-register missing or outdated user-level manifests
   └─ Run lightweight diagnostics, then connect over stdio/local IPC
```

System-level registration is a fallback and always requires explicit `--system` plus administrator/root privileges.

## Detailed Installation Steps

### 1. Configure the MCP stdio entry (recommended)

Global installation is not required. Configure the MCP client to resolve the published package with npx:

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

Starting the MCP client runs the bootstrap shown above. Chrome must be open, the connector extension must be enabled, and both processes must use the same `WEBPAGE_MCP_NATIVE_SOCKET` value when that variable is customized.

### 2. Optional global CLI installation

```bash
npm install -g webpage-mcp
```

A global, non-elevated install attempts user-level Native Messaging registration during postinstall. Elevated installs deliberately skip user-level registration because it would target the administrator's home directory. Regardless of install mode, `webpage-mcp-stdio` validates and repairs user-level registration again at startup.

### 3. User-Level Registration

User-level registration creates manifest files at the following locations:

```
Manifest File Locations
├─ User Level (no admin privileges needed)
│  ├─ Windows: %APPDATA%\Google\Chrome\NativeMessagingHosts\
│  ├─ macOS:   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
│  └─ Linux:   ~/.config/google-chrome/NativeMessagingHosts/
│
└─ System Level (admin privileges required)
   ├─ Windows: %ProgramFiles%\Google\Chrome\NativeMessagingHosts\
   ├─ macOS:   /Library/Google/Chrome/NativeMessagingHosts/
   └─ Linux:   /etc/opt/chrome/native-messaging-hosts/
```

If startup bootstrap cannot register the current extension ID, copy the exact command from the extension popup/welcome page, or run:

```bash
npx -y webpage-mcp@latest register --browser chrome --extension-id <extension_id>
```

**Recommended: Run the diagnostic tool to check for issues:**

```bash
npx -y webpage-mcp@latest doctor
```

### 4. System-Level Registration

If user-level registration fails (e.g., due to permission issues), you can try system-level registration. System-level registration requires admin privileges, and we provide two convenient ways to accomplish this.

There are two ways for system-level registration:

#### Method 1: Using `--system` parameter (Recommended)

```bash
# macOS/Linux
sudo webpage-mcp register --system

# Windows (run Command Prompt as Administrator)
webpage-mcp register --system
```

System-level installation requires admin privileges to write to system directories and registry.

#### Method 2: Using admin privileges directly

**Windows**:
Run Command Prompt or PowerShell as Administrator, then execute:

```
webpage-mcp register
```

**macOS/Linux**:
Use the sudo command:

```
sudo webpage-mcp register
```

## Registration Process Details

### Registration Flow Chart

```
Registration Process
├─ Startup Bootstrap (webpage-mcp-stdio)
│  ├─ Validate stable runtime and user-level manifests
│  ├─ Register only when a manifest is missing/outdated
│  └─ Report doctor-lite issues to stderr without exposing an HTTP service
│
├─ User-Level Registration (webpage-mcp register)
│  ├─ Get user-level manifest path
│  ├─ Create user directory
│  ├─ Generate manifest content
│  ├─ Write manifest file
│  └─ Windows: Create user-level registry entry
│
└─ System-Level Registration (webpage-mcp register --system)
   ├─ Check for admin privileges
   │  ├─ Has privileges → Create system directory and write manifest directly
   │  └─ No privileges → Prompt user to run with admin privileges
   └─ Windows: Create system-level registry entry
```

### Manifest File Structure

```
manifest.json
├─ name: "com.webpagemcp.nativehost"
├─ description: "Node.js Host for Webpage MCP Connector"
├─ path: "/path/to/run_host.sh"       ← Startup script path
├─ type: "stdio"                      ← Communication type
└─ allowed_origins: [                 ← Allowed extensions
   "chrome-extension://extension-ID/"
]
```

### User-Level Registration Process

1. Determine user-level manifest file path
2. Create necessary directories
3. Generate manifest content, including:
   - Host name
   - Description
   - Node.js executable path
   - Communication type (stdio)
   - Allowed extension IDs
   - Startup parameters
4. Write manifest file
5. On Windows, also create corresponding registry entries

### System-Level Registration Process

1. Detect if admin privileges are available
2. If admin privileges are available:
   - Create system-level directory directly
   - Write manifest file
   - Set appropriate permissions
   - Create system-level registry entries on Windows
3. If admin privileges are not available:
   - Prompt user to rerun the command with admin privileges
   - macOS/Linux: `sudo webpage-mcp register --system`
   - Windows: Run Command Prompt as Administrator

## Verify Installation

### Verification Flow Chart

```
Verify Installation
├─ Check Manifest File
│  ├─ File exists → Check if content is correct
│  └─ File does not exist → Run doctor --fix or register
│
├─ Check Chrome Extension
│  ├─ Extension installed → Check extension permissions
│  └─ Extension not installed → Install extension
│
└─ Test Connection
   ├─ Connection successful → Installation complete
   └─ Connection failed → Check error logs → See Troubleshooting
```

### Verification Steps

After installation, you can verify the installation was successful through the following methods:

1. Check if the manifest file exists in the corresponding directory
   - User level: Check manifest file in user directory
   - System level: Check manifest file in system directory
   - Confirm the manifest file content is correct

2. Install the corresponding extension in Chrome
   - Ensure the extension is properly installed
   - Ensure the extension has `nativeMessaging` permission

3. Verify the extension/native bridge
   - Start the configured `webpage-mcp-stdio` MCP entry
   - Refresh connection status in the extension popup
   - Run `npx -y webpage-mcp@latest doctor` and inspect the extension service-worker logs if connection still fails

## Troubleshooting

### Troubleshooting Flow Chart

```
Troubleshooting
├─ Permission Issues
│  ├─ Check user permissions
│  │  ├─ Sufficient permissions → Check directory permissions
│  │  └─ Insufficient permissions → Try system-level installation
│  │
│  ├─ Execution permission issues (macOS/Linux)
│  │  ├─ "Permission denied" error
│  │  ├─ "Native host has exited" error
│  │  └─ Run webpage-mcp fix-permissions
│  │
│  └─ Try webpage-mcp register --system
│
├─ Path Issues
│  ├─ Check Node.js installation (node -v)
│  └─ Check global NPM path (npm root -g)
│
├─ Registry Issues (Windows)
│  ├─ Check registry access permissions
│  └─ Try manually creating registry entries
│
└─ Other Issues
   ├─ Check console error messages
   └─ Submit Issue to project repository
```

### Common Problem Resolution Steps

If you encounter problems during installation, try the following steps:

1. Make sure Node.js is properly installed
   - Run `node -v` and `npm -v` to check versions
   - Ensure Node.js version >= 22.x (Node.js 24 LTS recommended)

2. Check if you have sufficient permissions to create files and directories
   - User-level installation requires write permissions to user directory
   - System-level installation requires admin/root privileges

3. **Fix execution permission issues**

   **macOS/Linux Platform**:

   **Problem Description**:
   - npm installation usually preserves file permissions, but pnpm may not
   - May encounter "Permission denied" or "Native host has exited" errors
   - Chrome extension cannot start native host process

   **Solution**:

   a) **Use built-in fix command (Recommended)**:

   ```bash
   webpage-mcp fix-permissions
   ```

   b) **Run diagnostic tool to auto-fix**:

   ```bash
   webpage-mcp doctor --fix
   ```

   c) **Manually set permissions**:

   ```bash
   # Find installation path
   npm list -g webpage-mcp
   # Or for pnpm
   pnpm list -g webpage-mcp

   # Set execution permissions (replace with actual path)
   chmod +x /path/to/node_modules/webpage-mcp/dist/run_host.sh
   chmod +x /path/to/node_modules/webpage-mcp/dist/index.js
   chmod +x /path/to/node_modules/webpage-mcp/dist/cli.js
   ```

   **Windows Platform**:

   **Problem Description**:
   - `.bat` files on Windows usually don't need execution permissions, but other issues may arise
   - Files may be marked as read-only
   - May encounter "Access denied" or file cannot be executed errors

   **Solution**:

   a) **Use built-in fix command (Recommended)**:

   ```cmd
   webpage-mcp fix-permissions
   ```

   b) **Run diagnostic tool to auto-fix**:

   ```cmd
   webpage-mcp doctor --fix
   ```

   c) **Manually check file properties**:

   ```cmd
   # Find installation path
   npm list -g webpage-mcp

   # Check file properties (right-click -> Properties in File Explorer)
   # Make sure run_host.bat is not read-only
   ```

   d) **Reinstall and force permissions**:

   ```bash
   # Uninstall
   npm uninstall -g webpage-mcp
   # or pnpm uninstall -g webpage-mcp

   # Reinstall
   npm install -g webpage-mcp
   # or pnpm install -g webpage-mcp

   # If still having issues, run permission fix
   webpage-mcp fix-permissions
   ```

4. On Windows, make sure registry access is not restricted
   - Check if `HKCU\Software\Google\Chrome\NativeMessagingHosts\` is accessible
   - For system level, check `HKLM\Software\Google\Chrome\NativeMessagingHosts\`

5. Try system-level installation
   - Use `webpage-mcp register --system` command
   - Or run directly with admin privileges

6. Collect diagnostics
   - Detailed error messages usually indicate the problem
   - Run `npx -y webpage-mcp@latest report --copy` to collect a redacted report

If the problem persists, please submit an issue to the project repository with the following information:

- Operating system version
- Node.js version
- Installation command
- Error messages
- Solutions you have tried

## Verification

- Published bin and postinstall behavior: `app/mcp-server/package.json` and `app/mcp-server/src/scripts/postinstall.ts`; verify with `pnpm --filter webpage-mcp build` and package preflight in `pnpm test:release`.
- Startup runtime/manifest bootstrap: `app/mcp-server/src/mcp/mcp-server-stdio.ts` and `app/mcp-server/src/scripts/utils.ts`; stable dependency behavior is covered by `pnpm --filter webpage-mcp exec vitest run src/scripts/stable-runtime-dependencies.test.ts`.
- Manifest path/contents: `pnpm --filter webpage-mcp exec vitest run src/scripts/native-manifest-file.test.ts` plus the manual `doctor` command on each target operating system.
- CLI registration and repair commands: static command wiring in `app/mcp-server/src/cli.ts`; installed-browser end-to-end registration remains `Verification: Missing` and requires manual Chrome/Chromium checks.

Human review is required to assign the unresolved runbook owner (`NEEDS_OWNER`) and to verify user/system registration on Windows, macOS, and Linux before treating this runbook as accepted.
