export const AGENT_RPC_OPERATIONS = [
  'health.ping',
  'agent.engines.list',
  'agent.projects.list',
  'agent.projects.upsert',
  'agent.projects.validatePath',
  'agent.projects.createDirectory',
  'agent.projects.defaultWorkspace',
  'agent.projects.defaultRoot',
  'agent.projects.pickDirectory',
  'agent.projects.sessions.list',
  'agent.projects.sessions.create',
  'agent.projects.claudeInfo',
  'agent.projects.open',
  'agent.projects.openFile',
  'agent.projects.delete',
  'agent.sessions.list',
  'agent.sessions.get',
  'agent.sessions.update',
  'agent.sessions.delete',
  'agent.sessions.history',
  'agent.sessions.reset',
  'agent.sessions.claudeInfo',
  'agent.sessions.open',
  'agent.chat.messages.list',
  'agent.chat.messages.delete',
  'agent.chat.messages.create',
  'agent.chat.act',
  'agent.chat.cancelRequest',
  'agent.chat.cancelCurrent',
  'agent.chat.stream',
  'agent.attachments.stats',
  'agent.attachments.get',
  'agent.attachments.deleteByProject',
  'agent.attachments.deleteAll',
] as const;

/** Maximum persisted attachment size accepted by the agent APIs. */
export const AGENT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Raw attachment bytes per ranged RPC response. Base64 plus the native
 * messaging envelope remains comfortably below Chrome's 1 MiB output limit.
 */
export const AGENT_ATTACHMENT_RPC_CHUNK_BYTES = 512 * 1024;

/**
 * Largest attachment that may use the legacy one-response RPC shape. The
 * extra headroom is reserved for Base64 expansion and the JSON envelope.
 */
export const AGENT_ATTACHMENT_RPC_INLINE_BYTES = 700 * 1024;
export const AGENT_RPC_OPERATION_MAX_BYTES = 128;

function isUtf8LengthAtMost(value: string, maximumBytes: number): boolean {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes > maximumBytes) return false;
  }
  return true;
}

export type AgentRpcOperation = (typeof AGENT_RPC_OPERATIONS)[number] | (string & {});

export interface AgentRpcRequestPayload {
  instanceId?: string;
  operation: AgentRpcOperation;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface AgentRpcResponsePayload {
  ok: boolean;
  statusCode: number;
  headers?: Record<string, unknown>;
  body?: string;
  json?: unknown;
  isBinary?: boolean;
  base64Body?: string | null;
}

export function isAgentRpcRequestPayload(value: unknown): value is AgentRpcRequestPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.operation === 'string' &&
    isUtf8LengthAtMost(record.operation, AGENT_RPC_OPERATION_MAX_BYTES) &&
    record.operation.trim().length > 0
  );
}
