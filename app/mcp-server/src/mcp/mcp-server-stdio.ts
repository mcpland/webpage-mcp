#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveInstanceId, WEBPAGE_MCP_INSTANCE_ID_ENV } from '../instance-id';
import { autoBootstrapNativeMessagingForStdio } from '../scripts/utils';
import { createMcpBridgeSession } from './mcp-bridge-session';
import { NativeIpcBridgeClient } from './native-ipc-bridge-client';

const bridgeClient = new NativeIpcBridgeClient();
const stdioSession = createMcpBridgeSession({
  bridgeClient,
  instanceId: resolveInstanceId(process.env[WEBPAGE_MCP_INSTANCE_ID_ENV]),
  serverName: 'WebpageMcpStdioServer',
  logLabel: 'webpage-mcp-stdio',
});
let shutdownStarted = false;

async function shutdown(exitCode = 0): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  bridgeClient.close();
  try {
    await stdioSession.close();
  } catch {
    // Ignore close errors during shutdown.
  }
  process.exit(exitCode);
}

function installProcessLifecycleHooks(): void {
  process.stdin.on('end', () => {
    void shutdown(0);
  });
  process.stdin.on('close', () => {
    void shutdown(0);
  });
  process.on('SIGINT', () => {
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });

  const parentPid = process.ppid;
  if (Number.isInteger(parentPid) && parentPid > 1) {
    const timer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        void shutdown(0);
      }
    }, 5000);
    timer.unref();
  }
}

async function main(): Promise<void> {
  installProcessLifecycleHooks();

  try {
    await autoBootstrapNativeMessagingForStdio({ output: 'stderr' });
  } catch (error) {
    console.warn('[webpage-mcp-stdio] Automatic native registration bootstrap failed:', error);
  }

  const transport = new StdioServerTransport();
  await stdioSession.server.connect(transport);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error in webpage-mcp-stdio:', error);
    process.exit(1);
  });
}
