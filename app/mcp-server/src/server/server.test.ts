import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createSession, getSession } from '../agent/session-service';
import { Server } from './index';

describe('Server agent RPC runtime', () => {
  const server = new Server({ instanceId: 'unit-test' });
  const projectRoot = process.cwd();

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
    expect((response.json as { engines?: Array<{ name: string }> }).engines).toEqual([
      { name: 'codex', supportsMcp: false },
      { name: 'claude', supportsMcp: true },
    ]);
  });

  test('agent.projects.upsert rejects unsupported preferredCli values', async () => {
    const response = await server.invokeAgentRpc({
      operation: 'agent.projects.upsert',
      body: {
        name: 'Unsupported CLI Project',
        rootPath: projectRoot,
        preferredCli: 'cursor',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json as { error?: string }).error).toBe(
      'Invalid preferredCli. Must be one of: codex, claude',
    );
  });

  test('agent.projects.sessions.create rejects unsupported engine names', async () => {
    const projectResponse = await server.invokeAgentRpc({
      operation: 'agent.projects.upsert',
      body: {
        name: 'Session Creation Project',
        rootPath: projectRoot,
        preferredCli: 'codex',
      },
    });
    const projectId = (projectResponse.json as { project?: { id?: string } }).project?.id;

    expect(projectResponse.statusCode).toBe(200);
    expect(projectId).toBeTruthy();

    const response = await server.invokeAgentRpc({
      operation: 'agent.projects.sessions.create',
      params: { projectId },
      body: {
        engineName: 'cursor',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json as { error?: string }).error).toBe(
      'Invalid engineName. Must be one of: codex, claude',
    );
  });

  test('agent.chat.act self-heals legacy sessions with unsupported engine names', async () => {
    const projectResponse = await server.invokeAgentRpc({
      operation: 'agent.projects.upsert',
      body: {
        name: 'Legacy Session Recovery Project',
        rootPath: projectRoot,
        preferredCli: 'codex',
      },
    });
    const projectId = (projectResponse.json as { project?: { id?: string } }).project?.id;

    expect(projectResponse.statusCode).toBe(200);
    expect(projectId).toBeTruthy();

    const legacySession = await createSession(projectId!, 'cursor' as any, {
      name: 'Legacy Cursor Session',
    });

    const response = await server.invokeAgentRpc({
      operation: 'agent.chat.act',
      params: { sessionId: 'legacy-session-runtime' },
      body: {
        instruction: 'Say hello',
        dbSessionId: legacySession.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json as { status?: string }).status).toBe('accepted');

    const healedSession = await getSession(legacySession.id);
    expect(healedSession?.engineName).toBe('codex');
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
