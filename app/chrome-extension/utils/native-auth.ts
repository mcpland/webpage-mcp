import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

interface NativeAuthState {
  enabled: boolean;
  token: string | null;
}

const AUTH_TOKEN_CACHE_TTL_MS = 15_000;
const AUTH_TOKEN_QUERY_PARAM = 'authToken';
const PROTECTED_PATH_PREFIXES = ['/agent', '/mcp', '/sse', '/messages', '/ask-extension'];
const FETCH_PATCH_FLAG = '__webpageMcpAuthFetchPatched__';

let cachedAuthState: NativeAuthState = { enabled: false, token: null };
let cacheExpiresAt = 0;
let inflight: Promise<NativeAuthState> | null = null;

function isLocalNativeServerUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const isLocalHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (!isLocalHost) return false;
    return PROTECTED_PATH_PREFIXES.some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    );
  } catch {
    return false;
  }
}

async function fetchNativeAuthState(): Promise<NativeAuthState> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.GET_NATIVE_AUTH_TOKEN,
    });
    if (response?.success) {
      const token = typeof response.token === 'string' ? response.token : null;
      return {
        enabled: response.enabled === true,
        token,
      };
    }
  } catch {
    // Ignore and fall back to disabled auth state.
  }
  return { enabled: false, token: null };
}

export async function getNativeAuthState(options?: {
  forceRefresh?: boolean;
}): Promise<NativeAuthState> {
  const now = Date.now();
  const forceRefresh = options?.forceRefresh === true;
  if (!forceRefresh && now < cacheExpiresAt) {
    return cachedAuthState;
  }

  if (!forceRefresh && inflight) {
    return await inflight;
  }

  inflight = fetchNativeAuthState()
    .then((state) => {
      cachedAuthState = state;
      cacheExpiresAt = Date.now() + AUTH_TOKEN_CACHE_TTL_MS;
      return state;
    })
    .finally(() => {
      inflight = null;
    });

  return await inflight;
}

export async function appendNativeAuthQuery(rawUrl: string): Promise<string> {
  if (!isLocalNativeServerUrl(rawUrl)) {
    return rawUrl;
  }
  const authState = await getNativeAuthState();
  if (!authState.enabled || !authState.token) {
    return rawUrl;
  }

  const url = new URL(rawUrl);
  if (!url.searchParams.has(AUTH_TOKEN_QUERY_PARAM)) {
    url.searchParams.set(AUTH_TOKEN_QUERY_PARAM, authState.token);
  }
  return url.toString();
}

function applyAuthHeaders(headers: Headers, token: string): void {
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('x-webpage-mcp-token')) {
    headers.set('x-webpage-mcp-token', token);
  }
}

export function installNativeAuthFetchInterceptor(): void {
  const globalObj = globalThis as typeof globalThis & {
    [FETCH_PATCH_FLAG]?: boolean;
  };
  if (globalObj[FETCH_PATCH_FLAG]) {
    return;
  }
  globalObj[FETCH_PATCH_FLAG] = true;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : '';

    if (!isLocalNativeServerUrl(url)) {
      return originalFetch(input, init);
    }

    const authState = await getNativeAuthState();
    if (!authState.enabled || !authState.token) {
      return originalFetch(input, init);
    }

    const token = authState.token;

    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      applyAuthHeaders(headers, token);
      const nextRequest = new Request(input, { ...init, headers });
      return originalFetch(nextRequest);
    }

    const headers = new Headers(init?.headers || {});
    applyAuthHeaders(headers, token);
    return originalFetch(input, { ...init, headers });
  };
}
