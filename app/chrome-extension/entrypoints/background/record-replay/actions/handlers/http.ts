/**
 * HTTP Action Handler
 *
 * Makes HTTP requests from the extension context.
 * Supports:
 * - All common HTTP methods (GET, POST, PUT, PATCH, DELETE)
 * - JSON and text body types
 * - Form data
 * - Custom headers
 * - Response validation
 * - Result capture to variables
 */

import { failed, invalid, ok, tryResolveString, tryResolveValue } from '../registry';
import type {
  ActionHandler,
  Assignments,
  HttpBody,
  HttpHeaders,
  HttpFormData,
  HttpMethod,
  HttpOkStatus,
  HttpResponse,
  JsonValue,
  Resolvable,
  VariableStore,
} from '../types';

/** Default timeout for HTTP requests */
const DEFAULT_HTTP_TIMEOUT_MS = 30000;

/** Maximum URL length */
const MAX_URL_LENGTH = 8192;

/**
 * Resolve HTTP headers
 */
async function resolveHeaders(
  headers: HttpHeaders | undefined,
  vars: VariableStore,
): Promise<{ ok: true; resolved: Record<string, string> } | { ok: false; error: string }> {
  if (!headers) return { ok: true, resolved: {} };

  const resolved: Record<string, string> = {};
  for (const [key, resolvable] of Object.entries(headers)) {
    const result = tryResolveString(resolvable, vars);
    if (!result.ok) {
      return { ok: false, error: `Failed to resolve header "${key}": ${result.error}` };
    }
    resolved[key] = result.value;
  }

  return { ok: true, resolved };
}

/**
 * Resolve form data
 */
async function resolveFormData(
  formData: HttpFormData | undefined,
  vars: VariableStore,
): Promise<{ ok: true; resolved: Record<string, string> } | { ok: false; error: string }> {
  if (!formData) return { ok: true, resolved: {} };

  const resolved: Record<string, string> = {};
  for (const [key, resolvable] of Object.entries(formData)) {
    const result = tryResolveString(resolvable, vars);
    if (!result.ok) {
      return { ok: false, error: `Failed to resolve form field "${key}": ${result.error}` };
    }
    resolved[key] = result.value;
  }

  return { ok: true, resolved };
}

/**
 * Resolve HTTP body
 */
async function resolveBody(
  body: HttpBody | undefined,
  vars: VariableStore,
): Promise<
  | { ok: true; contentType: string | undefined; data: string | undefined }
  | { ok: false; error: string }
> {
  if (!body || body.kind === 'none') {
    return { ok: true, contentType: undefined, data: undefined };
  }

  if (body.kind === 'text') {
    const textResult = tryResolveString(body.text, vars);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to resolve body text: ${textResult.error}` };
    }

    let contentType = 'text/plain';
    if (body.contentType) {
      const ctResult = tryResolveString(body.contentType, vars);
      if (!ctResult.ok) {
        return { ok: false, error: `Failed to resolve content type: ${ctResult.error}` };
      }
      contentType = ctResult.value;
    }

    return { ok: true, contentType, data: textResult.value };
  }

  if (body.kind === 'json') {
    const jsonResult = tryResolveValue(body.json, vars);
    if (!jsonResult.ok) {
      return { ok: false, error: `Failed to resolve JSON body: ${jsonResult.error}` };
    }

    return {
      ok: true,
      contentType: 'application/json',
      data: JSON.stringify(jsonResult.value),
    };
  }

  return { ok: false, error: `Unknown body kind: ${(body as { kind: string }).kind}` };
}

/**
 * Check if status code is considered successful
 */
function isStatusOk(status: number, okStatus: HttpOkStatus | undefined): boolean {
  if (!okStatus) {
    // Default: 2xx is OK
    return status >= 200 && status < 300;
  }

  if (okStatus.kind === 'range') {
    return status >= okStatus.min && status <= okStatus.max;
  }

  if (okStatus.kind === 'list') {
    return okStatus.statuses.includes(status);
  }

  return false;
}

/**
 * Get value from result using dot/bracket path notation
 */
function getValueByPath(obj: unknown, path: string): JsonValue | undefined {
  if (!path || typeof obj !== 'object' || obj === null) {
    return obj as JsonValue;
  }

  const segments: Array<string | number> = [];
  const pathRegex = /([^.[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = pathRegex.exec(path)) !== null) {
    if (match[1]) {
      segments.push(match[1]);
    } else if (match[2]) {
      segments.push(parseInt(match[2], 10));
    }
  }

  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }

  return current as JsonValue;
}

/**
 * Apply assignments from response to variables
 */
function applyAssignments(
  response: HttpResponse,
  assignments: Assignments,
  vars: VariableStore,
): void {
  for (const [varName, path] of Object.entries(assignments)) {
    const value = getValueByPath(response, path);
    if (value !== undefined) {
      vars[varName] = value;
    }
  }
}

export const httpHandler: ActionHandler<'http'> = {
  type: 'http',

  validate: (action) => {
    const params = action.params;

    if (params.url === undefined) {
      return invalid('HTTP action requires a URL');
    }

    if (params.method !== undefined) {
      const validMethods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
      if (!validMethods.includes(params.method)) {
        return invalid(`Invalid HTTP method: ${String(params.method)}`);
      }
    }

    return ok();
  },

  describe: (action) => {
    const method = action.params.method || 'GET';
    const url = typeof action.params.url === 'string' ? action.params.url : '(dynamic)';
    const displayUrl = url.length > 40 ? url.slice(0, 40) + '...' : url;
    return `${method} ${displayUrl}`;
  },

  run: async (ctx, action) => {
    const params = action.params;
    const method: HttpMethod = params.method || 'GET';

    // Resolve URL
    const urlResult = tryResolveString(params.url, ctx.vars);
    if (!urlResult.ok) {
      return failed('VALIDATION_ERROR', `Failed to resolve URL: ${urlResult.error}`);
    }

    const url = urlResult.value.trim();
    if (!url) {
      return failed('VALIDATION_ERROR', 'URL is empty');
    }

    if (url.length > MAX_URL_LENGTH) {
      return failed('VALIDATION_ERROR', `URL exceeds maximum length of ${MAX_URL_LENGTH}`);
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return failed('VALIDATION_ERROR', `Invalid URL format: ${url}`);
    }

    // Resolve headers
    const headersResult = await resolveHeaders(params.headers, ctx.vars);
    if (!headersResult.ok) {
      return failed('VALIDATION_ERROR', headersResult.error);
    }

    // Resolve body
    const bodyResult = await resolveBody(params.body, ctx.vars);
    if (!bodyResult.ok) {
      return failed('VALIDATION_ERROR', bodyResult.error);
    }

    // Resolve form data (alternative to body)
    const formDataResult = await resolveFormData(params.formData, ctx.vars);
    if (!formDataResult.ok) {
      return failed('VALIDATION_ERROR', formDataResult.error);
    }

    // Build request
    const headers: Record<string, string> = { ...headersResult.resolved };
    let requestBody: string | FormData | undefined;

    if (Object.keys(formDataResult.resolved).length > 0) {
      // Use form data
      const formData = new FormData();
      for (const [key, value] of Object.entries(formDataResult.resolved)) {
        formData.append(key, value);
      }
      requestBody = formData as unknown as string; // FormData handled by fetch
    } else if (bodyResult.data !== undefined) {
      // Use body
      requestBody = bodyResult.data;
      if (bodyResult.contentType && !headers['Content-Type']) {
        headers['Content-Type'] = bodyResult.contentType;
      }
    }

    // Execute request
    const timeoutMs = action.policy?.timeout?.ms ?? DEFAULT_HTTP_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (requestBody !== undefined && method !== 'GET' && method !== 'DELETE') {
        fetchOptions.body = requestBody;
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      // Parse response
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let responseBody: JsonValue | string | null = null;
      const contentType = response.headers.get('content-type') || '';

      try {
        if (contentType.includes('application/json')) {
          responseBody = (await response.json()) as JsonValue;
        } else {
          responseBody = await response.text();
        }
      } catch {
        responseBody = null;
      }

      const httpResponse: HttpResponse = {
        url: response.url,
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
      };

      // Check status
      if (!isStatusOk(response.status, params.okStatus)) {
        return failed(
          'NETWORK_REQUEST_FAILED',
          `HTTP ${response.status}: ${response.statusText || 'Request failed'}`,
        );
      }

      // Store response if saveAs specified
      if (params.saveAs) {
        ctx.vars[params.saveAs] = httpResponse as unknown as JsonValue;
      }

      // Apply assignments
      if (params.assign) {
        applyAssignments(httpResponse, params.assign, ctx.vars);
      }

      return {
        status: 'success',
        output: { response: httpResponse },
      };
    } catch (e) {
      clearTimeout(timeoutId);

      if (e instanceof Error && e.name === 'AbortError') {
        return failed('TIMEOUT', `HTTP request timed out after ${timeoutMs}ms`);
      }

      return failed(
        'NETWORK_REQUEST_FAILED',
        `HTTP request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};
