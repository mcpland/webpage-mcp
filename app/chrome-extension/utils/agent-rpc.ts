import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

export interface AgentRpcFetchRequest {
  instanceId?: string;
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface AgentRpcFetchPayload {
  ok: boolean;
  statusCode: number;
  headers?: Record<string, unknown>;
  body?: string;
  json?: unknown;
  isBinary?: boolean;
  base64Body?: string | null;
}

class AgentRpcResponse {
  private readonly payload: AgentRpcFetchPayload;

  constructor(payload: AgentRpcFetchPayload) {
    this.payload = payload;
  }

  get ok(): boolean {
    return this.payload.ok;
  }

  get status(): number {
    return this.payload.statusCode;
  }

  get headers(): Headers {
    const headers = new Headers();
    const raw = this.payload.headers || {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') {
        headers.set(key, value);
      } else if (Array.isArray(value)) {
        headers.set(key, value.map((item) => String(item)).join(', '));
      }
    }
    return headers;
  }

  async json<T = any>(): Promise<T> {
    if (this.payload.json !== undefined && this.payload.json !== null) {
      return this.payload.json as T;
    }
    if (this.payload.body) {
      return JSON.parse(this.payload.body) as T;
    }
    return {} as T;
  }

  async text(): Promise<string> {
    if (typeof this.payload.body === 'string') {
      return this.payload.body;
    }
    return '';
  }

  async blob(): Promise<Blob> {
    const contentType = this.headers.get('content-type') || 'application/octet-stream';
    const base64 = this.payload.base64Body || '';
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: contentType });
  }
}

function parseLocalPathAndQuery(raw: string): {
  path: string;
  query?: Record<string, string | string[]>;
} {
  if (!raw) {
    return { path: '/' };
  }

  try {
    const parsed =
      raw.startsWith('http://') || raw.startsWith('https://')
        ? new URL(raw)
        : new URL(raw, 'https://native.bridge.local');
    const query: Record<string, string | string[]> = {};
    for (const [key, value] of parsed.searchParams.entries()) {
      const existing = query[key];
      if (existing === undefined) {
        query[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[key] = [existing, value];
      }
    }
    return {
      path: parsed.pathname || '/',
      query: Object.keys(query).length > 0 ? query : undefined,
    };
  } catch {
    return { path: raw.startsWith('/') ? raw : `/${raw}` };
  }
}

function normalizeHeaders(init?: RequestInit): Record<string, string> | undefined {
  const headers = new Headers(init?.headers || {});
  const entries: Record<string, string> = {};
  headers.forEach((value, key) => {
    entries[key] = value;
  });
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function normalizeMethod(init?: RequestInit): string {
  const method = init?.method?.trim();
  return method ? method.toUpperCase() : 'GET';
}

function normalizeBody(init?: RequestInit): unknown {
  const body = init?.body;
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return body;
  }
  return body;
}

export async function requestAgentRpcFetch(
  payload: AgentRpcFetchRequest,
): Promise<AgentRpcFetchPayload> {
  const response = await chrome.runtime.sendMessage({
    type: BACKGROUND_MESSAGE_TYPES.AGENT_RPC_FETCH,
    payload,
  });

  if (!response?.success || !response.payload) {
    throw new Error(response?.error || 'Agent RPC request failed');
  }

  return response.payload as AgentRpcFetchPayload;
}

export async function agentFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<AgentRpcResponse> {
  const rawUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : '';

  const { path, query } = parseLocalPathAndQuery(rawUrl);

  const payload = await requestAgentRpcFetch({
    method: normalizeMethod(init),
    path,
    query,
    body: normalizeBody(init),
    headers: normalizeHeaders(init),
  });

  return new AgentRpcResponse(payload);
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
