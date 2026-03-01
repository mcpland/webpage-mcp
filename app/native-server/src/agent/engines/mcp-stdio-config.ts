import path from 'node:path';

export interface WebpageMcpStdioConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function parseArgs(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveWebpageMcpStdioConfig(): WebpageMcpStdioConfig {
  const explicitCommand = process.env.WEBPAGE_MCP_STDIO_COMMAND?.trim();
  const explicitArgs = process.env.WEBPAGE_MCP_STDIO_ARGS?.trim();

  const nativeSocketPath = process.env.WEBPAGE_MCP_NATIVE_SOCKET?.trim();
  const env = nativeSocketPath
    ? {
        WEBPAGE_MCP_NATIVE_SOCKET: nativeSocketPath,
      }
    : undefined;

  if (explicitCommand) {
    return {
      command: explicitCommand,
      args: explicitArgs ? parseArgs(explicitArgs) : [],
      env,
    };
  }

  // Default to running the bundled stdio entry through the current Node executable.
  // __dirname resolves to dist/agent/engines in packaged builds.
  const stdioScriptPath = path.resolve(__dirname, '../../mcp/mcp-server-stdio.js');
  return {
    command: process.execPath,
    args: [stdioScriptPath],
    env,
  };
}
