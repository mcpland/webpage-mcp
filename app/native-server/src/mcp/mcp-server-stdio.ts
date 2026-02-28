#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from 'webpage-mcp-shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';
import { SERVER_CONFIG } from '../constant';

let stdioMcpServer: Server | null = null;
let mcpClient: Client | null = null;
let shutdownStarted = false;

// Read configuration from stdio-config.json
const loadConfig = (): { url: string } | null => {
  try {
    const configPath = path.join(__dirname, 'stdio-config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(configData) as { url: string };
  } catch (error) {
    console.warn('Failed to load stdio-config.json, will use env overrides if available:', error);
    return null;
  }
};

function parsePort(rawValue: unknown): number | undefined {
  const parsed = Number.parseInt(String(rawValue ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}

function getOptionalAuthHeaders(): HeadersInit | undefined {
  const token = process.env.WEBPAGE_MCP_AUTH_TOKEN?.trim();
  if (!token) {
    return undefined;
  }
  return {
    Authorization: `Bearer ${token}`,
    'x-webpage-mcp-token': token,
  };
}

function getResolvedTargetUrl(): URL {
  const explicitUrl = process.env.WEBPAGE_MCP_URL?.trim();
  if (explicitUrl) {
    return new URL(explicitUrl);
  }

  const envPort = parsePort(process.env.WEBPAGE_MCP_PORT) ?? parsePort(process.env.MCP_HTTP_PORT);
  if (envPort) {
    return new URL(`http://${SERVER_CONFIG.HOST}:${envPort}/mcp`);
  }

  const config = loadConfig();
  if (config?.url) {
    return new URL(config.url);
  }

  throw new Error(
    'No MCP target configured. Set WEBPAGE_MCP_URL or WEBPAGE_MCP_PORT, or provide stdio-config.json.',
  );
}

export const getStdioMcpServer = () => {
  if (stdioMcpServer) {
    return stdioMcpServer;
  }
  stdioMcpServer = new Server(
    {
      name: 'StdioWebpageMcpServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  setupTools(stdioMcpServer);
  return stdioMcpServer;
};

export const ensureMcpClient = async () => {
  try {
    if (mcpClient) {
      const pingResult = await mcpClient.ping();
      if (pingResult) {
        return mcpClient;
      }
    }

    const targetUrl = getResolvedTargetUrl();
    const authHeaders = getOptionalAuthHeaders();
    mcpClient = new Client({ name: 'Webpage MCP Proxy', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(targetUrl, {
      requestInit: authHeaders ? { headers: authHeaders } : undefined,
    });
    await mcpClient.connect(transport);
    return mcpClient;
  } catch (error) {
    mcpClient?.close();
    mcpClient = null;
    console.error('Failed to connect to MCP server:', error);
  }
};

export const setupTools = (server: Server) => {
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const client = await ensureMcpClient();
      if (client) {
        const upstream = await client.listTools(undefined, { timeout: 20_000 });
        if (upstream && Array.isArray(upstream.tools)) {
          return { tools: upstream.tools };
        }
      }
    } catch (error) {
      console.warn('Failed to list tools from upstream MCP server, using static fallback:', error);
    }
    return { tools: TOOL_SCHEMAS };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(request.params.name, request.params.arguments || {}),
  );

  // List resources handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  // List prompts handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
};

const handleToolCall = async (name: string, args: any): Promise<CallToolResult> => {
  try {
    const client = await ensureMcpClient();
    if (!client) {
      throw new Error('Failed to connect to MCP server');
    }
    // Use a sane default of 2 minutes; the previous value mistakenly used 2*6*1000 (12s)
    const DEFAULT_CALL_TIMEOUT_MS = 2 * 60 * 1000;
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: DEFAULT_CALL_TIMEOUT_MS,
    });
    return result as CallToolResult;
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error calling tool: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

async function shutdown(exitCode = 0): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  try {
    mcpClient?.close();
    mcpClient = null;
  } catch {
    // Ignore close errors during shutdown
  }

  try {
    await stdioMcpServer?.close();
    stdioMcpServer = null;
  } catch {
    // Ignore close errors during shutdown
  }

  process.exit(exitCode);
}

function installProcessLifecycleHooks(): void {
  // Parent process closed stdio; exit this proxy process to avoid zombies.
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

  // Parent PID watchdog: exit if parent disappears unexpectedly.
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

async function main() {
  installProcessLifecycleHooks();
  const transport = new StdioServerTransport();
  await getStdioMcpServer().connect(transport);
}

main().catch((error) => {
  console.error('Fatal error Webpage MCP Server main():', error);
  process.exit(1);
});
