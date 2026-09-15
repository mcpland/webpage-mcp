#!/usr/bin/env node
import serverInstance from "./server";
import nativeMessagingHostInstance from "./native-messaging-host";

const shutdown = nativeMessagingHostInstance.requestProcessShutdown;
const exitWithError = (label: string, error: unknown): void => {
  shutdown(1, `mcp-server ${label}`, error);
};

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  void nativeMessagingHostInstance.start().catch((error) => {
    exitWithError("startup failed", error);
  });
} catch (error) {
  exitWithError("startup failed", error);
}

process.on("error", (error) => {
  exitWithError("process error", error);
});

// Handle process signals and uncaught exceptions
process.on("SIGINT", () => {
  shutdown(0);
});

process.on("SIGTERM", () => {
  shutdown(0);
});

process.on("uncaughtException", (error) => {
  exitWithError("uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  exitWithError("unhandled rejection", reason);
});

// A supervisor disconnect can break stderr independently of Chrome's stdout.
// Do not report this through the same failed stream.
process.stderr.on("error", () => shutdown(1));
process.on("SIGHUP", () => shutdown(0));
