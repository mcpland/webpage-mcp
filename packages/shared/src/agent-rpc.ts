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
  return typeof record.operation === 'string' && record.operation.trim().length > 0;
}
