import {
  BACKGROUND_MESSAGE_TYPES,
  PRIVILEGED_UI_ACTION_SURFACES,
  type PrivilegedUiAction,
  type PrivilegedUiAuthorizeResponse,
  type PrivilegedUiSurface,
} from '@/common/message-types';

const SURFACE_SESSION_PATTERN = /^[a-f0-9]{64}$/;

interface ActiveSurfaceSession {
  surface: PrivilegedUiSurface;
  surfaceSessionId: string;
}

let activeSurfaceSession: ActiveSurfaceSession | null = null;

/** Configure the background-created capability for this isolated UI bundle. */
export function configurePrivilegedUiSurfaceSession(
  surface: PrivilegedUiSurface,
  surfaceSessionId: string,
): boolean {
  if (!SURFACE_SESSION_PATTERN.test(surfaceSessionId)) return false;
  activeSurfaceSession = { surface, surfaceSessionId };
  return true;
}

export function clearPrivilegedUiSurfaceSession(surface?: PrivilegedUiSurface): void {
  if (!surface || activeSurfaceSession?.surface === surface) activeSurfaceSession = null;
}

export function matchesPrivilegedUiSurfaceSession(
  surface: PrivilegedUiSurface,
  surfaceSessionId: string,
): boolean {
  return (
    activeSurfaceSession?.surface === surface &&
    activeSurfaceSession.surfaceSessionId === surfaceSessionId
  );
}

/** Close the active surface in both this bundle and the background registry. */
export async function closePrivilegedUiSurfaceSession(
  surface: PrivilegedUiSurface,
  expectedSurfaceSessionId?: string,
): Promise<boolean> {
  const session = activeSurfaceSession;
  if (!session || session.surface !== surface) return false;
  if (
    expectedSurfaceSessionId !== undefined &&
    session.surfaceSessionId !== expectedSurfaceSessionId
  ) {
    return false;
  }
  activeSurfaceSession = null;
  try {
    const response = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.PRIVILEGED_UI_SURFACE_CLOSE,
      payload: {
        surface,
        surfaceSessionId: session.surfaceSessionId,
      },
    });
    return response?.success === true;
  } catch {
    return false;
  }
}

/** Synthetic DOM events dispatched by the host page must never authorize work. */
export function isTrustedPrivilegedUiEvent(event: Event): boolean {
  return event.isTrusted === true;
}

/**
 * Request a one-time capability for an Agent-backed action.
 *
 * Callers must invoke this only from a handler that has already verified a
 * trusted browser user activation. The page cannot call this helper because it
 * runs in the content script's isolated world.
 */
export async function authorizePrivilegedUiAction(action: PrivilegedUiAction): Promise<string> {
  const expectedSurface = PRIVILEGED_UI_ACTION_SURFACES[action];
  const session = activeSurfaceSession;
  if (!session || session.surface !== expectedSurface) {
    throw new Error('Privileged UI surface is not active');
  }

  const response = (await chrome.runtime.sendMessage({
    type: BACKGROUND_MESSAGE_TYPES.PRIVILEGED_UI_AUTHORIZE,
    payload: {
      action,
      surface: session.surface,
      surfaceSessionId: session.surfaceSessionId,
    },
  })) as PrivilegedUiAuthorizeResponse | undefined;

  if (!response?.success || typeof response.authorizationToken !== 'string') {
    throw new Error(response?.success === false ? response.error : 'Authorization was not granted');
  }

  const token = response.authorizationToken.trim();
  if (!token) {
    throw new Error('Authorization token is missing');
  }
  return token;
}
