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
              name: 'dryRun',
              description: 'Skip final submit',
              default: true,
            },
            {
              name: 'metadata',
              description: 'Arbitrary payload',
              default: { role: 'admin' },
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
      required: ['email'],
      properties: {
        email: {
          type: 'string',
          description: 'Email Address',
          default: 'alice@example.com',
        },
        dryRun: {
          type: 'boolean',
          description: 'Skip final submit',
          default: true,
        },
        metadata: {
          description: 'Arbitrary payload',
          default: { role: 'admin' },
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
});
