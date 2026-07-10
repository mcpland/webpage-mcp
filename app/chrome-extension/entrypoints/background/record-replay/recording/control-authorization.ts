import type { RecordingStatus } from './session-manager';

export const RECORDER_CONTROL_REGISTER_ACTION = 'rr_register_recorder_control';

const CONTROL_CAPABILITY_PATTERN = /^[a-f0-9]{64}$/;
const MAX_DOCUMENT_ID_LENGTH = 128;

interface RecordingControlSession {
  getSession(): { sessionId: string };
  getStatus(): RecordingStatus;
  hasActiveTab(tabId: number): boolean;
}

interface SenderScope {
  tabId: number;
  frameId: number;
  documentId: string;
}

interface ControlGrant extends SenderScope {
  sessionId: string;
  capability: string;
}

interface RecorderControlMessage {
  sessionId?: unknown;
  controlCapability?: unknown;
}

function getSenderScope(sender: chrome.runtime.MessageSender): SenderScope | null {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  const documentId = typeof sender.documentId === 'string' ? sender.documentId : '';

  if (
    sender.id !== chrome.runtime.id ||
    !Number.isInteger(tabId) ||
    (tabId as number) < 0 ||
    frameId !== 0 ||
    documentId.length > MAX_DOCUMENT_ID_LENGTH
  ) {
    return null;
  }

  return { tabId: tabId as number, frameId, documentId };
}

function parseCapability(message: RecorderControlMessage): string | null {
  return typeof message.controlCapability === 'string' &&
    CONTROL_CAPABILITY_PATTERN.test(message.controlCapability)
    ? message.controlCapability
    : null;
}

/**
 * Long-lived only for one recording session, but bound to the exact top-frame
 * document that registered it. The page cannot access the isolated-world token.
 */
export class RecorderControlAuthorizationStore {
  private sessionId = '';
  private readonly grantsByTab = new Map<number, ControlGrant>();

  register(
    message: RecorderControlMessage,
    sender: chrome.runtime.MessageSender,
    session: RecordingControlSession,
  ): boolean {
    this.alignSession(session.getSession().sessionId);
    const scope = getSenderScope(sender);
    const capability = parseCapability(message);
    const requestedSessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
    const status = session.getStatus();

    if (
      !scope ||
      !capability ||
      !requestedSessionId ||
      requestedSessionId !== this.sessionId ||
      (status !== 'recording' && status !== 'paused') ||
      !session.hasActiveTab(scope.tabId)
    ) {
      return false;
    }

    this.grantsByTab.set(scope.tabId, {
      ...scope,
      sessionId: requestedSessionId,
      capability,
    });
    return true;
  }

  authorizeStop(
    message: RecorderControlMessage,
    sender: chrome.runtime.MessageSender,
    session: RecordingControlSession,
  ): boolean {
    this.alignSession(session.getSession().sessionId);
    const scope = getSenderScope(sender);
    const capability = parseCapability(message);
    const requestedSessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
    if (!scope || !capability || !requestedSessionId || !session.hasActiveTab(scope.tabId)) {
      return false;
    }

    const grant = this.grantsByTab.get(scope.tabId);
    if (
      !grant ||
      grant.sessionId !== this.sessionId ||
      requestedSessionId !== grant.sessionId ||
      grant.capability !== capability ||
      grant.frameId !== scope.frameId ||
      grant.documentId !== scope.documentId
    ) {
      return false;
    }

    // A stop capability is single-use; subsequent requests race against the
    // session state machine instead of starting a second stop operation.
    this.grantsByTab.delete(scope.tabId);
    return true;
  }

  clear(): void {
    this.sessionId = '';
    this.grantsByTab.clear();
  }

  private alignSession(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.grantsByTab.clear();
  }
}
