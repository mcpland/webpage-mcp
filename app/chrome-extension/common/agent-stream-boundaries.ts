import {
  AGENT_STREAM_MAX_ERROR_BYTES,
  AGENT_STREAM_MAX_EVENTS_PER_REQUEST,
  AGENT_STREAM_MAX_JSON_BYTES_PER_REQUEST,
  AGENT_STREAM_MAX_STATUS_MESSAGE_BYTES,
  type RealtimeEvent,
} from 'webpage-mcp-shared';

export const AGENT_STREAM_LIMITS = Object.freeze({
  maxRelayBytes: 128 * 1_024,
  maxMessageContentBytes: 64 * 1_024,
  maxMetadataBytes: 16 * 1_024,
  maxStatusMessageBytes: AGENT_STREAM_MAX_STATUS_MESSAGE_BYTES,
  maxErrorBytes: AGENT_STREAM_MAX_ERROR_BYTES,
  maxIdentifierBytes: 256,
  maxShortTextBytes: 256,
  maxEventsPerRequest: AGENT_STREAM_MAX_EVENTS_PER_REQUEST,
  maxBytesPerRequest: AGENT_STREAM_MAX_JSON_BYTES_PER_REQUEST,
});

export interface AgentStreamRelayPayload {
  subscriptionId: string;
  instanceId?: string;
  sessionId?: string;
  event: RealtimeEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function agentStreamUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function readIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (
    value.length > AGENT_STREAM_LIMITS.maxIdentifierBytes ||
    agentStreamUtf8Bytes(value) > AGENT_STREAM_LIMITS.maxIdentifierBytes
  ) {
    return undefined;
  }
  return value;
}

function truncateText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string') return '';
  if (value.length <= maxBytes && agentStreamUtf8Bytes(value) <= maxBytes) return value;
  const encoded = new TextEncoder().encode(value.slice(0, maxBytes));
  return new TextDecoder().decode(encoded.slice(0, maxBytes));
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (
      serialized.length > AGENT_STREAM_LIMITS.maxMetadataBytes ||
      agentStreamUtf8Bytes(serialized) > AGENT_STREAM_LIMITS.maxMetadataBytes
    ) {
      return undefined;
    }
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sanitizeMessageEvent(data: Record<string, unknown>): RealtimeEvent | null {
  const id = readIdentifier(data.id);
  const sessionId = readIdentifier(data.sessionId);
  const requestId = readIdentifier(data.requestId);
  const roles = new Set(['user', 'assistant', 'tool', 'system']);
  const messageTypes = new Set(['chat', 'tool_use', 'tool_result', 'status']);
  if (
    !id ||
    !sessionId ||
    typeof data.role !== 'string' ||
    !roles.has(data.role) ||
    typeof data.messageType !== 'string' ||
    !messageTypes.has(data.messageType) ||
    typeof data.content !== 'string'
  ) {
    return null;
  }
  const metadata = boundedMetadata(data.metadata);
  return {
    type: 'message',
    data: {
      id,
      sessionId,
      role: data.role as 'user' | 'assistant' | 'tool' | 'system',
      content: truncateText(data.content, AGENT_STREAM_LIMITS.maxMessageContentBytes),
      messageType: data.messageType as 'chat' | 'tool_use' | 'tool_result' | 'status',
      createdAt: truncateText(data.createdAt, AGENT_STREAM_LIMITS.maxShortTextBytes),
      ...(typeof data.cliSource === 'string'
        ? { cliSource: truncateText(data.cliSource, AGENT_STREAM_LIMITS.maxShortTextBytes) }
        : {}),
      ...(requestId ? { requestId } : {}),
      ...(typeof data.isStreaming === 'boolean' ? { isStreaming: data.isStreaming } : {}),
      ...(typeof data.isFinal === 'boolean' ? { isFinal: data.isFinal } : {}),
      ...(metadata ? { metadata } : {}),
    },
  };
}

function sanitizeStatusEvent(data: Record<string, unknown>): RealtimeEvent | null {
  const sessionId = readIdentifier(data.sessionId);
  const requestId = readIdentifier(data.requestId);
  const statuses = new Set(['starting', 'ready', 'running', 'completed', 'error', 'cancelled']);
  if (!sessionId || typeof data.status !== 'string' || !statuses.has(data.status)) return null;
  return {
    type: 'status',
    data: {
      sessionId,
      status: data.status as
        | 'starting'
        | 'ready'
        | 'running'
        | 'completed'
        | 'error'
        | 'cancelled',
      ...(typeof data.message === 'string'
        ? { message: truncateText(data.message, AGENT_STREAM_LIMITS.maxStatusMessageBytes) }
        : {}),
      ...(requestId ? { requestId } : {}),
    },
  };
}

function sanitizeUsageEvent(data: Record<string, unknown>): RealtimeEvent | null {
  const sessionId = readIdentifier(data.sessionId);
  const requestId = readIdentifier(data.requestId);
  const inputTokens = finiteNonNegative(data.inputTokens);
  const outputTokens = finiteNonNegative(data.outputTokens);
  const totalCostUsd = finiteNonNegative(data.totalCostUsd);
  const durationMs = finiteNonNegative(data.durationMs);
  const numTurns = finiteNonNegative(data.numTurns);
  if (
    !sessionId ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalCostUsd === undefined ||
    durationMs === undefined ||
    numTurns === undefined
  ) {
    return null;
  }
  const cacheReadInputTokens = finiteNonNegative(data.cacheReadInputTokens);
  const cacheCreationInputTokens = finiteNonNegative(data.cacheCreationInputTokens);
  return {
    type: 'usage',
    data: {
      sessionId,
      ...(requestId ? { requestId } : {}),
      inputTokens,
      outputTokens,
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
      ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
      totalCostUsd,
      durationMs,
      numTurns,
    },
  };
}

function sanitizeEvent(value: unknown): RealtimeEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  const data = isRecord(value.data) ? value.data : undefined;

  if (value.type === 'message' && data) return sanitizeMessageEvent(data);
  if (value.type === 'status' && data) return sanitizeStatusEvent(data);
  if (value.type === 'usage' && data) return sanitizeUsageEvent(data);

  if (value.type === 'error') {
    if (typeof value.error !== 'string') return null;
    const sessionId = readIdentifier(data?.sessionId);
    const requestId = readIdentifier(data?.requestId);
    return {
      type: 'error',
      error: truncateText(value.error, AGENT_STREAM_LIMITS.maxErrorBytes),
      ...(sessionId || requestId
        ? { data: { ...(sessionId ? { sessionId } : {}), ...(requestId ? { requestId } : {}) } }
        : {}),
    };
  }

  if (value.type === 'connected' && data) {
    const sessionId = readIdentifier(data.sessionId);
    if (
      !sessionId ||
      (data.transport !== 'sse' &&
        data.transport !== 'websocket' &&
        data.transport !== 'native-messaging')
    ) {
      return null;
    }
    return {
      type: 'connected',
      data: {
        sessionId,
        transport: data.transport,
        timestamp: truncateText(data.timestamp, AGENT_STREAM_LIMITS.maxShortTextBytes),
      },
    };
  }

  if (value.type === 'heartbeat' && data) {
    return {
      type: 'heartbeat',
      data: { timestamp: truncateText(data.timestamp, AGENT_STREAM_LIMITS.maxShortTextBytes) },
    };
  }

  return null;
}

export function sanitizeAgentStreamRelayPayload(value: unknown): AgentStreamRelayPayload | null {
  if (!isRecord(value)) return null;
  const subscriptionId = readIdentifier(value.subscriptionId);
  const instanceId = readIdentifier(value.instanceId);
  const sessionId = readIdentifier(value.sessionId);
  const event = sanitizeEvent(value.event);
  if (!subscriptionId || !event) return null;
  const result: AgentStreamRelayPayload = {
    subscriptionId,
    ...(instanceId ? { instanceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    event,
  };
  const serialized = JSON.stringify(result);
  if (
    serialized.length > AGENT_STREAM_LIMITS.maxRelayBytes ||
    agentStreamUtf8Bytes(serialized) > AGENT_STREAM_LIMITS.maxRelayBytes
  ) {
    return null;
  }
  return result;
}
