import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { setupTools, type McpToolContext } from './register-tools';

export function createMcpServer(ctx: McpToolContext): McpSdkServer {
  const mcpServer = new McpSdkServer(
    {
      name: 'WebpageMcpServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  setupTools(mcpServer, ctx);
  return mcpServer;
}
