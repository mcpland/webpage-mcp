# Webpage MCP Installation Guide

This document details the installation and registration process for Webpage MCP.

## Installation Overview

The installation and registration process for Webpage MCP is as follows:

```
npm install -g webpage-mcp
└─ postinstall.js
   ├─ Copy executable to npm_prefix/bin   ← Always writable (user or root permissions)
   ├─ Attempt user-level registration     ← No sudo needed, succeeds in most cases
   └─ If failed ➜ Prompt user to run webpage-mcp register --system
      └─ Requires manual execution with admin privileges
```

The flow chart above shows the complete process from global installation to final registration.

## Detailed Installation Steps

### 1. Global Installation

```bash
npm install -g webpage-mcp
```

After installation, the system will automatically attempt to register the Native Messaging host in the user directory. This does not require admin privileges and is the recommended installation method.

### 2. User-Level Registration

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

If automatic registration fails, or you want to register manually, run:

```bash
webpage-mcp register
```

**Recommended: Run the diagnostic tool to check for issues:**

```bash
webpage-mcp doctor
```

### 3. System-Level Registration

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
│  └─ File does not exist → Reinstall
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

3. Try connecting to the local service via the extension
   - Use the extension's test feature to attempt connection
   - Check Chrome's extension logs for error messages

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
   - Ensure Node.js version >= 20.x

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
   chmod +x /path/to/node_modules/webpage-mcp/run_host.sh
   chmod +x /path/to/node_modules/webpage-mcp/index.js
   chmod +x /path/to/node_modules/webpage-mcp/cli.js
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

6. Check console error messages
   - Detailed error messages usually indicate the problem
   - Add `--verbose` parameter for more log information

If the problem persists, please submit an issue to the project repository with the following information:

- Operating system version
- Node.js version
- Installation command
- Error messages
- Solutions you have tried
