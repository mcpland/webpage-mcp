import { describe, expect, it } from 'vitest';
import { listPublishedFlowDetails } from '@/entrypoints/background/record-replay-v3/flows/publish';
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
        name: 'apiToken',
        sensitive: true,
        default: 'super-secret-token',
      },
    ],
    createdAt: iso as any,
    updatedAt: iso as any,
    meta: {
      tool: {
        published: true,
        slug: 'sensitive-flow',
      },
    },
  };
}

describe('listPublishedFlowDetails', () => {
  it('omits sensitive variables and defaults from published flow discovery', () => {
    const details = listPublishedFlowDetails([createPublishedFlow()]);

    expect(details).toEqual([
      expect.objectContaining({
        id: 'flow-sensitive',
        slug: 'sensitive-flow',
        variables: [
          {
            name: 'email',
            label: 'Email',
            default: 'alice@example.com',
          },
        ],
      }),
    ]);
  });
});
