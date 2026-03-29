import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeMessageType } from 'webpage-mcp-shared';
import {
  callToolForContext,
  clearDynamicFlowCacheForSession,
  listToolsForContext,
  type McpToolContext,
} from './register-tools';

function createContext(
  sessionId: string,
  sendRequestToExtensionAndWait: ReturnType<typeof vi.fn>,
): McpToolContext {
  return {
    sessionId,
    instanceId: 'unit-test',
    nativeHost: {
      sendRequestToExtensionAndWait,
    } as unknown as McpToolContext['nativeHost'],
  };
}

describe('dynamic published flow tools', () => {
  beforeEach(() => {
    clearDynamicFlowCacheForSession('dynamic-flow-tools');
    clearDynamicFlowCacheForSession('dynamic-flow-call');
  });

  it('maps V3 published variables into dynamic tool schemas', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [
        {
          id: 'flow-signup',
          slug: 'signup',
          description: 'Published signup flow',
          variables: [
            {
              name: 'email',
              label: 'Email Address',
              required: true,
              default: 'alice@example.com',
            },
            {
              name: 'apiToken',
              sensitive: true,
              default: 'secret-token',
            },
            {
              name: 'attempts',
              description: 'Retry count',
              kind: 'number',
              required: true,
            },
            {
              name: 'dryRun',
              description: 'Skip final submit',
              default: true,
            },
            {
              name: 'metadata',
              description: 'Arbitrary payload',
              kind: 'json',
            },
            {
              name: 'plan',
              kind: 'enum',
              options: ['free', 'pro'],
            },
            {
              name: 'scores',
              kind: 'array',
              item: 'number',
            },
          ],
        },
      ],
    });
    const ctx = createContext('dynamic-flow-tools', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const signupTool = tools.find((tool) => tool.name === 'flow.signup');

    expect(signupTool).toBeTruthy();
    expect(signupTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['email', 'attempts'],
      properties: {
        email: {
          type: 'string',
          description: 'Email Address',
          default: 'alice@example.com',
        },
        attempts: {
          type: 'number',
          description: 'Retry count',
        },
        dryRun: {
          type: 'boolean',
          description: 'Skip final submit',
          default: true,
        },
        metadata: {
          description: 'Arbitrary payload',
        },
        plan: {
          type: 'string',
          enum: ['free', 'pro'],
          description: 'plan',
        },
        scores: {
          type: 'array',
          items: { type: 'number' },
          description: 'scores',
        },
      },
    });
    expect(
      (signupTool?.inputSchema as { properties?: Record<string, any> }).properties?.apiToken,
    ).toBeUndefined();
    expect((signupTool?.inputSchema as { properties?: Record<string, any> }).properties?.metadata)
      .toHaveProperty('anyOf');
  });

  it('splits V3 dynamic tool arguments from run options by variable name', async () => {
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        items: [
          {
            id: 'flow-signup',
            slug: 'signup',
            variables: [
              { name: 'email', required: true },
              { name: 'attempts', default: 1 },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        status: 'success',
        data: {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
          isError: false,
        },
      });
    const ctx = createContext('dynamic-flow-call', sendRequestToExtensionAndWait);

    const result = await callToolForContext(ctx, 'flow.signup', {
      email: 'alice@example.com',
      attempts: 3,
      refresh: true,
      timeoutMs: 5000,
    });

    expect(sendRequestToExtensionAndWait).toHaveBeenNthCalledWith(
      2,
      {
        name: 'record_replay_flow_run',
        args: {
          flowId: 'flow-signup',
          args: {
            email: 'alice@example.com',
            attempts: 3,
          },
          refresh: true,
          timeoutMs: 5000,
        },
        meta: { mcpSessionId: 'dynamic-flow-call', instanceId: 'unit-test' },
      },
      NativeMessageType.CALL_TOOL,
      120000,
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });
  });

  it('reserves dynamic run option names ahead of conflicting published variables', async () => {
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        items: [
          {
            id: 'flow-conflict',
            slug: 'conflict',
            description: 'Conflicting flow',
            variables: [
              { name: 'email', required: true },
              { name: 'startUrl', label: 'Shadowed start url' },
              { name: 'refresh', required: true },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        status: 'success',
        data: {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
          isError: false,
        },
      });
    const ctx = createContext('dynamic-flow-conflict', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const conflictTool = tools.find((tool) => tool.name === 'flow.conflict');
    const conflictInput = conflictTool?.inputSchema as {
      required?: string[];
      properties?: Record<string, any>;
    };

    expect(conflictTool?.description).toContain(
      'Reserved dynamic tool parameter names are ignored as flow variables: startUrl, refresh.',
    );
    expect(conflictInput.required).toEqual(['email']);
    expect(conflictInput.properties?.email).toMatchObject({ type: 'string' });
    expect(conflictInput.properties?.startUrl).toMatchObject({
      type: 'string',
      description: 'Optional start URL to open before running. Only http:// and https:// URLs are allowed.',
    });
    expect(conflictInput.properties?.refresh).toMatchObject({
      type: 'boolean',
      default: false,
    });

    const result = await callToolForContext(ctx, 'flow.conflict', {
      email: 'alice@example.com',
      startUrl: 'https://example.com/start',
      refresh: true,
    });

    expect(sendRequestToExtensionAndWait).toHaveBeenNthCalledWith(
      2,
      {
        name: 'record_replay_flow_run',
        args: {
          flowId: 'flow-conflict',
          args: {
            email: 'alice@example.com',
          },
          startUrl: 'https://example.com/start',
          refresh: true,
        },
        meta: { mcpSessionId: 'dynamic-flow-conflict', instanceId: 'unit-test' },
      },
      NativeMessageType.CALL_TOOL,
      120000,
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });
  });
});
