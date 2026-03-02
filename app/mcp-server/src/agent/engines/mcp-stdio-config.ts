import path from 'node:path';
import fs from 'node:fs';

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

  // Locate stdio entry across bundled and non-bundled build layouts.
  const candidates = [
    path.resolve(__dirname, '../../mcp/mcp-server-stdio.js'),
    path.resolve(__dirname, '../mcp/mcp-server-stdio.js'),
    path.resolve(__dirname, './mcp/mcp-server-stdio.js'),
  ];
  const stdioScriptPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
  return {
    command: process.execPath,
    args: [stdioScriptPath],
    env,
  };
}
