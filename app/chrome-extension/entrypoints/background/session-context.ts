export interface SessionContext {
  tabId?: number;
  windowId?: number;
  updatedAt: number;
}

const sessionContexts = new Map<string, SessionContext>();
const SESSION_CONTEXT_TTL_MS = 30 * 60 * 1000;
const SESSION_CONTEXT_MAX_ENTRIES = 500;

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

export function getSessionContext(sessionId: string): SessionContext | undefined {
  pruneExpiredSessionContexts();
  return sessionContexts.get(sessionId);
}

export function patchSessionContext(
  sessionId: string,
  patch: Partial<Pick<SessionContext, 'tabId' | 'windowId'>>,
): SessionContext {
  const now = Date.now();
  pruneExpiredSessionContexts(now);
  const current = sessionContexts.get(sessionId) || { updatedAt: Date.now() };
  const next: SessionContext = {
    ...current,
    ...patch,
    updatedAt: now,
  };
  sessionContexts.set(sessionId, next);
  enforceSessionContextCapacity();
  return next;
}

export function clearSessionContext(sessionId: string): void {
  sessionContexts.delete(sessionId);
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
