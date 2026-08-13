import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeBridgeRequestClient } from './native-ipc-bridge-client';
import {
  REMOTE_MCP_MAX_REQUEST_BODY_BYTES,
  RemoteMcpServer,
  type RemoteMcpListenResult,
} from './remote-mcp-server';
import { resolveRemoteMcpServerOptions } from './remote-server-config';

const TOKEN = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

interface BridgeCall {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

class FakeBridge implements NativeBridgeRequestClient {
  public readonly calls: BridgeCall[] = [];
  public tools: Tool[] = [
    {
      name: 'chrome_read_page',
      description: 'Read the current page',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'workflow_publish',
      description: 'Publish a workflow',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  public result: CallToolResult = {
    content: [{ type: 'text', text: 'bridge-result' }],
  };
  public ready = true;

  async request<T>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    this.calls.push({ method, params, timeoutMs, signal });
    if (method === 'ping') return { ok: this.ready } as T;
    if (method === 'mcp_list_tools') return { tools: this.tools } as T;
    if (method === 'mcp_call_tool') return { result: this.result } as T;
    throw new Error(`Unexpected native bridge method: ${method}`);
  }
}

interface ConnectedClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

interface RunningServer {
  bridge: FakeBridge;
  listening: RemoteMcpListenResult;
  server: RemoteMcpServer;
}

const runningServers: RemoteMcpServer[] = [];
const connectedClients: ConnectedClient[] = [];

afterEach(async () => {
  await Promise.allSettled(
    connectedClients.splice(0).map(async ({ client, transport }) => {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }),
  );
  await Promise.allSettled(runningServers.splice(0).map((server) => server.close()));
});

async function startServer(
  overrides: {
    allowedOrigin?: string[];
    maxSessions?: number;
    token?: string;
  } = {},
): Promise<RunningServer> {
  const bridge = new FakeBridge();
  const token = overrides.token === undefined ? TOKEN : overrides.token;
  const options = resolveRemoteMcpServerOptions(
    {
      port: 0,
      allowedOrigin: overrides.allowedOrigin,
    },
    token ? { WEBPAGE_MCP_REMOTE_TOKEN: token } : {},
    { allowEphemeralPort: true },
  );
  const server = new RemoteMcpServer(options, {
    bridgeClient: bridge,
    maxSessions: overrides.maxSessions,
  });
  runningServers.push(server);
  const listening = await server.start();
  return { bridge, listening, server };
}

async function connectClient(
  endpoint: string,
  token = TOKEN,
  name = 'remote-test-client',
): Promise<ConnectedClient> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name, version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  await client.connect(transport);
  const connected = { client, transport };
  connectedClients.push(connected);
  return connected;
}

function endpoint(listening: RemoteMcpListenResult, pathname: string): string {
  return new URL(pathname, listening.endpoint).toString();
}

function rawGet(
  listening: RemoteMcpListenResult,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ body: string; statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: listening.port,
        path: pathname,
        method: 'GET',
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            statusCode: response.statusCode,
          });
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

describe('remote Streamable HTTP MCP server', () => {
  it('separates public liveness from authenticated native-bridge readiness', async () => {
    const { bridge, listening } = await startServer();

    const health = await fetch(endpoint(listening, '/healthz'));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });

    const missingAuth = await fetch(endpoint(listening, '/readyz'));
    expect(missingAuth.status).toBe(401);
    expect(missingAuth.headers.get('www-authenticate')).toBe('Bearer');

    const queryToken = await fetch(endpoint(listening, `/readyz?access_token=${TOKEN}`));
    expect(queryToken.status).toBe(401);

    const ready = await fetch(endpoint(listening, '/readyz'), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: 'ready' });
    expect(bridge.calls.at(-1)).toMatchObject({
      method: 'ping',
      params: { instanceId: 'default' },
    });

    bridge.ready = false;
    const unavailable = await fetch(endpoint(listening, '/readyz'), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('rejects untrusted Host and Origin authorities before MCP handling', async () => {
    const { listening } = await startServer({
      allowedOrigin: ['https://agent.example.test'],
    });

    const invalidHost = await rawGet(listening, '/healthz', {
      Host: 'attacker.example.test',
    });
    expect(invalidHost.statusCode).toBe(403);
    expect(JSON.parse(invalidHost.body)).toEqual({ error: 'Forbidden Host' });

    const invalidOrigin = await fetch(endpoint(listening, '/healthz'), {
      headers: { Origin: 'https://attacker.example.test' },
    });
    expect(invalidOrigin.status).toBe(403);

    const allowedOrigin = await fetch(endpoint(listening, '/healthz'), {
      headers: { Origin: 'https://agent.example.test' },
    });
    expect(allowedOrigin.status).toBe(200);
    expect(allowedOrigin.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves an SDK client while preserving remote session and native instance isolation', async () => {
    const { bridge, listening, server } = await startServer();
    const { client, transport } = await connectClient(listening.endpoint);

    await expect(client.listTools()).resolves.toEqual({ tools: bridge.tools });
    await expect(
      client.callTool({ name: 'chrome_read_page', arguments: { tabId: 42 } }),
    ).resolves.toEqual(bridge.result);

    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(server.sessionCount).toBe(1);
    const bridgeRequests = bridge.calls.filter((call) => call.method.startsWith('mcp_'));
    expect(bridgeRequests).toHaveLength(2);
    for (const call of bridgeRequests) {
      expect(call.params).toMatchObject({
        instanceId: 'default',
        sessionId: transport.sessionId,
      });
    }
    expect(bridgeRequests[1]?.params).toMatchObject({
      name: 'chrome_read_page',
      args: { tabId: 42 },
    });

    await transport.terminateSession();
    expect(server.sessionCount).toBe(0);
  });

  it('enforces request-body and concurrent session limits', async () => {
    const { listening, server } = await startServer({ maxSessions: 1 });
    await connectClient(listening.endpoint, TOKEN, 'first-client');

    await expect(connectClient(listening.endpoint, TOKEN, 'second-client')).rejects.toThrow(
      /503|session limit/i,
    );
    expect(server.sessionCount).toBe(1);

    const oversized = await fetch(listening.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payload: 'x'.repeat(REMOTE_MCP_MAX_REQUEST_BODY_BYTES),
      }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { message: 'MCP request body is too large' },
    });
  });

  it('allows an explicitly unauthenticated loopback server but never accepts a wrong token', async () => {
    const unauthenticated = await startServer({ token: '' });
    const localHealth = await fetch(endpoint(unauthenticated.listening, '/readyz'));
    expect(localHealth.status).toBe(200);

    const authenticated = await startServer();
    await expect(
      connectClient(authenticated.listening.endpoint, `${TOKEN}wrong`, 'wrong-token-client'),
    ).rejects.toThrow(/401|Unauthorized/i);
    expect(authenticated.server.sessionCount).toBe(0);
  });
});
