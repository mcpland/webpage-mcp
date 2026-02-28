import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { setupTools } from './register-tools';

export function createMcpServer(): McpSdkServer {
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

  setupTools(mcpServer);
  return mcpServer;
}
