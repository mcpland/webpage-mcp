import {
  BACKGROUND_MESSAGE_TYPES,
  PRIVILEGED_UI_ACTION_SURFACES,
  PRIVILEGED_UI_ACTIONS,
  PRIVILEGED_UI_SURFACES,
  type PrivilegedUiAction,
  type PrivilegedUiAuthorizeMessage,
  type PrivilegedUiAuthorizeResponse,
  type PrivilegedUiSurface,
  type PrivilegedUiSurfaceCloseMessage,
} from "@/common/message-types";

const AUTHORIZATION_TTL_MS = 30_000;
const MAX_PENDING_AUTHORIZATIONS = 256;
const MAX_ACTIVE_SURFACES = 512;
const SURFACE_SESSION_PATTERN = /^[a-f0-9]{64}$/;
const ACTIVE_SURFACE_STORAGE_KEY = "privileged-ui-active-surfaces-v1";

const VALID_ACTIONS = new Set<PrivilegedUiAction>(
  Object.values(PRIVILEGED_UI_ACTIONS),
);
const VALID_SURFACES = new Set<PrivilegedUiSurface>(
  Object.values(PRIVILEGED_UI_SURFACES),
);

interface SenderScope {
  extensionId: string;
  tabId: number;
  frameId: number;
  documentId: string;
}

interface AuthorizationGrant extends SenderScope {
  action: PrivilegedUiAction;
  surface: PrivilegedUiSurface;
  surfaceSessionId: string;
  expiresAt: number;
}

interface ActiveSurfaceSession {
  surface: PrivilegedUiSurface;
  surfaceSessionId: string;
  tabId: number;
  documentId?: string;
}

interface StoredActiveSurfaceState {
  version: 1;
  sessions: ActiveSurfaceSession[];
}

interface ActiveSurfaceValidationResult {
  valid: boolean;
  documentBound: boolean;
}

interface AuthorizationIssueResult {
  token: string;
  documentBound: boolean;
}

export interface PrivilegedUiSurfaceDeactivation {
  surface: PrivilegedUiSurface;
  surfaceSessionId: string;
  tabId: number;
  reason: "replaced" | "stopped" | "closed" | "navigation" | "tab_removed";
}

type SurfaceDeactivationListener = (
  event: PrivilegedUiSurfaceDeactivation,
) => void | Promise<void>;

function activeSurfaceKey(surface: PrivilegedUiSurface, tabId: number): string {
  return `${surface}:${tabId}`;
}

function isSurfaceSessionId(value: unknown): value is string {
  return typeof value === "string" && SURFACE_SESSION_PATTERN.test(value);
}

function getSenderScope(
  sender: chrome.runtime.MessageSender,
): SenderScope | null {
  const extensionId = typeof sender.id === "string" ? sender.id : "";
  const expectedExtensionId = chrome.runtime.id;
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  const documentId =
    typeof sender.documentId === "string" ? sender.documentId : "";

  // Privileged in-page UI is only injected by this extension into the top frame.
  if (
    !extensionId ||
    extensionId !== expectedExtensionId ||
    typeof tabId !== "number" ||
    !Number.isInteger(tabId) ||
    tabId < 0 ||
    frameId !== 0 ||
    !documentId ||
    documentId.length > 512
  ) {
    return null;
  }

  return {
    extensionId,
    tabId,
    frameId,
    documentId,
  };
}

function createAuthorizationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Short-lived one-time capability store, exported for focused security tests.
 *
 * Surface sessions enforce least privilege between in-page UI surfaces. Web
 * Editor grants additionally require the dedicated USER_SCRIPT message event;
 * ordinary content scripts cannot mint or close them even if a capability is
 * disclosed by unrelated extension code.
 */
export class PrivilegedUiAuthorizationStore {
  private readonly grants = new Map<string, AuthorizationGrant>();
  private readonly activeSurfaces = new Map<string, ActiveSurfaceSession>();

  activateSurface(
    surface: PrivilegedUiSurface,
    tabId: number,
    surfaceSessionId: string,
  ): boolean {
    if (
      !VALID_SURFACES.has(surface) ||
      !Number.isInteger(tabId) ||
      tabId < 0 ||
      !isSurfaceSessionId(surfaceSessionId)
    ) {
      return false;
    }
    this.deactivateSurface(surface, tabId);
    while (this.activeSurfaces.size >= MAX_ACTIVE_SURFACES) {
      const oldestKey = this.activeSurfaces.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) break;
      this.activeSurfaces.delete(oldestKey);
    }
    this.activeSurfaces.set(activeSurfaceKey(surface, tabId), {
      surface,
      surfaceSessionId,
      tabId,
    });
    return true;
  }

  deactivateSurface(surface: PrivilegedUiSurface, tabId: number): void {
    this.activeSurfaces.delete(activeSurfaceKey(surface, tabId));
    for (const [token, grant] of this.grants) {
      if (grant.surface === surface && grant.tabId === tabId)
        this.grants.delete(token);
    }
  }

  deactivateSurfaceIfSession(
    surface: PrivilegedUiSurface,
    tabId: number,
    expectedSurfaceSessionId?: string,
  ): boolean {
    if (
      expectedSurfaceSessionId !== undefined &&
      !isSurfaceSessionId(expectedSurfaceSessionId)
    ) {
      return false;
    }
    const active = this.activeSurfaces.get(activeSurfaceKey(surface, tabId));
    if (!active) return false;
    if (
      expectedSurfaceSessionId !== undefined &&
      active.surfaceSessionId !== expectedSurfaceSessionId
    ) {
      return false;
    }
    this.deactivateSurface(surface, tabId);
    return true;
  }

  deactivateTab(tabId: number): boolean {
    let deactivated = false;
    for (const surface of VALID_SURFACES) {
      if (!this.activeSurfaces.has(activeSurfaceKey(surface, tabId))) continue;
      this.deactivateSurface(surface, tabId);
      deactivated = true;
    }
    return deactivated;
  }

  exportActiveSurfaceSessions(): ActiveSurfaceSession[] {
    return Array.from(this.activeSurfaces.values(), (session) => ({
      ...session,
    }));
  }

  restoreActiveSurfaceSessions(value: unknown): void {
    this.grants.clear();
    this.activeSurfaces.clear();
    if (!Array.isArray(value)) return;

    for (const candidate of value.slice(0, MAX_ACTIVE_SURFACES)) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      )
        continue;
      const session = candidate as Partial<ActiveSurfaceSession>;
      if (
        !VALID_SURFACES.has(session.surface as PrivilegedUiSurface) ||
        !Number.isInteger(session.tabId) ||
        (session.tabId as number) < 0 ||
        !isSurfaceSessionId(session.surfaceSessionId) ||
        (session.documentId !== undefined &&
          (typeof session.documentId !== "string" ||
            !session.documentId ||
            session.documentId.length > 512))
      ) {
        continue;
      }
      const normalized: ActiveSurfaceSession = {
        surface: session.surface as PrivilegedUiSurface,
        surfaceSessionId: session.surfaceSessionId,
        tabId: session.tabId as number,
        ...(session.documentId !== undefined
          ? { documentId: session.documentId }
          : {}),
      };
      this.activeSurfaces.set(
        activeSurfaceKey(normalized.surface, normalized.tabId),
        normalized,
      );
    }
  }

  deactivateSurfaceFromSender(
    surface: PrivilegedUiSurface,
    surfaceSessionId: string,
    sender: chrome.runtime.MessageSender,
  ): boolean {
    const scope = getSenderScope(sender);
    if (
      !scope ||
      !VALID_SURFACES.has(surface) ||
      !isSurfaceSessionId(surfaceSessionId)
    ) {
      return false;
    }
    const active = this.activeSurfaces.get(
      activeSurfaceKey(surface, scope.tabId),
    );
    if (!active || active.surfaceSessionId !== surfaceSessionId) return false;
    if (
      active.documentId !== undefined &&
      active.documentId !== scope.documentId
    )
      return false;
    this.deactivateSurface(surface, scope.tabId);
    return true;
  }

  validateActiveSurfaceSession(
    surface: PrivilegedUiSurface,
    surfaceSessionId: string,
    sender: chrome.runtime.MessageSender,
  ): ActiveSurfaceValidationResult {
    const scope = getSenderScope(sender);
    if (
      !scope ||
      !VALID_SURFACES.has(surface) ||
      !isSurfaceSessionId(surfaceSessionId)
    ) {
      return { valid: false, documentBound: false };
    }
    const active = this.activeSurfaces.get(
      activeSurfaceKey(surface, scope.tabId),
    );
    if (!active || active.surfaceSessionId !== surfaceSessionId) {
      return { valid: false, documentBound: false };
    }
    if (active.documentId === undefined) {
      active.documentId = scope.documentId;
      return { valid: true, documentBound: true };
    }
    return {
      valid: active.documentId === scope.documentId,
      documentBound: false,
    };
  }

  issue(
    action: PrivilegedUiAction,
    surface: PrivilegedUiSurface,
    surfaceSessionId: string,
    sender: chrome.runtime.MessageSender,
    now = Date.now(),
  ): string | null {
    return (
      this.issueWithBindingState(action, surface, surfaceSessionId, sender, now)
        ?.token ?? null
    );
  }

  issueWithBindingState(
    action: PrivilegedUiAction,
    surface: PrivilegedUiSurface,
    surfaceSessionId: string,
    sender: chrome.runtime.MessageSender,
    now = Date.now(),
  ): AuthorizationIssueResult | null {
    const scope = getSenderScope(sender);
    if (
      !scope ||
      !VALID_ACTIONS.has(action) ||
      !VALID_SURFACES.has(surface) ||
      PRIVILEGED_UI_ACTION_SURFACES[action] !== surface ||
      !isSurfaceSessionId(surfaceSessionId)
    ) {
      return null;
    }

    const active = this.activeSurfaces.get(
      activeSurfaceKey(surface, scope.tabId),
    );
    if (!active || active.surfaceSessionId !== surfaceSessionId) return null;
    const documentBound = active.documentId === undefined;
    if (documentBound) active.documentId = scope.documentId;
    if (active.documentId !== scope.documentId) return null;

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
      surface,
      surfaceSessionId,
      expiresAt: now + AUTHORIZATION_TTL_MS,
    });
    return { token, documentBound };
  }

  consume(
    token: unknown,
    action: PrivilegedUiAction,
    sender: chrome.runtime.MessageSender,
    now = Date.now(),
  ): boolean {
    if (typeof token !== "string" || !token) return false;

    const grant = this.grants.get(token);
    // Capabilities are one-time even when presented from the wrong context.
    this.grants.delete(token);

    const scope = getSenderScope(sender);
    if (!grant || !scope || grant.expiresAt < now) return false;

    const active = this.activeSurfaces.get(
      activeSurfaceKey(grant.surface, scope.tabId),
    );
    if (
      !active ||
      active.surfaceSessionId !== grant.surfaceSessionId ||
      active.documentId !== scope.documentId
    ) {
      return false;
    }

    return (
      grant.action === action &&
      PRIVILEGED_UI_ACTION_SURFACES[action] === grant.surface &&
      grant.extensionId === scope.extensionId &&
      grant.tabId === scope.tabId &&
      grant.frameId === scope.frameId &&
      grant.documentId === scope.documentId
    );
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }

  clear(): void {
    this.grants.clear();
    this.activeSurfaces.clear();
  }

  private prune(now: number): void {
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt < now) this.grants.delete(token);
    }
  }
}

const authorizationStore = new PrivilegedUiAuthorizationStore();
const surfaceDeactivationListeners = new Set<SurfaceDeactivationListener>();
let initialized = false;
let activeSurfacesHydrated = false;
let surfaceOperationQueue: Promise<void> = Promise.resolve();

export function addPrivilegedUiSurfaceDeactivationListener(
  listener: SurfaceDeactivationListener,
): () => void {
  surfaceDeactivationListeners.add(listener);
  return () => surfaceDeactivationListeners.delete(listener);
}

async function notifyDeactivatedSurfaces(
  previous: ActiveSurfaceSession[],
  reason: PrivilegedUiSurfaceDeactivation["reason"],
): Promise<void> {
  if (surfaceDeactivationListeners.size === 0 || previous.length === 0) return;
  const active = new Map(
    authorizationStore
      .exportActiveSurfaceSessions()
      .map((session) => [
        activeSurfaceKey(session.surface, session.tabId),
        session,
      ]),
  );
  const deactivated = previous.filter((session) => {
    const current = active.get(
      activeSurfaceKey(session.surface, session.tabId),
    );
    return current?.surfaceSessionId !== session.surfaceSessionId;
  });
  if (deactivated.length === 0) return;

  const listeners = Array.from(surfaceDeactivationListeners);
  const results = await Promise.allSettled(
    deactivated.flatMap((session) =>
      listeners.map((listener) =>
        Promise.resolve().then(() =>
          listener({
            surface: session.surface,
            surfaceSessionId: session.surfaceSessionId,
            tabId: session.tabId,
            reason,
          }),
        ),
      ),
    ),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("Privileged UI surface cleanup failed", result.reason);
    }
  }
}

async function hydrateActiveSurfaces(): Promise<void> {
  if (activeSurfacesHydrated) return;
  const stored = await chrome.storage.session.get(ACTIVE_SURFACE_STORAGE_KEY);
  const state = stored[ACTIVE_SURFACE_STORAGE_KEY] as
    | Partial<StoredActiveSurfaceState>
    | undefined;
  authorizationStore.restoreActiveSurfaceSessions(
    state?.version === 1 && Array.isArray(state.sessions) ? state.sessions : [],
  );
  activeSurfacesHydrated = true;
}

async function persistActiveSurfaces(): Promise<void> {
  const state: StoredActiveSurfaceState = {
    version: 1,
    sessions: authorizationStore.exportActiveSurfaceSessions(),
  };
  await chrome.storage.session.set({ [ACTIVE_SURFACE_STORAGE_KEY]: state });
}

function runSurfaceOperation<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = surfaceOperationQueue.then(async () => {
    await hydrateActiveSurfaces();
    return operation();
  });
  surfaceOperationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function startPrivilegedUiSurfaceSession(
  surface: PrivilegedUiSurface,
  tabId: number,
): Promise<string> {
  return runSurfaceOperation(async () => {
    const previous = authorizationStore.exportActiveSurfaceSessions();
    const surfaceSessionId = createAuthorizationToken();
    if (!authorizationStore.activateSurface(surface, tabId, surfaceSessionId)) {
      throw new Error("Unable to activate privileged UI surface");
    }
    try {
      await persistActiveSurfaces();
      await notifyDeactivatedSurfaces(previous, "replaced");
      return surfaceSessionId;
    } catch (error) {
      authorizationStore.restoreActiveSurfaceSessions(previous);
      throw error;
    }
  });
}

export async function stopPrivilegedUiSurfaceSession(
  surface: PrivilegedUiSurface,
  tabId: number,
  expectedSurfaceSessionId?: string,
): Promise<boolean> {
  return runSurfaceOperation(async () => {
    const previous = authorizationStore.exportActiveSurfaceSessions();
    const deactivated = authorizationStore.deactivateSurfaceIfSession(
      surface,
      tabId,
      expectedSurfaceSessionId,
    );
    if (!deactivated) return false;
    try {
      await persistActiveSurfaces();
      await notifyDeactivatedSurfaces(previous, "stopped");
      return true;
    } catch (error) {
      authorizationStore.restoreActiveSurfaceSessions(previous);
      throw error;
    }
  });
}

export async function validatePrivilegedUiSurfaceSession(
  surface: PrivilegedUiSurface,
  surfaceSessionId: string,
  sender: chrome.runtime.MessageSender,
): Promise<boolean> {
  return runSurfaceOperation(async () => {
    const previous = authorizationStore.exportActiveSurfaceSessions();
    const validation = authorizationStore.validateActiveSurfaceSession(
      surface,
      surfaceSessionId,
      sender,
    );
    if (!validation.valid) return false;
    if (!validation.documentBound) return true;
    try {
      await persistActiveSurfaces();
      return true;
    } catch (error) {
      authorizationStore.restoreActiveSurfaceSessions(previous);
      throw error;
    }
  });
}

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

  const handleAuthorizationMessage = (
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void,
    source: "content-script" | "user-script",
  ): boolean => {
    const messageType = typeof message?.type === "string" ? message.type : "";
    const surface = message?.payload?.surface;
    if (
      messageType === BACKGROUND_MESSAGE_TYPES.PRIVILEGED_UI_AUTHORIZE ||
      messageType === BACKGROUND_MESSAGE_TYPES.PRIVILEGED_UI_SURFACE_CLOSE
    ) {
      const webEditorSurface = surface === PRIVILEGED_UI_SURFACES.WEB_EDITOR;
      if (
        (source === "user-script" && !webEditorSurface) ||
        (source === "content-script" && webEditorSurface)
      ) {
        sendResponse(
          messageType === BACKGROUND_MESSAGE_TYPES.PRIVILEGED_UI_AUTHORIZE
            ? {
                success: false,
                error: "Privileged action authorization denied",
              }
            : { success: false },
        );
        return false;
      }
    }

    if (
      message?.type === BACKGROUND_MESSAGE_TYPES.PRIVILEGED_UI_SURFACE_CLOSE
    ) {
      const payload = (message as PrivilegedUiSurfaceCloseMessage).payload;
      void runSurfaceOperation(async () => {
        const previous = authorizationStore.exportActiveSurfaceSessions();
        const success = authorizationStore.deactivateSurfaceFromSender(
          payload?.surface,
          payload?.surfaceSessionId,
          sender,
        );
        if (!success) return false;
        try {
          await persistActiveSurfaces();
          await notifyDeactivatedSurfaces(previous, "closed");
          return true;
        } catch (error) {
          authorizationStore.restoreActiveSurfaceSessions(previous);
          throw error;
        }
      })
        .then((success) => sendResponse({ success }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    if (message?.type !== BACKGROUND_MESSAGE_TYPES.PRIVILEGED_UI_AUTHORIZE)
      return false;

    const payload = (message as PrivilegedUiAuthorizeMessage).payload;
    void runSurfaceOperation(async () => {
      const previous = authorizationStore.exportActiveSurfaceSessions();
      const issued = authorizationStore.issueWithBindingState(
        payload?.action,
        payload?.surface,
        payload?.surfaceSessionId,
        sender,
      );
      if (!issued) return null;
      if (!issued.documentBound) return issued.token;
      try {
        await persistActiveSurfaces();
        return issued.token;
      } catch (error) {
        authorizationStore.revoke(issued.token);
        authorizationStore.restoreActiveSurfaceSessions(previous);
        throw error;
      }
    })
      .then((token) => {
        const response: PrivilegedUiAuthorizeResponse = token
          ? { success: true, authorizationToken: token }
          : { success: false, error: "Privileged action authorization denied" };
        sendResponse(response);
      })
      .catch(() =>
        sendResponse({
          success: false,
          error: "Privileged action authorization denied",
        }),
      );
    return true;
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    handleAuthorizationMessage(message, sender, sendResponse, "content-script"),
  );
  chrome.runtime.onUserScriptMessage?.addListener(
    (message, sender, sendResponse) =>
      handleAuthorizationMessage(message, sender, sendResponse, "user-script"),
  );

  chrome.tabs.onRemoved.addListener((tabId) => {
    void runSurfaceOperation(async () => {
      const previous = authorizationStore.exportActiveSurfaceSessions();
      if (!authorizationStore.deactivateTab(tabId)) return;
      try {
        await persistActiveSurfaces();
        await notifyDeactivatedSurfaces(previous, "tab_removed");
      } catch (error) {
        authorizationStore.restoreActiveSurfaceSessions(previous);
        throw error;
      }
    }).catch(() => {});
  });

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    void runSurfaceOperation(async () => {
      const previous = authorizationStore.exportActiveSurfaceSessions();
      if (!authorizationStore.deactivateTab(details.tabId)) return;
      try {
        await persistActiveSurfaces();
        await notifyDeactivatedSurfaces(previous, "navigation");
      } catch (error) {
        authorizationStore.restoreActiveSurfaceSessions(previous);
        throw error;
      }
    }).catch(() => {});
  });

  // Start recovery immediately. All later operations share the same queue, so
  // an old storage read can never overwrite a newer activation or close.
  void runSurfaceOperation(() => undefined).catch(() => {});
}
