import {
  BACKGROUND_MESSAGE_TYPES,
  type PrivilegedUiAction,
  type PrivilegedUiAuthorizeResponse,
} from '@/common/message-types';

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
  const response = (await chrome.runtime.sendMessage({
    type: BACKGROUND_MESSAGE_TYPES.PRIVILEGED_UI_AUTHORIZE,
    payload: { action },
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
