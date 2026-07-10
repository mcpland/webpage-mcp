import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  AGENT_ATTACHMENT_RPC_CHUNK_BYTES,
  isAgentRpcRequestPayload,
  type AgentRpcRequestPayload,
  type AgentRpcResponsePayload,
} from 'webpage-mcp-shared';

function readErrorMessage(payload: AgentRpcResponsePayload): string {
  if (payload.json && typeof payload.json === 'object') {
    const error = (payload.json as Record<string, unknown>).error;
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
  }
  if (typeof payload.body === 'string' && payload.body.trim()) {
    return payload.body;
  }
  return `Agent RPC failed: ${payload.statusCode}`;
}

function responseHeaders(payload: AgentRpcResponsePayload): Headers {
  const headers = new Headers();
  const rawHeaders = payload.headers || {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.map((item) => String(item)).join(', '));
    }
  }
  return headers;
}

function decodeBase64Body(payload: AgentRpcResponsePayload): Uint8Array {
  const base64 = payload.base64Body || '';
  const decoded = atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function toBlob(payload: AgentRpcResponsePayload): Blob {
  const contentType = responseHeaders(payload).get('content-type') || 'application/octet-stream';
  return new Blob([copyToArrayBuffer(decodeBase64Body(payload))], {
    type: contentType,
  });
}

interface ParsedContentRange {
  start: number;
  end: number;
  total: number;
}

function parseContentRange(value: string | null): ParsedContentRange | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end ||
    total > AGENT_ATTACHMENT_MAX_BYTES
  ) {
    return null;
  }
  return { start, end, total };
}

function withAttachmentRange(payload: AgentRpcRequestPayload, offset: number): AgentRpcRequestPayload {
  return {
    ...payload,
    query: {
      ...payload.query,
      offset,
      limit: AGENT_ATTACHMENT_RPC_CHUNK_BYTES,
    },
  };
}

export class AgentRpcError extends Error {
  public readonly statusCode: number;
  public readonly response: AgentRpcResponsePayload;

  constructor(response: AgentRpcResponsePayload) {
    super(readErrorMessage(response));
    this.name = 'AgentRpcError';
    this.statusCode = response.statusCode;
    this.response = response;
  }
}

export function parseAgentRpcJson<T = unknown>(response: AgentRpcResponsePayload): T {
  if (response.json !== undefined && response.json !== null) {
    return response.json as T;
  }
  if (typeof response.body === 'string' && response.body.length > 0) {
    return JSON.parse(response.body) as T;
  }
  return {} as T;
}

export async function requestAgentRpcFetch(
  payload: AgentRpcRequestPayload,
): Promise<AgentRpcResponsePayload> {
  if (!isAgentRpcRequestPayload(payload)) {
    throw new Error('Invalid agent_rpc payload: operation is required');
  }

  const response = await chrome.runtime.sendMessage({
    type: BACKGROUND_MESSAGE_TYPES.AGENT_RPC_FETCH,
    payload,
  });

  if (!response?.success || !response.payload) {
    throw new Error(response?.error || 'Agent RPC request failed');
  }

  return response.payload as AgentRpcResponsePayload;
}

export async function requestAgentRpcJson<T = unknown>(
  payload: AgentRpcRequestPayload,
): Promise<T> {
  const response = await requestAgentRpcFetch(payload);
  if (!response.ok) {
    throw new AgentRpcError(response);
  }
  return parseAgentRpcJson<T>(response);
}

export async function requestAgentRpcBlob(payload: AgentRpcRequestPayload): Promise<Blob> {
  const response = await requestAgentRpcFetch(payload);
  if (!response.ok) {
    throw new AgentRpcError(response);
  }
  return toBlob(response);
}

/**
 * Fetch an attachment across bounded native-messaging responses and verify
 * every range before assembling the final Blob.
 */
export async function requestAgentRpcBlobInChunks(payload: AgentRpcRequestPayload): Promise<Blob> {
  let expectedOffset = 0;
  let expectedTotal: number | null = null;
  let contentType: string | null = null;
  const chunks: ArrayBuffer[] = [];

  while (expectedTotal === null || expectedOffset < expectedTotal) {
    const response = await requestAgentRpcFetch(withAttachmentRange(payload, expectedOffset));
    if (!response.ok) {
      throw new AgentRpcError(response);
    }

    const headers = responseHeaders(response);
    const responseContentType = headers.get('content-type') || 'application/octet-stream';
    const contentRange = parseContentRange(headers.get('content-range'));
    const bytes = decodeBase64Body(response);

    // Compatibility with an older host that ignores range parameters.
    if (response.statusCode === 200 && !contentRange && expectedOffset === 0) {
      if (bytes.length > AGENT_ATTACHMENT_MAX_BYTES) {
        throw new Error('Agent attachment response exceeds the maximum size');
      }
      return new Blob([copyToArrayBuffer(bytes)], {
        type: responseContentType,
      });
    }

    if (response.statusCode !== 206 || !contentRange) {
      throw new Error('Invalid ranged agent attachment response');
    }
    if (
      contentRange.start !== expectedOffset ||
      contentRange.end - contentRange.start + 1 !== bytes.length ||
      bytes.length === 0 ||
      bytes.length > AGENT_ATTACHMENT_RPC_CHUNK_BYTES
    ) {
      throw new Error('Agent attachment response contains a discontinuous range');
    }
    if (expectedTotal !== null && contentRange.total !== expectedTotal) {
      throw new Error('Agent attachment size changed during transfer');
    }
    if (contentType !== null && responseContentType !== contentType) {
      throw new Error('Agent attachment content type changed during transfer');
    }

    const contentLength = headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== bytes.length) {
      throw new Error('Agent attachment content length does not match its range');
    }

    expectedTotal = contentRange.total;
    contentType = responseContentType;
    chunks.push(copyToArrayBuffer(bytes));
    expectedOffset = contentRange.end + 1;
  }

  return new Blob(chunks, { type: contentType || 'application/octet-stream' });
}

export async function subscribeAgentStream(
  sessionId: string,
  options?: { instanceId?: string; subscriptionId?: string },
): Promise<{ subscriptionId: string }> {
  const response = await chrome.runtime.sendMessage({
    type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_SUBSCRIBE,
    payload: {
      sessionId,
      instanceId: options?.instanceId,
      subscriptionId: options?.subscriptionId,
    },
  });

  if (!response?.success || typeof response.subscriptionId !== 'string') {
    throw new Error(response?.error || 'Failed to subscribe agent stream');
  }

  return { subscriptionId: response.subscriptionId };
}

export async function unsubscribeAgentStream(subscriptionId: string): Promise<void> {
  await chrome.runtime.sendMessage({
    type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_UNSUBSCRIBE,
    payload: { subscriptionId },
  });
}
