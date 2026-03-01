import { DEFAULT_MCP_INSTANCE_ID } from 'webpage-mcp-shared';

export interface SessionContext {
  tabId?: number;
  windowId?: number;
  updatedAt: number;
}

const sessionContexts = new Map<string, SessionContext>();
const SESSION_CONTEXT_TTL_MS = 30 * 60 * 1000;
const SESSION_CONTEXT_MAX_ENTRIES = 500;

function normalizeInstanceId(instanceId?: string): string {
  const trimmed = instanceId?.trim();
  return trimmed || DEFAULT_MCP_INSTANCE_ID;
}

function buildSessionKey(sessionId: string, instanceId?: string): string {
  return `${normalizeInstanceId(instanceId)}:${sessionId}`;
}

function pruneExpiredSessionContexts(now = Date.now()): void {
  for (const [sessionId, ctx] of sessionContexts.entries()) {
    if (now - ctx.updatedAt > SESSION_CONTEXT_TTL_MS) {
      sessionContexts.delete(sessionId);
    }
  }
}

function enforceSessionContextCapacity(): void {
  if (sessionContexts.size <= SESSION_CONTEXT_MAX_ENTRIES) {
    return;
  }
  const entries = Array.from(sessionContexts.entries());
  entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const overflow = sessionContexts.size - SESSION_CONTEXT_MAX_ENTRIES;
  for (let i = 0; i < overflow; i += 1) {
    const target = entries[i];
    if (!target) {
      break;
    }
    sessionContexts.delete(target[0]);
  }
}

export function getSessionContext(sessionId: string, instanceId?: string): SessionContext | undefined {
  pruneExpiredSessionContexts();
  return sessionContexts.get(buildSessionKey(sessionId, instanceId));
}

export function patchSessionContext(
  sessionId: string,
  patch: Partial<Pick<SessionContext, 'tabId' | 'windowId'>>,
  instanceId?: string,
): SessionContext {
  const now = Date.now();
  pruneExpiredSessionContexts(now);
  const key = buildSessionKey(sessionId, instanceId);
  const current = sessionContexts.get(key) || { updatedAt: Date.now() };
  const next: SessionContext = {
    ...current,
    ...patch,
    updatedAt: now,
  };
  sessionContexts.set(key, next);
  enforceSessionContextCapacity();
  return next;
}

export function clearSessionContext(sessionId: string, instanceId?: string): void {
  sessionContexts.delete(buildSessionKey(sessionId, instanceId));
}

export function clearAllSessionContexts(): void {
  sessionContexts.clear();
}

export function clearSessionContextsForTab(tabId: number): void {
  if (!Number.isFinite(tabId)) {
    return;
  }
  for (const [sessionId, ctx] of sessionContexts.entries()) {
    if (ctx.tabId === tabId) {
      sessionContexts.delete(sessionId);
    }
  }
}

export function clearSessionContextsForWindow(windowId: number): void {
  if (!Number.isFinite(windowId)) {
    return;
  }
  for (const [sessionId, ctx] of sessionContexts.entries()) {
    if (ctx.windowId === windowId) {
      sessionContexts.delete(sessionId);
    }
  }
}
