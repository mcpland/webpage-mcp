#!/usr/bin/env node

import { Command } from 'commander';
import { autoBootstrapNativeMessaging } from '../scripts/utils';
import { RemoteMcpServer } from './remote-mcp-server';
import {
  configureRemoteMcpServerCommand,
  resolveRemoteMcpServerOptions,
  type RemoteMcpServerCliOptions,
} from './remote-server-config';

export async function runRemoteMcpServerCommand(
  rawOptions: RemoteMcpServerCliOptions,
): Promise<void> {
  const options = resolveRemoteMcpServerOptions(rawOptions);
  try {
    await autoBootstrapNativeMessaging({
      output: 'stderr',
      logLabel: 'webpage-mcp-server',
    });
  } catch (error) {
    console.warn('[webpage-mcp-server] Automatic native registration bootstrap failed:', error);
  }

  const server = new RemoteMcpServer(options);
  const listening = await server.start();
  console.log(`[webpage-mcp-server] Listening on ${listening.endpoint}`);
  console.log(
    `[webpage-mcp-server] Native bridge instance: ${options.instanceId}; readiness: ${listening.endpoint.replace(/\/mcp$/, '/readyz')}`,
  );

  await new Promise<void>((resolve) => {
    let shutdownStarted = false;
    const shutdown = (): void => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      void server
        .close()
        .catch((error) => {
          console.error('[webpage-mcp-server] Shutdown failed:', error);
          process.exitCode = 1;
        })
        .finally(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

async function main(): Promise<void> {
  const program = configureRemoteMcpServerCommand(
    new Command().name('webpage-mcp-server').version(require('../../package.json').version),
  );
  program.action((options: RemoteMcpServerCliOptions) => runRemoteMcpServerCommand(options));
  await program.parseAsync(process.argv);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      '[webpage-mcp-server] Fatal error:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
