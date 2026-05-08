import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeMessageType } from 'webpage-mcp-shared';
import {
  callToolForContext,
  clearDynamicFlowCacheForSession,
  listToolsForContext,
  resolveMcpClientCapabilities,
  type McpClientCapabilityFallback,
  type McpToolContext,
} from './register-tools';

function createContext(
  sessionId: string,
  sendRequestToExtensionAndWait: ReturnType<typeof vi.fn>,
  clientCapabilities?: Partial<McpClientCapabilityFallback>,
): McpToolContext {
  return {
    sessionId,
    instanceId: 'unit-test',
    nativeHost: {
      sendRequestToExtensionAndWait,
    } as unknown as McpToolContext['nativeHost'],
    clientCapabilities: clientCapabilities
      ? {
          ...resolveMcpClientCapabilities(),
          ...clientCapabilities,
        }
      : undefined,
  };
}

function expectedForwardedMeta(sessionId: string) {
  return expect.objectContaining({
    mcpSessionId: sessionId,
    instanceId: 'unit-test',
    clientCapabilities: expect.objectContaining({
      toolListChanged: expect.any(Boolean),
      resourceReferences: expect.any(Boolean),
      cancellation: expect.any(Boolean),
      structuredErrors: expect.any(Boolean),
      largeResults: expect.any(Boolean),
      source: expect.any(String),
      warnings: expect.any(Array),
    }),
  });
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
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-run-enum');
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-run-list');
    clearDynamicFlowCacheForSession('dynamic-flow-capability-filter');
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-call');
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-capability-call');
    clearDynamicFlowCacheForSession('direct-flow-run-capability-call');
    clearDynamicFlowCacheForSession('unsupported-capability-call');
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-missing');
    clearDynamicFlowCacheForSession('dynamic-flow-conflict');
    clearDynamicFlowCacheForSession('dynamic-flow-cache-invalidation');
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-refresh');
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

  it('exposes workflow_stabilize with strict safety schema', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [],
    });
    const ctx = createContext('workflow-stabilize-schema', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const stabilizeTool = tools.find((tool) => tool.name === 'workflow_stabilize');
    const input = stabilizeTool?.inputSchema as {
      additionalProperties?: boolean;
      oneOf?: unknown[];
      allOf?: unknown[];
      properties?: Record<string, any>;
    };

    expect(input.additionalProperties).toBe(false);
    expect(input.oneOf).toHaveLength(2);
    expect(input.allOf).toHaveLength(2);
    expect(input.properties?.tabTarget).toMatchObject({
      type: 'string',
      enum: ['current', 'new'],
    });
    expect(input.properties?.safety?.additionalProperties).toBe(false);
    expect(input.properties?.safety?.properties?.executionMode).toMatchObject({
      enum: ['auto', 'analyzeOnly', 'sandboxReplay', 'userApprovedReplay'],
    });
    expect(input.properties?.safety?.properties?.nodeRiskOverrides).toMatchObject({
      additionalProperties: false,
    });
    expect(
      input.properties?.safety?.properties?.nodeRiskOverrides?.patternProperties?.[
        '^[A-Za-z0-9_.:-]+$'
      ],
    ).toMatchObject({
      enum: ['safe', 'idempotent', 'dangerous'],
    });
  });

  it('exposes workflow_repair_rollback with guarded rollback schema', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [],
    });
    const ctx = createContext('workflow-repair-rollback-schema', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const rollbackTool = tools.find((tool) => tool.name === 'workflow_repair_rollback');
    const input = rollbackTool?.inputSchema as {
      additionalProperties?: boolean;
      oneOf?: unknown[];
      allOf?: unknown[];
      properties?: Record<string, any>;
    };

    expect(input.additionalProperties).toBe(false);
    expect(input.oneOf).toHaveLength(2);
    expect(input.allOf).toHaveLength(1);
    expect(input.properties?.repairRevision).toMatchObject({
      type: 'string',
    });
    expect(input.properties?.requireCurrentRevision).toMatchObject({
      type: 'string',
    });
    expect(input.properties?.dryRun).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('exposes record_replay_run_cancel with terminal wait controls', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [],
    });
    const ctx = createContext('record-replay-run-cancel-schema', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const cancelTool = tools.find((tool) => tool.name === 'record_replay_run_cancel');
    const input = cancelTool?.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, any>;
    };

    expect(input.additionalProperties).toBe(false);
    expect(input.required).toEqual(['runId']);
    expect(input.properties?.waitForTerminal).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(input.properties?.timeoutMs).toMatchObject({
      type: 'number',
      minimum: 100,
      maximum: 30000,
    });
  });

  it('exposes workflow publish and unpublish MCP tools', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [],
    });
    const ctx = createContext('workflow-publish-schema', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const publishTool = tools.find((tool) => tool.name === 'workflow_publish');
    const unpublishTool = tools.find((tool) => tool.name === 'workflow_unpublish');

    expect(publishTool?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['flowId'],
      properties: {
        requireStable: {
          default: true,
        },
        requireVerified: {
          default: false,
        },
        allowUnverified: {
          default: false,
        },
      },
    });
    expect(unpublishTool?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        flowId: expect.any(Object),
        workflow: expect.any(Object),
      },
    });
  });

  it('uses a plain workflow string when client tool-list refresh support is unknown', async () => {
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
    expect(workflowRunTool?.description).toContain('validated at runtime');
    expect(input.required).toEqual(['workflow']);
    expect(input.properties?.workflow).toMatchObject({
      type: 'string',
    });
    expect(input.properties?.workflow.enum).toBeUndefined();
    expect(input.properties?.args).toMatchObject({
      type: 'object',
      additionalProperties: true,
    });
    expect(input.properties?.background).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('adds workflow slug enum when the client declares tool-list refresh support', async () => {
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
          description: 'Published checkout flow',
        },
      ],
    });
    const ctx = createContext('dynamic-flow-workflow-run-enum', sendRequestToExtensionAndWait, {
      toolListChanged: true,
      source: 'initialize',
      warnings: [],
    });

    const tools = await listToolsForContext(ctx);
    const workflowRunTool = tools.find((tool) => tool.name === 'workflow_run');
    const input = workflowRunTool?.inputSchema as {
      properties?: Record<string, any>;
    };

    expect(workflowRunTool?.description).toContain('currently published slugs');
    expect(input.properties?.workflow).toMatchObject({
      type: 'string',
      enum: ['signup', 'checkout'],
    });
  });

  it('uses extension capability handshake data to filter unsupported run options', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      capabilities: {
        protocolVersion: '2026-05-09',
        capabilityVersion: 'cap-test',
        extensionVersion: 'ext-test',
        supportedTools: ['record_replay_flow_run', 'record_replay_list_published'],
        supportedRunOptions: ['tabTarget', 'timeoutMs'],
        featureFlags: ['workflow_run'],
      },
      items: [
        {
          id: 'flow-signup',
          slug: 'signup',
          description: 'Published signup flow',
        },
      ],
    });
    const ctx = createContext('dynamic-flow-capability-filter', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const workflowRunTool = tools.find((tool) => tool.name === 'workflow_run');
    const flowRunTool = tools.find((tool) => tool.name === 'record_replay_flow_run');
    const workflowInput = workflowRunTool?.inputSchema as {
      properties?: Record<string, any>;
    };
    const flowRunInput = flowRunTool?.inputSchema as {
      properties?: Record<string, any>;
    };

    expect(sendRequestToExtensionAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        handshake: expect.objectContaining({
          protocolVersion: '2026-05-09',
          mcpServerVersion: expect.any(String),
        }),
      }),
      'rr_list_published_flows',
      20000,
    );
    expect(workflowInput.properties?.tabTarget).toBeTruthy();
    expect(workflowInput.properties?.timeoutMs).toBeTruthy();
    expect(workflowInput.properties?.background).toBeUndefined();
    expect(workflowInput.properties?.refresh).toBeUndefined();
    expect(workflowInput.properties?.captureNetwork).toBeUndefined();
    expect(workflowInput.properties?.returnLogs).toBeUndefined();
    expect(flowRunInput.properties?.flowId).toBeTruthy();
    expect(flowRunInput.properties?.args).toBeTruthy();
    expect(flowRunInput.properties?.tabTarget).toBeTruthy();
    expect(flowRunInput.properties?.timeoutMs).toBeTruthy();
    expect(flowRunInput.properties?.background).toBeUndefined();
    expect(flowRunInput.properties?.captureNetwork).toBeUndefined();
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
        meta: expectedForwardedMeta('dynamic-flow-workflow-call'),
      },
      NativeMessageType.CALL_TOOL,
      120000,
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });
  });

  it('does not forward workflow_run options that the extension capability handshake does not support', async () => {
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        capabilities: {
          supportedRunOptions: ['background'],
        },
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
    const ctx = createContext('dynamic-flow-workflow-capability-call', sendRequestToExtensionAndWait);

    await callToolForContext(ctx, 'workflow_run', {
      workflow: 'signup',
      args: { email: 'alice@example.com' },
      background: true,
      refresh: true,
      timeoutMs: 5000,
      startUrl: 'https://example.com/start',
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
        },
        meta: expectedForwardedMeta('dynamic-flow-workflow-capability-call'),
      },
      NativeMessageType.CALL_TOOL,
      120000,
    );
  });

  it('filters direct record_replay_flow_run args using extension capabilities', async () => {
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        capabilities: {
          supportedTools: ['record_replay_flow_run'],
          supportedRunOptions: ['background'],
        },
        items: [],
      })
      .mockResolvedValueOnce({
        status: 'success',
        data: {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
          isError: false,
        },
      });
    const ctx = createContext('direct-flow-run-capability-call', sendRequestToExtensionAndWait);

    await callToolForContext(ctx, 'record_replay_flow_run', {
      flowId: 'flow-signup',
      requireRevision: 'rev-signup',
      args: { email: 'alice@example.com' },
      background: true,
      refresh: true,
      captureNetwork: true,
    });

    expect(sendRequestToExtensionAndWait).toHaveBeenNthCalledWith(
      2,
      {
        name: 'record_replay_flow_run',
        args: {
          flowId: 'flow-signup',
          requireRevision: 'rev-signup',
          args: { email: 'alice@example.com' },
          background: true,
        },
        meta: expectedForwardedMeta('direct-flow-run-capability-call'),
      },
      NativeMessageType.CALL_TOOL,
      120000,
    );
  });

  it('invalidates the published workflow cache after successful publish mutations', async () => {
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        items: [{ id: 'flow-before', slug: 'before' }],
      })
      .mockResolvedValueOnce({
        status: 'success',
        data: {
          content: [{ type: 'text', text: JSON.stringify({ success: true, published: true }) }],
          isError: false,
        },
      })
      .mockResolvedValueOnce({
        status: 'success',
        items: [{ id: 'flow-after', slug: 'after' }],
      });
    const ctx = createContext('dynamic-flow-cache-invalidation', sendRequestToExtensionAndWait, {
      toolListChanged: true,
    });

    const beforeTools = await listToolsForContext(ctx);
    const beforeWorkflowRun = beforeTools.find((tool) => tool.name === 'workflow_run');
    expect((beforeWorkflowRun?.inputSchema as any).properties.workflow.enum).toEqual(['before']);

    const publishResult = await callToolForContext(ctx, 'workflow_publish', {
      flowId: 'flow-after',
      slug: 'after',
    });
    expect(publishResult.isError).toBe(false);

    const afterTools = await listToolsForContext(ctx);
    const afterWorkflowRun = afterTools.find((tool) => tool.name === 'workflow_run');
    expect((afterWorkflowRun?.inputSchema as any).properties.workflow.enum).toEqual(['after']);
    expect(sendRequestToExtensionAndWait).toHaveBeenCalledTimes(3);
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
        meta: expectedForwardedMeta('dynamic-flow-workflow-debug-options'),
      },
      NativeMessageType.CALL_TOOL,
      120000,
    );
  });

  it('returns available workflow slugs when workflow_run cannot resolve a slug', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValueOnce({
      status: 'success',
      items: [{ id: 'flow-signup', slug: 'signup' }],
    });
    const ctx = createContext('dynamic-flow-workflow-missing', sendRequestToExtensionAndWait);

    const result = await callToolForContext(ctx, 'workflow_run', {
      workflow: 'checkout',
      args: {},
    });

    expect(sendRequestToExtensionAndWait).toHaveBeenCalledTimes(1);
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

  it('refreshes the published descriptor before workflow_run execution', async () => {
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        items: [{ id: 'flow-old', slug: 'signup', revision: 'rev-old' }],
      })
      .mockResolvedValueOnce({
        status: 'success',
        items: [{ id: 'flow-new', slug: 'signup', revision: 'rev-new' }],
      })
      .mockResolvedValueOnce({
        status: 'success',
        data: {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
          isError: false,
        },
      });
    const ctx = createContext('dynamic-flow-workflow-refresh', sendRequestToExtensionAndWait);

    await listToolsForContext(ctx);
    await callToolForContext(ctx, 'workflow_run', {
      workflow: 'signup',
      args: { email: 'alice@example.com' },
    });

    expect(sendRequestToExtensionAndWait).toHaveBeenNthCalledWith(
      3,
      {
        name: 'record_replay_flow_run',
        args: {
          flowId: 'flow-new',
          requireRevision: 'rev-new',
          args: {
            email: 'alice@example.com',
          },
        },
        meta: expectedForwardedMeta('dynamic-flow-workflow-refresh'),
      },
      NativeMessageType.CALL_TOOL,
      120000,
    );
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
        meta: expectedForwardedMeta('dynamic-flow-call'),
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
      3,
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
        meta: expectedForwardedMeta('dynamic-flow-conflict'),
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

  it('rejects public tool calls hidden by extension capabilities', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValueOnce({
      status: 'success',
      capabilities: {
        supportedTools: ['record_replay_list_published'],
        supportedRunOptions: [],
      },
      items: [],
    });
    const ctx = createContext('unsupported-capability-call', sendRequestToExtensionAndWait);

    const result = await callToolForContext(ctx, 'record_replay_flow_run', {
      flowId: 'flow-signup',
    });

    expect(sendRequestToExtensionAndWait).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Error calling tool: Tool not supported by connected extension capability set: record_replay_flow_run',
        },
      ],
      isError: true,
    });
  });
});
