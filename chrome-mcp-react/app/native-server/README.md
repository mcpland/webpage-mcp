# Fastify Chrome Native Messaging Service

This is a TypeScript project based on Fastify, designed for native communication with Chrome extensions.

## Features

- Bidirectional communication with Chrome extensions via Chrome Native Messaging protocol
- **Multi-browser support**: Chrome and Chromium (including Linux, macOS, and Windows)
- RESTful API service
- Fully developed in TypeScript
- Complete test suite
- Follows code quality best practices

## Development Environment Setup

### Prerequisites

- Node.js 20+
- npm 8+ or pnpm 8+

### Installation

```bash
git clone https://github.com/your-username/fastify-chrome-native.git
cd fastify-chrome-native
npm install
```

### Development

1. Build and register the native server locally

```bash
cd app/native-server
npm run dev
```

2. Start the Chrome extension

```bash
cd app/chrome-extension
npm run dev
```

### Build

```bash
npm run build
```

### Register Native Messaging Host

#### Auto-detect and register all installed browsers

```bash
webpage-mcp-bridge register --detect
```

#### Register specific browsers

```bash
# Register Chrome only
webpage-mcp-bridge register --browser chrome

# Register Chromium only
webpage-mcp-bridge register --browser chromium

# Register all supported browsers
webpage-mcp-bridge register --browser all
```

#### Global installation (auto-registers detected browsers)

```bash
npm i -g webpage-mcp-bridge
```

#### Browser Support

| Browser       | Linux | macOS | Windows |
| ------------- | ----- | ----- | ------- |
| Google Chrome | ✓     | ✓     | ✓       |
| Chromium      | ✓     | ✓     | ✓       |

Registration locations:

- **Linux**: `~/.config/[browser-name]/NativeMessagingHosts/`
- **macOS**: `~/Library/Application Support/[Browser]/NativeMessagingHosts/`
- **Windows**: `%APPDATA%\[Browser]\NativeMessagingHosts\`

### Integration with Chrome Extension

Here is a simple example of how to use this service in a Chrome extension:

```javascript
// background.js
let nativePort = null;
let serverRunning = false;

// Start Native Messaging service
function startServer() {
  if (nativePort) {
    console.log("Already connected to Native Messaging host");
    return;
  }

  try {
    nativePort = chrome.runtime.connectNative(
      "com.yourcompany.fastify_native_host",
    );

    nativePort.onMessage.addListener((message) => {
      console.log("Received Native message:", message);

      if (message.type === "started") {
        serverRunning = true;
        console.log(`Server started, port: ${message.payload.port}`);
      } else if (message.type === "stopped") {
        serverRunning = false;
        console.log("Server stopped");
      } else if (message.type === "error") {
        console.error("Native error:", message.payload.message);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.log("Native connection disconnected:", chrome.runtime.lastError);
      nativePort = null;
      serverRunning = false;
    });

    // Start server
    nativePort.postMessage({ type: "start", payload: { port: 3000 } });
  } catch (error) {
    console.error("Error starting Native Messaging:", error);
  }
}

// Stop server
function stopServer() {
  if (nativePort && serverRunning) {
    nativePort.postMessage({ type: "stop" });
  }
}

// Test communication with server
async function testPing() {
  try {
    const response = await fetch("http://localhost:3000/ping");
    const data = await response.json();
    console.log("Ping response:", data);
    return data;
  } catch (error) {
    console.error("Ping failed:", error);
    return null;
  }
}

// Connect to Native host when extension starts
chrome.runtime.onStartup.addListener(startServer);

// Export API for popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startServer") {
    startServer();
    sendResponse({ success: true });
  } else if (message.action === "stopServer") {
    stopServer();
    sendResponse({ success: true });
  } else if (message.action === "testPing") {
    testPing().then(sendResponse);
    return true; // Indicates we will send a response asynchronously
  }
});
```

### Testing

```bash
npm run test
```

### License

MIT
