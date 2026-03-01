import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import {
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

function toBlob(payload: AgentRpcResponsePayload): Blob {
  const headers = new Headers();
  const rawHeaders = payload.headers || {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.map((item) => String(item)).join(', '));
    }
  }
  const contentType = headers.get('content-type') || 'application/octet-stream';
  const base64 = payload.base64Body || '';
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: contentType });
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
