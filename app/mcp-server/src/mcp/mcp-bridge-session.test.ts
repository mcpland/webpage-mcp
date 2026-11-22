import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpBridgeSession, type McpBridgeSession } from './mcp-bridge-session';
import type { NativeBridgeRequestClient } from './native-ipc-bridge-client';
import { parseToolset, TOOLSET_ENV, type Toolset } from './toolset';

interface BridgeCall {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

class FakeBridge implements NativeBridgeRequestClient {
  public readonly calls: BridgeCall[] = [];
  public tools: Tool[] = [];
  public result: CallToolResult = { content: [{ type: 'text', text: 'ok' }] };

  async request<T>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    this.calls.push({ method, params, timeoutMs, signal });
    return (method === 'mcp_list_tools' ? { tools: this.tools } : { result: this.result }) as T;
  }
}

const sessions: McpBridgeSession[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
  vi.restoreAllMocks();
});

async function connect(
  bridge: FakeBridge,
  onToolListChanged?: (sourceSessionId: string) => Promise<void>,
  toolset?: Toolset,
): Promise<{ client: Client; session: McpBridgeSession }> {
  const session = createMcpBridgeSession({
    bridgeClient: bridge,
    sessionId: 'test-session',
    instanceId: 'remote-one',
    serverName: 'TestWebpageMcpServer',
    logLabel: 'test-webpage-mcp',
    onToolListChanged,
    toolset,
  });
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  await client.connect(clientTransport);
  sessions.push(session);
  clients.push(client);
  return { client, session };
}

const tool = (name: string): Tool => ({ name, inputSchema: { type: 'object', properties: {} } });

describe('MCP bridge session', () => {
  it('lists and calls only the tools the toolset enables', async () => {
    const bridge = new FakeBridge();
    bridge.tools = [tool('chrome_read_page'), tool('chrome_console'), tool('workflow_run')];
    const { client } = await connect(bridge, undefined, parseToolset('core'));

    const listed = await client.listTools();
    const refused = await client.callTool({ name: 'chrome_console', arguments: {} });

    expect(listed.tools.map((t) => t.name)).toEqual(['chrome_read_page']);
    expect(refused).toEqual({
      content: [
        {
          type: 'text',
          text: 'Error calling tool: chrome_console is not enabled (WEBPAGE_MCP_TOOLSET=core).',
        },
      ],
      isError: true,
    });
    // The refused call never reached the native host.
    expect(bridge.calls.map((call) => call.method)).toEqual(['mcp_list_tools']);
  });

  it('reads the toolset from WEBPAGE_MCP_TOOLSET by default', async () => {
    vi.stubEnv(TOOLSET_ENV, 'all,-chrome_console');
    try {
      const bridge = new FakeBridge();
      bridge.tools = [tool('chrome_read_page'), tool('chrome_console')];
      const { client } = await connect(bridge);

      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['chrome_read_page']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('routes list and call requests through one isolated native bridge context', async () => {
    const bridge = new FakeBridge();
    bridge.tools = [
      {
        name: 'chrome_read_page',
        description: 'Read the page',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    bridge.result = { content: [{ type: 'text', text: 'page result' }] };
    const { client, session } = await connect(bridge);

    await expect(client.listTools()).resolves.toEqual({ tools: bridge.tools });
    await expect(
      client.callTool({ name: 'chrome_read_page', arguments: { tabId: 7 } }),
    ).resolves.toEqual(bridge.result);

    expect(session.sessionId).toBe('test-session');
    expect(session.instanceId).toBe('remote-one');
    expect(bridge.calls).toHaveLength(2);
    expect(bridge.calls[0]).toMatchObject({
      method: 'mcp_list_tools',
      params: {
        sessionId: 'test-session',
        instanceId: 'remote-one',
      },
      timeoutMs: 30_000,
    });
    expect(bridge.calls[1]).toMatchObject({
      method: 'mcp_call_tool',
      params: {
        sessionId: 'test-session',
        instanceId: 'remote-one',
        name: 'chrome_read_page',
        args: { tabId: 7 },
      },
      // The session waits a little longer than the native host's own 120s limit.
      timeoutMs: 130_000,
    });
  });

  it('keeps the static tool fallback when the native bridge list fails', async () => {
    const bridge = new FakeBridge();
    vi.spyOn(bridge, 'request').mockRejectedValueOnce(new Error('bridge unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = await connect(bridge);

    const response = await client.listTools();

    expect(response.tools.length).toBeGreaterThan(0);
    expect(response.tools.some((tool) => tool.name === 'chrome_read_page')).toBe(true);
  });

  it('delegates successful workflow tool-list changes to a shared broadcaster', async () => {
    const bridge = new FakeBridge();
    const onToolListChanged = vi.fn(async () => undefined);
    const { client } = await connect(bridge, onToolListChanged);

    await client.callTool({
      name: 'workflow_publish',
      arguments: { workflowId: 'flow-1' },
    });

    expect(onToolListChanged).toHaveBeenCalledOnce();
    expect(onToolListChanged).toHaveBeenCalledWith('test-session');
  });
});
