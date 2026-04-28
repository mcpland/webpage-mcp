import { describe, expect, it } from 'vitest';
import {
  buildWorkflowBackgroundSupport,
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
