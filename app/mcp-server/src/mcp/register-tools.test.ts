import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NativeMessageType,
  TOOL_SCHEMAS,
  WEBPAGE_MCP_CAPABILITY_VERSION,
  WEBPAGE_MCP_PROTOCOL_VERSION,
  WEBPAGE_MCP_SUPPORTED_WORKFLOW_RUN_OPTIONS,
} from 'webpage-mcp-shared';
import {
  DYNAMIC_FLOW_LIMITS,
  callToolForContext,
  clearDynamicFlowCacheForSession,
  listToolsForContext,
  resolveMcpClientCapabilities,
  setupTools,
  type McpClientCapabilityFallback,
  type McpToolContext,
} from './register-tools';

type RegisteredRequestHandler = (request: any, extra: { signal: AbortSignal }) => Promise<any>;

describe('SDK request cancellation', () => {
  it('passes the MCP request signal to extension tool work', async () => {
    const sessionId = 'sdk-cancellation';
    clearDynamicFlowCacheForSession(sessionId);
    const sendRequestToExtensionAndWait = vi.fn(
      (_payload: unknown, messageType: string, _timeoutMs: number, signal?: AbortSignal) => {
        if (messageType === 'rr_list_published_flows') {
          return Promise.resolve({
            status: 'success',
            items: [],
            capabilities: DEFAULT_TEST_EXTENSION_CAPABILITIES,
          });
        }
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('cancelled by MCP client');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      },
    );
    const context = createContext(sessionId, sendRequestToExtensionAndWait, undefined, {
      injectDefaultExtensionCapabilities: false,
    });
    const handlers: RegisteredRequestHandler[] = [];
    const fakeServer = {
      setRequestHandler: (_schema: unknown, handler: RegisteredRequestHandler) => {
        handlers.push(handler);
      },
      getClientCapabilities: () => ({ experimental: { cancellation: true } }),
    } as unknown as Parameters<typeof setupTools>[0];
    setupTools(fakeServer, context);

    const controller = new AbortController();
    const callResult = handlers[1](
      {
        params: {
          name: 'get_windows_and_tabs',
          arguments: {},
        },
      },
      { signal: controller.signal },
    );

    await vi.waitFor(() => {
      expect(sendRequestToExtensionAndWait).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'get_windows_and_tabs' }),
        NativeMessageType.CALL_TOOL,
        120000,
        controller.signal,
      );
    });
    controller.abort();

    await expect(callResult).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps a shared flow lookup alive when one caller is cancelled', async () => {
    const sessionId = 'shared-list-cancellation';
    clearDynamicFlowCacheForSession(sessionId);
    let resolveHandshake!: (value: unknown) => void;
    const sendRequestToExtensionAndWait = vi.fn(
      (_payload: unknown, messageType: string, _timeoutMs: number, signal?: AbortSignal) => {
        expect(messageType).toBe('rr_list_published_flows');
        expect(signal).toBeUndefined();
        return new Promise((resolve) => {
          resolveHandshake = resolve;
        });
      },
    );
    const firstController = new AbortController();
    const firstContext = {
      ...createContext(sessionId, sendRequestToExtensionAndWait, undefined, {
        injectDefaultExtensionCapabilities: false,
      }),
      signal: firstController.signal,
    };
    const secondContext = createContext(sessionId, sendRequestToExtensionAndWait, undefined, {
      injectDefaultExtensionCapabilities: false,
    });

    const firstList = listToolsForContext(firstContext);
    await vi.waitFor(() => expect(sendRequestToExtensionAndWait).toHaveBeenCalledOnce());
    const secondList = listToolsForContext(secondContext);

    firstController.abort();
    await expect(firstList).rejects.toMatchObject({ name: 'AbortError' });

    resolveHandshake({
      status: 'success',
      items: [],
      capabilities: DEFAULT_TEST_EXTENSION_CAPABILITIES,
    });
    await expect(secondList).resolves.toEqual(expect.any(Array));
    expect(sendRequestToExtensionAndWait).toHaveBeenCalledOnce();
    clearDynamicFlowCacheForSession(sessionId);
  });
});

function createContext(
  sessionId: string,
  sendRequestToExtensionAndWait: ReturnType<typeof vi.fn>,
  clientCapabilities?: Partial<McpClientCapabilityFallback>,
  options: { injectDefaultExtensionCapabilities?: boolean } = {},
): McpToolContext {
  const nativeSendRequestToExtensionAndWait =
    options.injectDefaultExtensionCapabilities === false
      ? sendRequestToExtensionAndWait
      : vi.fn(async (...args: any[]) => {
          const response = await sendRequestToExtensionAndWait(...args);
          if (
            args[1] === 'rr_list_published_flows' &&
            response &&
            typeof response === 'object' &&
            !Array.isArray(response)
          ) {
            const responseRecord = response as Record<string, unknown>;
            const items = Array.isArray(responseRecord.items)
              ? responseRecord.items.map((item, index) =>
                  item &&
                  typeof item === 'object' &&
                  !Array.isArray(item) &&
                  !Object.prototype.hasOwnProperty.call(item, 'revision')
                    ? { ...item, revision: `unit-test-revision-${index}` }
                    : item,
                )
              : responseRecord.items;
            return {
              ...responseRecord,
              ...(items !== undefined ? { items } : {}),
              ...(!Object.prototype.hasOwnProperty.call(responseRecord, 'capabilities')
                ? { capabilities: DEFAULT_TEST_EXTENSION_CAPABILITIES }
                : {}),
            };
          }
          return response;
        });
  return {
    sessionId,
    instanceId: 'unit-test',
    nativeHost: {
      sendRequestToExtensionAndWait: nativeSendRequestToExtensionAndWait,
    } as unknown as McpToolContext['nativeHost'],
    clientCapabilities: clientCapabilities
      ? {
          ...resolveMcpClientCapabilities(),
          ...clientCapabilities,
        }
      : undefined,
  };
}

const DEFAULT_TEST_EXTENSION_CAPABILITIES = {
  protocolVersion: WEBPAGE_MCP_PROTOCOL_VERSION,
  capabilityVersion: WEBPAGE_MCP_CAPABILITY_VERSION,
  extensionVersion: 'unit-test-extension',
  supportedTools: TOOL_SCHEMAS.map((tool) => tool.name),
  supportedRunOptions: [...WEBPAGE_MCP_SUPPORTED_WORKFLOW_RUN_OPTIONS],
  featureFlags: ['unit_test_default_capabilities'],
};

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
    clearDynamicFlowCacheForSession('capability-fallback-conservative');
    clearDynamicFlowCacheForSession('capability-omitted-conservative');
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-missing');
    clearDynamicFlowCacheForSession('dynamic-flow-conflict');
    clearDynamicFlowCacheForSession('dynamic-flow-cache-invalidation');
    clearDynamicFlowCacheForSession('dynamic-flow-workflow-refresh');
    clearDynamicFlowCacheForSession('flow-update-schema');
    clearDynamicFlowCacheForSession('dynamic-flow-resource-bounds');
    clearDynamicFlowCacheForSession('dynamic-flow-late-invalidation');
    clearDynamicFlowCacheForSession('dynamic-flow-run-option-fail-closed');
    clearDynamicFlowCacheForSession('dynamic-flow-force-after-list');
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
    expect(
      (signupTool?.inputSchema as { properties?: Record<string, any> }).properties?.metadata,
    ).toHaveProperty('anyOf');
    expect(
      (signupTool?.inputSchema as { properties?: Record<string, any> }).properties?.background,
    ).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('bounds and deduplicates untrusted published flow descriptors', async () => {
    exposeLegacyFlowTools();
    let deepSchema: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth < DYNAMIC_FLOW_LIMITS.maxDepth + 4; depth += 1) {
      deepSchema = { nested: deepSchema };
    }
    const parameterProperties = Object.fromEntries(
      Array.from({ length: DYNAMIC_FLOW_LIMITS.maxObjectEntries }, (_, index) => [
        `field${index}`,
        index === 0
          ? {
              description: 'Sensitive value',
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['secretRef'],
                  properties: {
                    secretRef: { type: 'string', minLength: 1 },
                    scope: {
                      type: 'string',
                      enum: ['session', 'profile', 'workflow'],
                    },
                  },
                },
              ],
            }
          : { type: 'string', description: `Field ${index}` },
      ]),
    );
    const validItems = Array.from({ length: DYNAMIC_FLOW_LIMITS.maxFlows + 16 }, (_, index) => ({
      id: `flow-${index}`,
      slug: `bounded-${index}`,
      revision: `revision-${index}`,
      ...(index === 0
        ? {
            description: '\u0000'.repeat(DYNAMIC_FLOW_LIMITS.maxStringBytes * 2),
            parameters: {
              type: 'object',
              properties: parameterProperties,
              required: Object.keys(parameterProperties),
            },
            exampleArgs: { ignored: 'x'.repeat(100_000) },
            outputs: [{ ignored: 'x'.repeat(100_000) }],
          }
        : index === 1
          ? {
              parameters: {
                type: 'object',
                properties: { poison: deepSchema },
                required: ['poison'],
              },
              variables: [{ name: 'fallbackVariable', required: true }],
            }
          : index === 2
            ? {
                parameters: {
                  type: 'object',
                  properties: { safe: { type: 'string' } },
                  required: ['__proto__', 'constructor', 'safe'],
                },
              }
            : index === 3
              ? { variables: [{ name: '__proto__', required: true }] }
              : {}),
    }));
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [
        {
          id: 'x'.repeat(DYNAMIC_FLOW_LIMITS.maxIdentifierBytes + 1),
          slug: 'invalid-id',
        },
        { id: 'invalid-slug', slug: 'Not A Tool' },
        {
          id: 'invalid-revision',
          slug: 'invalid-revision',
          revision: 'x'.repeat(DYNAMIC_FLOW_LIMITS.maxIdentifierBytes + 1),
        },
        validItems[0],
        {
          id: 'duplicate-id',
          slug: 'bounded-0',
          revision: 'duplicate-revision',
        },
        {
          id: 'flow-0',
          slug: 'duplicate-slug',
          revision: 'duplicate-revision',
        },
        ...validItems.slice(1),
      ],
    });
    const ctx = createContext('dynamic-flow-resource-bounds', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const dynamicTools = tools.filter((tool) => tool.name.startsWith('flow.'));
    const first = dynamicTools.find((tool) => tool.name === 'flow.bounded-0');
    const fallback = dynamicTools.find((tool) => tool.name === 'flow.bounded-1');
    const protectedRequired = dynamicTools.find((tool) => tool.name === 'flow.bounded-2');
    const unsafeVariable = dynamicTools.find((tool) => tool.name === 'flow.bounded-3');
    const firstProperties = (first?.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    const fallbackSchema = fallback?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const protectedSchema = protectedRequired?.inputSchema as {
      required?: string[];
    };
    const unsafeProperties = (
      unsafeVariable?.inputSchema as {
        properties?: Record<string, unknown>;
      }
    ).properties;

    expect(dynamicTools).toHaveLength(DYNAMIC_FLOW_LIMITS.maxFlows);
    expect(new Set(dynamicTools.map((tool) => tool.name)).size).toBe(dynamicTools.length);
    expect(Buffer.byteLength(first?.description ?? '', 'utf8')).toBeLessThanOrEqual(
      DYNAMIC_FLOW_LIMITS.maxStringBytes,
    );
    expect(
      Object.keys(firstProperties ?? {}).filter((key) => key.startsWith('field')),
    ).toHaveLength(DYNAMIC_FLOW_LIMITS.maxObjectEntries);
    expect(firstProperties?.field0).toMatchObject({
      anyOf: [
        { type: 'string' },
        {
          properties: {
            scope: { enum: ['session', 'profile', 'workflow'] },
          },
        },
      ],
    });
    expect(JSON.stringify(first?.inputSchema)).not.toContain('ignored');
    expect(Buffer.byteLength(JSON.stringify(first?.inputSchema), 'utf8')).toBeLessThan(
      DYNAMIC_FLOW_LIMITS.maxDescriptorBytesPerResponse,
    );
    expect(fallbackSchema.properties?.poison).toBeUndefined();
    expect(fallbackSchema.properties?.fallbackVariable).toBeTruthy();
    expect(fallbackSchema.required).toContain('fallbackVariable');
    expect(protectedSchema.required).toEqual(['safe']);
    expect(Object.prototype.hasOwnProperty.call(unsafeProperties, '__proto__')).toBe(false);
    expect(dynamicTools.find((tool) => tool.name === 'flow.invalid-revision')).toBeUndefined();
  });

  it('caps simultaneous dynamic flow handshakes across sessions', async () => {
    let resolveHandshake!: (value: unknown) => void;
    const handshake = new Promise((resolve) => {
      resolveHandshake = resolve;
    });
    const sendRequestToExtensionAndWait = vi.fn().mockReturnValue(handshake);
    const pending: Array<Promise<unknown>> = [];
    const sessionIds: string[] = [];
    const overflowSessionId = 'dynamic-flow-capacity-overflow';
    sessionIds.push(overflowSessionId);
    const handshakeResponse = {
      status: 'success',
      items: [],
      capabilities: DEFAULT_TEST_EXTENSION_CAPABILITIES,
    };
    const settledSender = vi.fn().mockResolvedValue(handshakeResponse);
    try {
      const settledCount =
        DYNAMIC_FLOW_LIMITS.maxCachedSessions - DYNAMIC_FLOW_LIMITS.maxConcurrentHandshakes;
      for (let index = 0; index < settledCount; index += 1) {
        const sessionId = `dynamic-flow-settled-${index}`;
        sessionIds.push(sessionId);
        await listToolsForContext(createContext(sessionId, settledSender));
      }
      for (let index = 0; index < DYNAMIC_FLOW_LIMITS.maxConcurrentHandshakes; index += 1) {
        const sessionId = `dynamic-flow-capacity-${index}`;
        sessionIds.push(sessionId);
        pending.push(listToolsForContext(createContext(sessionId, sendRequestToExtensionAndWait)));
      }
      await vi.waitFor(() =>
        expect(sendRequestToExtensionAndWait).toHaveBeenCalledTimes(
          DYNAMIC_FLOW_LIMITS.maxConcurrentHandshakes,
        ),
      );

      await expect(
        listToolsForContext(createContext(overflowSessionId, sendRequestToExtensionAndWait)),
      ).rejects.toThrow('Dynamic flow handshake capacity reached');
      expect(sendRequestToExtensionAndWait).toHaveBeenCalledTimes(
        DYNAMIC_FLOW_LIMITS.maxConcurrentHandshakes,
      );
      await expect(
        listToolsForContext(createContext('dynamic-flow-settled-0', settledSender)),
      ).resolves.toEqual(expect.any(Array));
      expect(settledSender).toHaveBeenCalledTimes(settledCount);

      resolveHandshake(handshakeResponse);
      await Promise.all(pending);
      await expect(
        listToolsForContext(createContext(overflowSessionId, sendRequestToExtensionAndWait)),
      ).resolves.toEqual(expect.any(Array));
      expect(sendRequestToExtensionAndWait).toHaveBeenCalledTimes(
        DYNAMIC_FLOW_LIMITS.maxConcurrentHandshakes + 1,
      );
    } finally {
      resolveHandshake(handshakeResponse);
      await Promise.allSettled(pending);
      for (const sessionId of sessionIds) clearDynamicFlowCacheForSession(sessionId);
    }
  });

  it('does not repopulate a cleared session from a late flow handshake', async () => {
    exposeLegacyFlowTools();
    let resolveFirst!: (value: unknown) => void;
    const firstHandshake = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockReturnValueOnce(firstHandshake)
      .mockResolvedValueOnce({
        status: 'success',
        items: [{ id: 'flow-new', slug: 'new-flow' }],
      });
    const sessionId = 'dynamic-flow-late-invalidation';
    const ctx = createContext(sessionId, sendRequestToExtensionAndWait);
    const firstList = listToolsForContext(ctx);
    await vi.waitFor(() => expect(sendRequestToExtensionAndWait).toHaveBeenCalledOnce());

    clearDynamicFlowCacheForSession(sessionId);
    const queuedRefresh = listToolsForContext(ctx);
    resolveFirst({
      status: 'success',
      items: [{ id: 'flow-stale', slug: 'stale-flow' }],
      capabilities: DEFAULT_TEST_EXTENSION_CAPABILITIES,
    });
    expect((await firstList).find((tool) => tool.name === 'flow.stale-flow')).toBeUndefined();

    const refreshed = await queuedRefresh;
    expect(sendRequestToExtensionAndWait).toHaveBeenCalledTimes(2);
    expect(refreshed.find((tool) => tool.name === 'flow.new-flow')).toBeTruthy();
    expect(refreshed.find((tool) => tool.name === 'flow.stale-flow')).toBeUndefined();
  });

  it('queues a force refresh behind an ordinary in-flight flow lookup', async () => {
    let resolveOrdinary!: (value: unknown) => void;
    const ordinaryHandshake = new Promise((resolve) => {
      resolveOrdinary = resolve;
    });
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockReturnValueOnce(ordinaryHandshake)
      .mockResolvedValueOnce({
        status: 'success',
        items: [{ id: 'flow-new', slug: 'signup', revision: 'revision-new' }],
      })
      .mockResolvedValueOnce({
        status: 'success',
        data: {
          content: [{ type: 'text', text: 'ran new flow' }],
          isError: false,
        },
      });
    const sessionId = 'dynamic-flow-force-after-list';
    const ctx = createContext(sessionId, sendRequestToExtensionAndWait);
    const ordinaryList = listToolsForContext(ctx);
    await vi.waitFor(() => expect(sendRequestToExtensionAndWait).toHaveBeenCalledOnce());

    const run = callToolForContext(ctx, 'workflow_run', {
      workflow: 'signup',
      args: {},
    });
    expect(sendRequestToExtensionAndWait).toHaveBeenCalledOnce();
    resolveOrdinary({
      status: 'success',
      items: [{ id: 'flow-old', slug: 'signup', revision: 'revision-old' }],
      capabilities: DEFAULT_TEST_EXTENSION_CAPABILITIES,
    });

    await ordinaryList;
    await run;
    expect(sendRequestToExtensionAndWait).toHaveBeenNthCalledWith(
      3,
      {
        name: 'record_replay_flow_run',
        args: {
          flowId: 'flow-new',
          requireRevision: 'revision-new',
          args: {},
        },
        meta: expectedForwardedMeta(sessionId),
      },
      NativeMessageType.CALL_TOOL,
      120000,
    );
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

  it('exposes flow_update with a current revision guard', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [],
    });
    const ctx = createContext('flow-update-schema', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const updateTool = tools.find((tool) => tool.name === 'flow_update');
    const input = updateTool?.inputSchema as {
      properties?: Record<string, any>;
    };

    expect(input.properties?.requireCurrentRevision).toMatchObject({
      type: 'string',
    });
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

  it('exposes workflow_migrate with dry-run/apply/rollback guards', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [],
    });
    const ctx = createContext('workflow-migrate-schema', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const migrateTool = tools.find((tool) => tool.name === 'workflow_migrate');
    const input = migrateTool?.inputSchema as {
      additionalProperties?: boolean;
      oneOf?: unknown[];
      allOf?: unknown[];
      properties?: Record<string, any>;
    };

    expect(input.additionalProperties).toBe(false);
    expect(input.oneOf).toHaveLength(3);
    expect(input.allOf).toHaveLength(1);
    expect(input.properties?.all).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(input.properties?.dryRun).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(input.properties?.rollbackMigrationId).toMatchObject({
      type: 'string',
    });
  });

  it('exposes workflow_approval_store without approval creation operations', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [],
    });
    const ctx = createContext('workflow-approval-store-schema', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const approvalTool = tools.find((tool) => tool.name === 'workflow_approval_store');
    const input = approvalTool?.inputSchema as {
      additionalProperties?: boolean;
      properties?: Record<string, any>;
    };

    expect(input.additionalProperties).toBe(false);
    expect(input.properties?.operation).toMatchObject({
      type: 'string',
      enum: ['list', 'get', 'revoke'],
    });
    expect(input.properties?.operation.enum).not.toContain('create');
    expect(input.properties?.approvalId).toMatchObject({
      type: 'string',
    });
  });

  it('exposes workflow_release_readiness with default-on SLO checklist controls', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockResolvedValue({
      status: 'success',
      items: [],
    });
    const ctx = createContext('workflow-release-readiness-schema', sendRequestToExtensionAndWait);

    const tools = await listToolsForContext(ctx);
    const readinessTool = tools.find((tool) => tool.name === 'workflow_release_readiness');
    const input = readinessTool?.inputSchema as {
      additionalProperties?: boolean;
      allOf?: unknown[];
      properties?: Record<string, any>;
    };

    expect(input.additionalProperties).toBe(false);
    expect(input.allOf).toHaveLength(1);
    expect(input.properties?.defaultOn).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(input.properties?.minSafeWorkflowCount).toMatchObject({
      type: 'number',
      default: 30,
    });
    expect(input.properties?.minValidationRuns).toMatchObject({
      type: 'number',
      default: 100,
    });
    expect(input.properties?.evidence?.additionalProperties).toBe(false);
    expect(input.properties?.evidence?.properties?.pairedTokenBaselineCount).toMatchObject({
      type: 'number',
      minimum: 0,
    });
    expect(input.properties?.evidence?.properties?.safetyReviewCompleted).toMatchObject({
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
      oneOf: [{ required: ['flowId'] }, { required: ['workflow'] }],
      allOf: [
        {
          not: {
            required: ['flowId', 'workflow'],
          },
        },
      ],
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
    expect(flowRunInput.properties?.requireRevision).toBeTruthy();
    expect(flowRunInput.properties?.args).toBeTruthy();
    expect(flowRunInput.properties?.tabTarget).toBeTruthy();
    expect(flowRunInput.properties?.timeoutMs).toBeTruthy();
    expect(flowRunInput.properties?.background).toBeUndefined();
    expect(flowRunInput.properties?.captureNetwork).toBeUndefined();
    expect(flowRunInput.properties?.returnLogs).toBeUndefined();
  });

  it('fails closed when the advertised run-option list is empty after bounding', async () => {
    const sendRequestToExtensionAndWait = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        capabilities: {
          protocolVersion: WEBPAGE_MCP_PROTOCOL_VERSION,
          capabilityVersion: WEBPAGE_MCP_CAPABILITY_VERSION,
          extensionVersion: 'bounded-test',
          supportedTools: ['record_replay_flow_run'],
          supportedRunOptions: [
            ...Array.from(
              { length: DYNAMIC_FLOW_LIMITS.maxCapabilityEntries * 2 },
              (_, index) => `unknown-${index}`,
            ),
            'background',
          ],
          featureFlags: [],
        },
        items: [],
      })
      .mockResolvedValueOnce({
        status: 'success',
        data: { content: [{ type: 'text', text: 'ok' }], isError: false },
      });
    const ctx = createContext('dynamic-flow-run-option-fail-closed', sendRequestToExtensionAndWait);

    await callToolForContext(ctx, 'record_replay_flow_run', {
      flowId: 'flow-signup',
      background: true,
    });

    expect(sendRequestToExtensionAndWait).toHaveBeenNthCalledWith(
      2,
      {
        name: 'record_replay_flow_run',
        args: { flowId: 'flow-signup' },
        meta: expectedForwardedMeta('dynamic-flow-run-option-fail-closed'),
      },
      NativeMessageType.CALL_TOOL,
      120000,
    );
  });

  it('hides extension-backed tools when the capability handshake fails', async () => {
    const sendRequestToExtensionAndWait = vi.fn().mockRejectedValue(new Error('extension offline'));
    const ctx = createContext(
      'capability-fallback-conservative',
      sendRequestToExtensionAndWait,
      undefined,
      { injectDefaultExtensionCapabilities: false },
    );

    const tools = await listToolsForContext(ctx);

    expect(tools).toEqual([]);
    expect(sendRequestToExtensionAndWait).toHaveBeenCalledTimes(1);
  });

  it('does not infer workflow support when the extension omits capability data', async () => {
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
    const ctx = createContext(
      'capability-omitted-conservative',
      sendRequestToExtensionAndWait,
      undefined,
      { injectDefaultExtensionCapabilities: false },
    );

    const tools = await listToolsForContext(ctx);
    const result = await callToolForContext(ctx, 'workflow_run', {
      workflow: 'signup',
    });

    expect(tools.find((tool) => tool.name === 'workflow_run')).toBeUndefined();
    expect(tools.find((tool) => tool.name === 'record_replay_flow_run')).toBeUndefined();
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Error resolving workflow_run: workflow_run is not supported by the connected extension capability set.',
        },
      ],
      isError: true,
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
          requireRevision: 'unit-test-revision-0',
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
          supportedTools: ['record_replay_flow_run', 'record_replay_list_published'],
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
    const ctx = createContext(
      'dynamic-flow-workflow-capability-call',
      sendRequestToExtensionAndWait,
    );

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
          requireRevision: 'unit-test-revision-0',
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
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, published: true }),
            },
          ],
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
          requireRevision: 'unit-test-revision-0',
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
          requireRevision: 'unit-test-revision-0',
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
      description:
        'Optional start URL to open before running. Only http:// and https:// URLs are allowed.',
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
          requireRevision: 'unit-test-revision-0',
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
      content: [
        {
          type: 'text',
          text: 'Error calling tool: Tool not found: chrome_inject_script',
        },
      ],
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
