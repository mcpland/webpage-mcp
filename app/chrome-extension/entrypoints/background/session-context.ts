export interface SessionContext {
  tabId?: number;
  windowId?: number;
  updatedAt: number;
}

const sessionContexts = new Map<string, SessionContext>();

export function getSessionContext(sessionId: string): SessionContext | undefined {
  return sessionContexts.get(sessionId);
}

export function patchSessionContext(
  sessionId: string,
  patch: Partial<Pick<SessionContext, 'tabId' | 'windowId'>>,
): SessionContext {
  const current = sessionContexts.get(sessionId) || { updatedAt: Date.now() };
  const next: SessionContext = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  sessionContexts.set(sessionId, next);
  return next;
}

export function clearSessionContext(sessionId: string): void {
  sessionContexts.delete(sessionId);
}
