import { describe, expect, it } from 'vitest';
import {
  buildWorkflowBackgroundSupport,
  calculateWorkflowRevision,
  listPublishedFlowDetails,
} from '@/entrypoints/background/record-replay-v3/flows/publish';
import type { FlowV3 } from '@/entrypoints/background/record-replay-v3/domain/flow';

function createPublishedFlow(): FlowV3 {
  const iso = new Date(0).toISOString();
  return {
    schemaVersion: 3,
    id: 'flow-sensitive' as any,
    name: 'Sensitive Flow',
    entryNodeId: 'node-1' as any,
    nodes: [{ id: 'node-1' as any, kind: 'navigate', config: { url: 'https://example.com' } }],
    edges: [],
    variables: [
      {
        name: 'email',
        label: 'Email',
        default: 'alice@example.com',
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
      {
        name: 'apiToken',
        sensitive: true,
        default: 'super-secret-token',
      },
      {
        name: 'sessionToken',
        default: 'opaque-value',
      },
      {
        name: 'apiKey',
        default: 'opaque-value',
      },
      {
        name: 'metadata',
        default: { headers: { authorization: 'Bearer opaque-value' } },
      },
    ],
    createdAt: iso as any,
    updatedAt: iso as any,
    meta: {
      tool: {
        published: true,
        slug: 'sensitive-flow',
        description: 'Run the sensitive flow',
      },
      recording: {
        originUrl: 'https://internal.example.com/checkout',
        originTitle: 'Internal Checkout',
      },
    },
  };
}

describe('listPublishedFlowDetails', () => {
  it('omits sensitive variables while preserving public type metadata', () => {
    const details = listPublishedFlowDetails([createPublishedFlow()]);

    expect(details).toEqual([
      expect.objectContaining({
        id: 'flow-sensitive',
        slug: 'sensitive-flow',
        revision: expect.stringMatching(/^rev-fnv1a32-/),
        schemaHash: expect.stringMatching(/^fnv1a32:/),
        version: 3,
        name: 'Sensitive Flow',
        description: 'Run the sensitive flow',
        variables: [
          {
            name: 'email',
            label: 'Email',
            default: 'alice@example.com',
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
        parameters: expect.objectContaining({
          type: 'object',
          additionalProperties: false,
          properties: expect.objectContaining({
            email: expect.objectContaining({
              type: 'string',
              title: 'Email',
              default: 'alice@example.com',
            }),
            plan: expect.objectContaining({
              type: 'string',
              enum: ['free', 'pro'],
            }),
            scores: expect.objectContaining({
              type: 'array',
              items: { type: 'number' },
            }),
            apiToken: expect.not.objectContaining({ default: 'super-secret-token' }),
            metadata: expect.not.objectContaining({
              default: { headers: { authorization: 'Bearer opaque-value' } },
            }),
          }),
        }),
        exampleArgs: expect.objectContaining({
          email: 'alice@example.com',
          plan: 'free',
          scores: [],
          apiToken: '<apiToken>',
          sessionToken: '<sessionToken>',
          apiKey: '<apiKey>',
          metadata: '<metadata>',
        }),
        backgroundSupport: {
          supported: true,
          modes: ['currentTab', 'newTab', 'background'],
          caveats: [],
        },
        sideEffects: expect.objectContaining({
          summary: {
            safe: 0,
            idempotent: 1,
            dangerous: 0,
            unknown: 0,
          },
        }),
      }),
    ]);
  });

  it('calculates canonical revisions from executable workflow fields', () => {
    const flow = createPublishedFlow();
    const baseline = calculateWorkflowRevision(flow);

    expect(
      calculateWorkflowRevision({
        ...flow,
        createdAt: new Date(1).toISOString() as any,
        updatedAt: new Date(2).toISOString() as any,
        meta: {
          ...flow.meta,
          recording: {
            originUrl: 'https://changed.example.com',
          },
        },
      }),
    ).toBe(baseline);

    expect(
      calculateWorkflowRevision({
        ...flow,
        nodes: [
          {
            ...flow.nodes[0],
            config: { url: 'https://changed.example.com' },
          },
        ],
      }),
    ).not.toBe(baseline);
  });

  it('omits builder trigger nodes from side-effect metadata', () => {
    const flow = createPublishedFlow();
    flow.nodes = [
      {
        id: 'trigger-1' as any,
        kind: 'trigger',
        config: { enabled: true },
      },
      {
        id: 'node-1' as any,
        kind: 'navigate',
        config: { url: 'https://example.com' },
      },
    ];

    const [details] = listPublishedFlowDetails([flow]);

    expect(details.sideEffects.summary).toEqual({
      safe: 0,
      idempotent: 1,
      dangerous: 0,
      unknown: 0,
    });
    expect(details.sideEffects.nodes.map((node) => node.kind)).toEqual([
      'navigate',
    ]);
  });

  it('classifies JavaScript extract nodes as dangerous in side-effect metadata', () => {
    const flow = createPublishedFlow();
    flow.nodes = [
      {
        id: 'extract-1' as any,
        kind: 'extract',
        config: {
          mode: 'js',
          code: "localStorage.setItem('replayed', '1'); return document.title;",
          saveAs: 'title',
        },
      },
    ];

    const [details] = listPublishedFlowDetails([flow]);

    expect(details.sideEffects.summary).toEqual({
      safe: 0,
      idempotent: 0,
      dangerous: 1,
      unknown: 0,
    });
    expect(details.sideEffects.nodes[0]).toEqual(
      expect.objectContaining({
        id: 'extract-1',
        kind: 'extract',
        sideEffect: expect.objectContaining({
          category: 'dangerous',
          retry: 'explicit',
        }),
      }),
    );
  });
});

describe('buildWorkflowBackgroundSupport', () => {
  it('does not treat an empty screenshot selector as foreground-only', () => {
    const flow = createPublishedFlow();
    flow.nodes = [
      {
        id: 'node-1' as any,
        kind: 'screenshot',
        config: { selector: '', fullPage: false },
      },
    ];

    expect(buildWorkflowBackgroundSupport(flow)).toEqual({
      supported: true,
      modes: ['currentTab', 'newTab', 'background'],
      caveats: [],
    });
  });

  it('flags concrete selector screenshot capture as foreground-only', () => {
    const flow = createPublishedFlow();
    flow.nodes = [
      {
        id: 'node-1' as any,
        kind: 'screenshot',
        config: { selector: 'main', fullPage: false },
      },
    ];

    expect(buildWorkflowBackgroundSupport(flow)).toEqual({
      supported: false,
      modes: ['currentTab', 'newTab'],
      caveats: [
        'Node node-1 uses full-page or selector screenshot capture, which requires foreground capture.',
      ],
    });
  });
});
