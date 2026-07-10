#!/usr/bin/env node
import serverInstance from "./server";
import nativeMessagingHostInstance from "./native-messaging-host";

const reportError = (label: string, error: unknown): void => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[mcp-server] ${label}: ${message}`);
};

let shutdownStarted = false;
let requestedExitCode = 0;
const shutdown = async (
  exitCode: number,
  errorLabel?: string,
  error?: unknown,
): Promise<void> => {
  requestedExitCode = Math.max(requestedExitCode, exitCode);
  if (errorLabel) reportError(errorLabel, error);
  if (shutdownStarted) return;
  shutdownStarted = true;

  try {
    await nativeMessagingHostInstance.shutdown();
  } catch (error) {
    requestedExitCode = 1;
    reportError("shutdown failed", error);
  }
  process.exit(requestedExitCode);
};

const exitWithError = (label: string, error: unknown): void => {
  void shutdown(1, label, error);
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
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("uncaughtException", (error) => {
  exitWithError("uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  exitWithError("unhandled rejection", reason);
});
