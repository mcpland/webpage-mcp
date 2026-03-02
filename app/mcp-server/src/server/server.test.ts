import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Server } from './index';

describe('Server agent RPC runtime', () => {
  const server = new Server({ instanceId: 'unit-test' });

  beforeAll(async () => {
    await server.start({
      sendRequestToExtensionAndWait: async () => ({ ok: true }),
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  test('health.ping returns pong', async () => {
    const response = await server.invokeAgentRpc({ operation: 'health.ping' });

    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      status: 'ok',
      message: 'pong',
    });
  });

  test('agent.engines.list returns engines', async () => {
    const response = await server.invokeAgentRpc({ operation: 'agent.engines.list' });

    expect(response.statusCode).toBe(200);
    expect(Array.isArray((response.json as { engines?: unknown[] }).engines)).toBe(true);
  });

  test('unsupported operation returns bad request', async () => {
    const response = await server.invokeAgentRpc({ operation: 'unknown.operation' });

    expect(response.statusCode).toBe(400);
    expect((response.json as { error?: string }).error).toContain('Unsupported RPC operation');
  });

  test('agent.chat.stream returns migration guidance', async () => {
    const response = await server.invokeAgentRpc({
      operation: 'agent.chat.stream',
      params: { sessionId: 'session-1' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json).toEqual({
      error: 'Use agent_stream_subscribe over native messaging instead of chat.stream',
    });
  });
});
