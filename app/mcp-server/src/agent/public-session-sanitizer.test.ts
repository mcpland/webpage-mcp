import { describe, expect, it } from 'vitest';
import type { AgentSession } from './session-service';
import { sanitizeSessionForPublicRead } from './public-session-sanitizer';

function createSession(): AgentSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    engineName: 'claude',
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    optionsConfig: {
      allowedTools: ['chrome_read_page'],
      env: { ROOT_TOKEN: 'root-secret' },
      codexConfig: {
        sandboxMode: 'read-only',
        autoInstructions: 'private prompt material',
      },
      mcpServers: {
        privateServer: {
          command: 'node',
          args: ['server.js'],
          env: { SERVICE_TOKEN: 'nested-secret' },
          headers: { Authorization: 'Bearer nested-secret' },
          clientSecret: 'nested-secret',
          nested: { password: 'nested-secret', port: 443 },
        },
      },
    },
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
}

describe('sanitizeSessionForPublicRead', () => {
  it('removes secrets recursively without mutating the stored session', () => {
    const session = createSession();
    const sanitized = sanitizeSessionForPublicRead(session);

    expect(sanitized.optionsConfig).toEqual({
      allowedTools: ['chrome_read_page'],
      codexConfig: { sandboxMode: 'read-only' },
    });
    expect(JSON.stringify(sanitized)).not.toContain('nested-secret');
    expect(JSON.stringify(sanitized)).not.toContain('private prompt material');
    expect(session.optionsConfig?.env?.ROOT_TOKEN).toBe('root-secret');
    expect(session.optionsConfig?.mcpServers).toHaveProperty('privateServer.env');
  });
});
