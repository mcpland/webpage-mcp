import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const LEGACY_FLOW_TOOLS_ENV = 'WEBPAGE_MCP_EXPOSE_LEGACY_FLOW_TOOLS';
const originalLegacyFlowToolsEnv = process.env[LEGACY_FLOW_TOOLS_ENV];

function restoreLegacyFlowToolsEnv(): void {
  if (originalLegacyFlowToolsEnv === undefined) {
    delete process.env[LEGACY_FLOW_TOOLS_ENV];
    return;
  }
  process.env[LEGACY_FLOW_TOOLS_ENV] = originalLegacyFlowToolsEnv;
}

function exposeLegacyFlowTools(): void {
  process.env[LEGACY_FLOW_TOOLS_ENV] = '1';
}

describe('dynamic published flow tools', () => {
  beforeEach(() => {
    restoreLegacyFlowToolsEnv();
    clearDynamicFlowCacheForSession('dynamic-flow-tools');
    clearDynamicFlowCacheForSession('dynamic-flow-tools-descriptor');
    clearDynamicFlowCacheForSession('dynamic-flow-call');
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-run');
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-run-list');
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-call');
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-missing');
    clearDynamicFlowCacheForSession('dynamic-flow-conflict');
  });

  afterEach(() => {
    restoreLegacyFlowToolsEnv();
  });

  it('maps V3 published variables into dynamic tool schemas when legacy listing is enabled', async () => {
    exposeLegacyFlowTools();
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
    expect(
      (signupTool?.inputSchema as { properties?: Record<string, any> }).properties?.background,
    ).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('uses published descriptor schemas and metadata for legacy dynamic workflow tools', async () => {
    exposeLegacyFlowTools();
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [
        {
          id: 'flow-signup',
          slug: 'signup',
          description: 'Published signup flow',
          parameters: {
            type: 'object',
            required: ['email', 'background'],
            additionalProperties: false,
            properties: {
              email: {
                type: 'string',
                description: 'Email address',
              },
              apiToken: {
                type: 'string',
                description: 'Sensitive value; default is not exposed.',
              },
              background: {
                type: 'string',
                description: 'Reserved variable name',
              },
            },
          },
          backgroundSupport: {
            supported: false,
            modes: ['currentTab', 'newTab'],
            caveats: ['Node shot uses foreground capture.'],
          },
          sideEffects: {
            summary: {
              safe: 1,
              idempotent: 0,
              dangerous: 1,
              unknown: 0,
            },
          },
        },
      ],
    });
    const ctx = createContext('dynamic-flow-tools-descriptor', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const signupTool = tools.find((tool) => tool.name === 'flow.signup');
    const input = signupTool?.inputSchema as {
      properties?: Record<string, any>;
      required?: string[];
    };

    expect(signupTool?.description).toContain('Background execution: not supported');
    expect(signupTool?.description).toContain('Side effects: safe 1, idempotent 0, dangerous 1');
    expect(input.required).toEqual(['email']);
    expect(input.properties?.email).toMatchObject({
      type: 'string',
      description: 'Email address',
    });
    expect(input.properties?.apiToken).toMatchObject({
      type: 'string',
      description: 'Sensitive value; default is not exposed.',
    });
    expect(input.properties?.background).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(input.properties?.debugStepByStep).toBeUndefined();
    expect(input.properties?.captureStepScreenshots).toBeUndefined();
    expect(input.properties?.screenshotBaselines).toBeUndefined();
  });

  it('hides per-workflow dynamic tools by default while exposing workflow_run', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [
        {
          id: 'flow-signup',
          slug: 'signup',
          description: 'Published signup flow',
        },
      ],
    });
    const ctx = createContext('dynamic-flow-workflow-run-list', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);

    expect(tools.find((tool) => tool.name === 'workflow_run')).toBeTruthy();
    expect(tools.find((tool) => tool.name === 'flow.signup')).toBeUndefined();
  });

  it('exposes a compact workflow_run tool with workflow slugs as an enum', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [
        {
          id: 'flow-signup',
          slug: 'signup',
          description: 'Published signup flow',
        },
        {
          id: 'flow-checkout',
          slug: 'checkout',
          meta: { tool: { description: 'Complete checkout' } },
        },
      ],
    });
    const ctx = createContext('dynamic-flow-workflow-run', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const workflowRunTool = tools.find((tool) => tool.name === 'workflow_run');
    const input = workflowRunTool?.inputSchema as {
      properties?: Record<string, any>;
      required?: string[];
    };

    expect(workflowRunTool?.description).toContain('signup: Published signup flow');
    expect(workflowRunTool?.description).toContain('checkout: Complete checkout');
    expect(input.required).toEqual(['workflow']);
    expect(input.properties?.workflow).toMatchObject({
      type: 'string',
      enum: ['signup', 'checkout'],
    });
    expect(input.properties?.args).toMatchObject({
      type: 'object',
      additionalProperties: true,
    });
    expect(input.properties?.background).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('runs workflow_run by resolving a published slug to the existing flow runner', async () => {
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        items: [
          {
            id: 'flow-signup',
            slug: 'signup',
            variables: [{ name: 'email', required: true }],
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
    const ctx = createContext('dynamic-flow-workflow-call', sendRequestToExtensionAndWait);

    const result = await callToolForContext(ctx, 'workflow_run', {
      workflow: 'signup',
      args: { email: 'alice@example.com' },
      background: true,
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
          },
          background: true,
          refresh: true,
          timeoutMs: 5000,
        },
        meta: { mcpSessionId: 'dynamic-flow-workflow-call', instanceId: 'unit-test' },
      },
      NativeMessageType.CALL_TOOL,
      120000,
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });
  });

  it('does not forward workflow_run debug options that are not publicly supported', async () => {
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        items: [
          {
            id: 'flow-signup',
            slug: 'signup',
            variables: [{ name: 'email', required: true }],
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
    const ctx = createContext('dynamic-flow-workflow-debug-options', sendRequestToExtensionAndWait);

    await callToolForContext(ctx, 'workflow_run', {
      workflow: 'signup',
      args: { email: 'alice@example.com' },
      debugStepByStep: true,
      captureStepScreenshots: true,
      screenshotBaselines: { 'fill-email': 'base64' },
    });

    expect(sendRequestToExtensionAndWait).toHaveBeenNthCalledWith(
      2,
      {
        name: 'record_replay_flow_run',
        args: {
          flowId: 'flow-signup',
          args: {
            email: 'alice@example.com',
          },
        },
        meta: {
          mcpSessionId: 'dynamic-flow-workflow-debug-options',
          instanceId: 'unit-test',
        },
      },
      NativeMessageType.CALL_TOOL,
      120000,
    );
  });

  it('returns available workflow slugs when workflow_run cannot resolve a slug', async () => {
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        items: [{ id: 'flow-signup', slug: 'signup' }],
      })
      .mockResolvedValueOnce({
        status: 'success',
        items: [{ id: 'flow-signup', slug: 'signup' }],
      });
    const ctx = createContext('dynamic-flow-workflow-missing', sendRequestToExtensionAndWait);

    const result = await callToolForContext(ctx, 'workflow_run', {
      workflow: 'checkout',
      args: {},
    });

    expect(sendRequestToExtensionAndWait).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Error resolving workflow_run: Workflow not found: checkout. Available workflows: signup',
        },
      ],
      isError: true,
    });
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
    exposeLegacyFlowTools();
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

describe('public tool exposure', () => {
  it('rejects direct calls to tools that are not exposed in listTools', async () => {
    const sendRequestToExtensionAndWait = vi.fn();
    const ctx = createContext('hidden-tool-call', sendRequestToExtensionAndWait);

    const result = await callToolForContext(ctx, 'chrome_inject_script', {
      type: 'MAIN',
      jsScript: 'return 1;',
    });

    expect(sendRequestToExtensionAndWait).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error calling tool: Tool not found: chrome_inject_script' }],
      isError: true,
    });
  });
});
