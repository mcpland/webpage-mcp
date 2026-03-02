#!/usr/bin/env node
import serverInstance from "./server";
import nativeMessagingHostInstance from "./native-messaging-host";

const exitWithError = (label: string, error: unknown): never => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[mcp-server] ${label}: ${message}`);
  process.exit(1);
};

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  nativeMessagingHostInstance.start();
} catch (error) {
  exitWithError("startup failed", error);
}

process.on("error", (error) => {
  exitWithError("process error", error);
});

// Handle process signals and uncaught exceptions
process.on("SIGINT", () => {
  process.exit(0);
});

process.on("SIGTERM", () => {
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  exitWithError("uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  exitWithError("unhandled rejection", reason);
});
