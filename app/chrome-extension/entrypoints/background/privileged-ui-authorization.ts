import {
  BACKGROUND_MESSAGE_TYPES,
  PRIVILEGED_UI_ACTIONS,
  type PrivilegedUiAction,
  type PrivilegedUiAuthorizeMessage,
  type PrivilegedUiAuthorizeResponse,
} from '@/common/message-types';

const AUTHORIZATION_TTL_MS = 30_000;
const MAX_PENDING_AUTHORIZATIONS = 256;

const VALID_ACTIONS = new Set<PrivilegedUiAction>(Object.values(PRIVILEGED_UI_ACTIONS));

interface SenderScope {
  extensionId: string;
  tabId: number;
  frameId: number;
  documentId: string;
}

interface AuthorizationGrant extends SenderScope {
  action: PrivilegedUiAction;
  expiresAt: number;
}

function getSenderScope(sender: chrome.runtime.MessageSender): SenderScope | null {
  const extensionId = typeof sender.id === 'string' ? sender.id : '';
  const expectedExtensionId = chrome.runtime.id;
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;

  // Privileged in-page UI is only injected by this extension into the top frame.
  if (
    !extensionId ||
    extensionId !== expectedExtensionId ||
    typeof tabId !== 'number' ||
    !Number.isInteger(tabId) ||
    tabId < 0 ||
    frameId !== 0
  ) {
    return null;
  }

  return {
    extensionId,
    tabId,
    frameId,
    documentId: typeof sender.documentId === 'string' ? sender.documentId : '',
  };
}

function createAuthorizationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Short-lived one-time capability store, exported for focused security tests. */
export class PrivilegedUiAuthorizationStore {
  private readonly grants = new Map<string, AuthorizationGrant>();

  issue(
    action: PrivilegedUiAction,
    sender: chrome.runtime.MessageSender,
    now = Date.now(),
  ): string | null {
    const scope = getSenderScope(sender);
    if (!scope || !VALID_ACTIONS.has(action)) return null;

    this.prune(now);
    while (this.grants.size >= MAX_PENDING_AUTHORIZATIONS) {
      const oldestToken = this.grants.keys().next().value as string | undefined;
      if (!oldestToken) break;
      this.grants.delete(oldestToken);
    }

    const token = createAuthorizationToken();
    this.grants.set(token, {
      ...scope,
      action,
      expiresAt: now + AUTHORIZATION_TTL_MS,
    });
    return token;
  }

  consume(
    token: unknown,
    action: PrivilegedUiAction,
    sender: chrome.runtime.MessageSender,
    now = Date.now(),
  ): boolean {
    if (typeof token !== 'string' || !token) return false;

    const grant = this.grants.get(token);
    // Capabilities are one-time even when presented from the wrong context.
    this.grants.delete(token);

    const scope = getSenderScope(sender);
    if (!grant || !scope || grant.expiresAt < now) return false;

    return (
      grant.action === action &&
      grant.extensionId === scope.extensionId &&
      grant.tabId === scope.tabId &&
      grant.frameId === scope.frameId &&
      grant.documentId === scope.documentId
    );
  }

  clear(): void {
    this.grants.clear();
  }

  private prune(now: number): void {
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt < now) this.grants.delete(token);
    }
  }
}

const authorizationStore = new PrivilegedUiAuthorizationStore();
let initialized = false;

export function consumePrivilegedUiAuthorization(
  token: unknown,
  action: PrivilegedUiAction,
  sender: chrome.runtime.MessageSender,
): boolean {
  return authorizationStore.consume(token, action, sender);
}

/** Register the sole capability-issuance listener in the background worker. */
export function initPrivilegedUiAuthorization(): void {
  if (initialized) return;
  initialized = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== BACKGROUND_MESSAGE_TYPES.PRIVILEGED_UI_AUTHORIZE) return false;

    const action = (message as PrivilegedUiAuthorizeMessage).payload?.action;
    const token = authorizationStore.issue(action, sender);
    const response: PrivilegedUiAuthorizeResponse = token
      ? { success: true, authorizationToken: token }
      : { success: false, error: 'Privileged action authorization denied' };
    sendResponse(response);
    return false;
  });
}
