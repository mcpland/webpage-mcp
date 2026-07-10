import { describe, expect, it } from 'vitest';
import {
  AGENT_STREAM_LIMITS,
  agentStreamUtf8Bytes,
  sanitizeAgentStreamRelayPayload,
} from '@/common/agent-stream-boundaries';

describe('Agent stream relay boundaries', () => {
  const baseMessage = {
    subscriptionId: 'subscription-1',
    instanceId: 'default',
    sessionId: 'session-1',
    event: {
      type: 'message',
      data: {
        id: 'message-1',
        sessionId: 'session-1',
        requestId: 'request-1',
        role: 'assistant',
        content: 'done',
        messageType: 'chat',
        createdAt: new Date(0).toISOString(),
      },
    },
  };

  it('preserves a valid bounded event', () => {
    expect(sanitizeAgentStreamRelayPayload(baseMessage)).toEqual(baseMessage);
  });

  it('truncates large visible text and drops oversized metadata', () => {
    const result = sanitizeAgentStreamRelayPayload({
      ...baseMessage,
      event: {
        ...baseMessage.event,
        data: {
          ...baseMessage.event.data,
          content: 'x'.repeat(AGENT_STREAM_LIMITS.maxMessageContentBytes + 100),
          metadata: { note: 'm'.repeat(AGENT_STREAM_LIMITS.maxMetadataBytes + 1) },
        },
      },
    });

    expect(result?.event.type).toBe('message');
    if (result?.event.type !== 'message') throw new Error('expected message event');
    expect(agentStreamUtf8Bytes(result.event.data.content)).toBe(
      AGENT_STREAM_LIMITS.maxMessageContentBytes,
    );
    expect(result.event.data.metadata).toBeUndefined();
  });

  it.each([
    null,
    {},
    { subscriptionId: 's', event: { type: 'unknown' } },
    {
      subscriptionId: 's'.repeat(AGENT_STREAM_LIMITS.maxIdentifierBytes + 1),
      event: baseMessage.event,
    },
    {
      subscriptionId: 's',
      event: { type: 'status', data: { sessionId: 'session-1', status: 'forged' } },
    },
    {
      subscriptionId: 's',
      event: {
        type: 'usage',
        data: {
          sessionId: 'session-1',
          inputTokens: Infinity,
          outputTokens: 1,
          totalCostUsd: 0,
          durationMs: 1,
          numTurns: 1,
        },
      },
    },
  ])('rejects malformed relay payload %#', (payload) => {
    expect(sanitizeAgentStreamRelayPayload(payload)).toBeNull();
  });
});
