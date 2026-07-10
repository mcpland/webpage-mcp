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

export const HTTP_ACTION_LIMITS = Object.freeze({
  maxUrlUtf8Bytes: 8 * 1024,
  maxTimeoutMs: 60 * 60 * 1000,
  maxHeaderCount: 64,
  maxHeaderNameUtf8Bytes: 256,
  maxHeaderValueUtf8Bytes: 8 * 1024,
  maxHeadersUtf8Bytes: 32 * 1024,
  maxFormFieldCount: 64,
  maxFormFieldNameUtf8Bytes: 256,
  maxFormFieldValueUtf8Bytes: 64 * 1024,
  maxFormDataUtf8Bytes: 256 * 1024,
  maxRequestBodyUtf8Bytes: 256 * 1024,
  maxResponseBodyBytes: 256 * 1024,
  maxResponseHeadersUtf8Bytes: 32 * 1024,
  maxResponseJsonUtf8Bytes: 48 * 1024,
  maxAssignments: 64,
  maxAssignmentFieldUtf8Bytes: 256,
  maxJsonDepth: 64,
  maxJsonValues: 20_000,
});

function utf8ByteLength(value: string, stopAfter = Number.MAX_SAFE_INTEGER): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateJsonShape(value: JsonValue): string | null {
  const stack: Array<{ value: JsonValue; depth: number }> = [{ value, depth: 0 }];
  let values = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    values += 1;
    if (values > HTTP_ACTION_LIMITS.maxJsonValues) {
      return `JSON response exceeds ${HTTP_ACTION_LIMITS.maxJsonValues} values`;
    }
    if (current.depth > HTTP_ACTION_LIMITS.maxJsonDepth) {
      return `JSON response exceeds depth ${HTTP_ACTION_LIMITS.maxJsonDepth}`;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child as JsonValue, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function normalizeTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_HTTP_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), HTTP_ACTION_LIMITS.maxTimeoutMs);
}

function validateResolvedFields(
  fields: Record<string, string>,
  limits: {
    label: string;
    maxCount: number;
    maxNameBytes: number;
    maxValueBytes: number;
    maxTotalBytes: number;
  },
): string | null {
  const entries = Object.entries(fields);
  if (entries.length > limits.maxCount) {
    return `${limits.label} exceeds ${limits.maxCount} entries`;
  }
  let totalBytes = 2;
  for (const [key, value] of entries) {
    const keyBytes = utf8ByteLength(key, limits.maxNameBytes);
    if (!key || keyBytes > limits.maxNameBytes) {
      return `${limits.label} name exceeds ${limits.maxNameBytes} UTF-8 bytes`;
    }
    const valueBytes = utf8ByteLength(value, limits.maxValueBytes);
    if (valueBytes > limits.maxValueBytes) {
      return `${limits.label} value exceeds ${limits.maxValueBytes} UTF-8 bytes`;
    }
    totalBytes += keyBytes + valueBytes + 4;
    if (totalBytes > limits.maxTotalBytes) {
      return `${limits.label} exceeds ${limits.maxTotalBytes} UTF-8 bytes in total`;
    }
  }
  return null;
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      Number.isFinite(parsedLength) &&
      parsedLength > HTTP_ACTION_LIMITS.maxResponseBodyBytes
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `HTTP response body exceeds ${HTTP_ACTION_LIMITS.maxResponseBodyBytes} bytes`,
      );
    }
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > HTTP_ACTION_LIMITS.maxResponseBodyBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `HTTP response body exceeds ${HTTP_ACTION_LIMITS.maxResponseBodyBytes} bytes`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function readBoundedResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  let totalBytes = 2;
  let count = 0;
  let violation: string | null = null;
  response.headers.forEach((value, key) => {
    if (violation) return;
    count += 1;
    const keyBytes = utf8ByteLength(key, HTTP_ACTION_LIMITS.maxHeaderNameUtf8Bytes);
    const valueBytes = utf8ByteLength(value, HTTP_ACTION_LIMITS.maxHeaderValueUtf8Bytes);
    totalBytes += keyBytes + valueBytes + 4;
    if (
      count > HTTP_ACTION_LIMITS.maxHeaderCount ||
      keyBytes > HTTP_ACTION_LIMITS.maxHeaderNameUtf8Bytes ||
      valueBytes > HTTP_ACTION_LIMITS.maxHeaderValueUtf8Bytes ||
      totalBytes > HTTP_ACTION_LIMITS.maxResponseHeadersUtf8Bytes
    ) {
      violation = `HTTP response headers exceed the ${HTTP_ACTION_LIMITS.maxResponseHeadersUtf8Bytes}-byte budget`;
      return;
    }
    headers[key] = value;
  });
  if (violation) throw new Error(violation);
  return headers;
}

/**
 * Resolve HTTP headers
 */
async function resolveHeaders(
  headers: HttpHeaders | undefined,
  vars: VariableStore,
): Promise<{ ok: true; resolved: Record<string, string> } | { ok: false; error: string }> {
  if (!headers) return { ok: true, resolved: {} };
  if (!isRecord(headers)) return { ok: false, error: 'HTTP headers must be an object' };
  const headerEntries = Object.entries(headers);
  if (headerEntries.length > HTTP_ACTION_LIMITS.maxHeaderCount) {
    return {
      ok: false,
      error: `HTTP headers exceeds ${HTTP_ACTION_LIMITS.maxHeaderCount} entries`,
    };
  }

  const resolved: Record<string, string> = {};
  for (const [key, resolvable] of headerEntries) {
    if (
      !key ||
      utf8ByteLength(key, HTTP_ACTION_LIMITS.maxHeaderNameUtf8Bytes) >
        HTTP_ACTION_LIMITS.maxHeaderNameUtf8Bytes
    ) {
      return {
        ok: false,
        error: `HTTP headers name exceeds ${HTTP_ACTION_LIMITS.maxHeaderNameUtf8Bytes} UTF-8 bytes`,
      };
    }
    const result = tryResolveString(resolvable, vars);
    if (!result.ok) {
      return { ok: false, error: `Failed to resolve header "${key}": ${result.error}` };
    }
    resolved[key] = result.value;
  }

  const violation = validateResolvedFields(resolved, {
    label: 'HTTP headers',
    maxCount: HTTP_ACTION_LIMITS.maxHeaderCount,
    maxNameBytes: HTTP_ACTION_LIMITS.maxHeaderNameUtf8Bytes,
    maxValueBytes: HTTP_ACTION_LIMITS.maxHeaderValueUtf8Bytes,
    maxTotalBytes: HTTP_ACTION_LIMITS.maxHeadersUtf8Bytes,
  });
  if (violation) return { ok: false, error: violation };

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
  if (!isRecord(formData)) return { ok: false, error: 'HTTP formData must be an object' };
  const fieldEntries = Object.entries(formData);
  if (fieldEntries.length > HTTP_ACTION_LIMITS.maxFormFieldCount) {
    return {
      ok: false,
      error: `HTTP form data exceeds ${HTTP_ACTION_LIMITS.maxFormFieldCount} entries`,
    };
  }

  const resolved: Record<string, string> = {};
  for (const [key, resolvable] of fieldEntries) {
    if (
      !key ||
      utf8ByteLength(key, HTTP_ACTION_LIMITS.maxFormFieldNameUtf8Bytes) >
        HTTP_ACTION_LIMITS.maxFormFieldNameUtf8Bytes
    ) {
      return {
        ok: false,
        error: `HTTP form data name exceeds ${HTTP_ACTION_LIMITS.maxFormFieldNameUtf8Bytes} UTF-8 bytes`,
      };
    }
    const result = tryResolveString(resolvable, vars);
    if (!result.ok) {
      return { ok: false, error: `Failed to resolve form field "${key}": ${result.error}` };
    }
    resolved[key] = result.value;
  }

  const violation = validateResolvedFields(resolved, {
    label: 'HTTP form data',
    maxCount: HTTP_ACTION_LIMITS.maxFormFieldCount,
    maxNameBytes: HTTP_ACTION_LIMITS.maxFormFieldNameUtf8Bytes,
    maxValueBytes: HTTP_ACTION_LIMITS.maxFormFieldValueUtf8Bytes,
    maxTotalBytes: HTTP_ACTION_LIMITS.maxFormDataUtf8Bytes,
  });
  if (violation) return { ok: false, error: violation };

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

  if (!isRecord(body)) {
    return { ok: false, error: 'HTTP body must be an object' };
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

    if (
      utf8ByteLength(textResult.value, HTTP_ACTION_LIMITS.maxRequestBodyUtf8Bytes) >
      HTTP_ACTION_LIMITS.maxRequestBodyUtf8Bytes
    ) {
      return {
        ok: false,
        error: `HTTP request body exceeds ${HTTP_ACTION_LIMITS.maxRequestBodyUtf8Bytes} UTF-8 bytes`,
      };
    }

    return { ok: true, contentType, data: textResult.value };
  }

  if (body.kind === 'json') {
    const jsonResult = tryResolveValue(body.json, vars);
    if (!jsonResult.ok) {
      return { ok: false, error: `Failed to resolve JSON body: ${jsonResult.error}` };
    }

    let data: string;
    try {
      data = JSON.stringify(jsonResult.value);
    } catch {
      return { ok: false, error: 'HTTP JSON body must be serializable' };
    }
    if (
      utf8ByteLength(data, HTTP_ACTION_LIMITS.maxRequestBodyUtf8Bytes) >
      HTTP_ACTION_LIMITS.maxRequestBodyUtf8Bytes
    ) {
      return {
        ok: false,
        error: `HTTP request body exceeds ${HTTP_ACTION_LIMITS.maxRequestBodyUtf8Bytes} UTF-8 bytes`,
      };
    }

    return {
      ok: true,
      contentType: 'application/json',
      data,
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

function validateAssignments(assignments: unknown): string | null {
  if (assignments === undefined) return null;
  if (!isRecord(assignments)) return 'HTTP assignments must be an object';
  const entries = Object.entries(assignments);
  if (entries.length > HTTP_ACTION_LIMITS.maxAssignments) {
    return `HTTP assignments exceed ${HTTP_ACTION_LIMITS.maxAssignments} entries`;
  }
  for (const [name, path] of entries) {
    if (
      !name ||
      utf8ByteLength(name, HTTP_ACTION_LIMITS.maxAssignmentFieldUtf8Bytes) >
        HTTP_ACTION_LIMITS.maxAssignmentFieldUtf8Bytes ||
      typeof path !== 'string' ||
      utf8ByteLength(path, HTTP_ACTION_LIMITS.maxAssignmentFieldUtf8Bytes) >
        HTTP_ACTION_LIMITS.maxAssignmentFieldUtf8Bytes
    ) {
      return `HTTP assignment names and paths must not exceed ${HTTP_ACTION_LIMITS.maxAssignmentFieldUtf8Bytes} UTF-8 bytes`;
    }
  }
  return null;
}

function validateResponseBindings(params: {
  saveAs?: unknown;
  assign?: unknown;
  okStatus?: unknown;
}): string | null {
  if (
    params.saveAs !== undefined &&
    (typeof params.saveAs !== 'string' ||
      !params.saveAs ||
      utf8ByteLength(params.saveAs, HTTP_ACTION_LIMITS.maxAssignmentFieldUtf8Bytes) >
        HTTP_ACTION_LIMITS.maxAssignmentFieldUtf8Bytes)
  ) {
    return `HTTP saveAs must be a non-empty string up to ${HTTP_ACTION_LIMITS.maxAssignmentFieldUtf8Bytes} UTF-8 bytes`;
  }
  const assignmentViolation = validateAssignments(params.assign);
  if (assignmentViolation) return assignmentViolation;
  if (params.okStatus === undefined) return null;
  if (!isRecord(params.okStatus)) return 'HTTP okStatus must be an object';
  if (params.okStatus.kind === 'range') {
    return typeof params.okStatus.min === 'number' &&
      Number.isInteger(params.okStatus.min) &&
      typeof params.okStatus.max === 'number' &&
      Number.isInteger(params.okStatus.max) &&
      params.okStatus.min >= 100 &&
      params.okStatus.max <= 599 &&
      params.okStatus.min <= params.okStatus.max
      ? null
      : 'HTTP okStatus range must contain integer status codes between 100 and 599';
  }
  if (params.okStatus.kind === 'list') {
    return Array.isArray(params.okStatus.statuses) &&
      params.okStatus.statuses.length > 0 &&
      params.okStatus.statuses.length <= 100 &&
      params.okStatus.statuses.every(
        (status) => Number.isInteger(status) && status >= 100 && status <= 599,
      )
      ? null
      : 'HTTP okStatus list must contain 1 to 100 integer status codes between 100 and 599';
  }
  return 'HTTP okStatus kind must be "range" or "list"';
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

    if (
      utf8ByteLength(url, HTTP_ACTION_LIMITS.maxUrlUtf8Bytes) >
      HTTP_ACTION_LIMITS.maxUrlUtf8Bytes
    ) {
      return failed(
        'VALIDATION_ERROR',
        `URL exceeds ${HTTP_ACTION_LIMITS.maxUrlUtf8Bytes} UTF-8 bytes`,
      );
    }

    // Validate URL format and keep workflow requests on public network schemes.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return failed('VALIDATION_ERROR', `Invalid URL format: ${url}`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return failed('VALIDATION_ERROR', 'HTTP actions only support http:// and https:// URLs');
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
    const bindingViolation = validateResponseBindings(params);
    if (bindingViolation) {
      return failed('VALIDATION_ERROR', bindingViolation);
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
    const timeoutMs = normalizeTimeoutMs(action.policy?.timeout?.ms);
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

      // Parse response
      const responseHeaders = readBoundedResponseHeaders(response);
      const responseText = await readBoundedResponseText(response);

      let responseBody: JsonValue | string | null = null;
      const contentType = response.headers.get('content-type') || '';

      try {
        if (contentType.includes('application/json')) {
          responseBody = JSON.parse(responseText) as JsonValue;
          const shapeViolation = validateJsonShape(responseBody);
          if (shapeViolation) throw new Error(shapeViolation);
        } else {
          responseBody = responseText;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('JSON response exceeds')) {
          throw error;
        }
        responseBody = null;
      }

      const responseUrl = response.url || url;
      if (
        utf8ByteLength(responseUrl, HTTP_ACTION_LIMITS.maxUrlUtf8Bytes) >
        HTTP_ACTION_LIMITS.maxUrlUtf8Bytes
      ) {
        throw new Error(`HTTP response URL exceeds ${HTTP_ACTION_LIMITS.maxUrlUtf8Bytes} bytes`);
      }

      const httpResponse: HttpResponse = {
        url: responseUrl,
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
      };
      const serializedResponse = JSON.stringify(httpResponse);
      if (
        utf8ByteLength(serializedResponse, HTTP_ACTION_LIMITS.maxResponseJsonUtf8Bytes) >
        HTTP_ACTION_LIMITS.maxResponseJsonUtf8Bytes
      ) {
        throw new Error(
          `HTTP response exceeds ${HTTP_ACTION_LIMITS.maxResponseJsonUtf8Bytes} UTF-8 bytes`,
        );
      }

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
      if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
        return failed('TIMEOUT', `HTTP request timed out after ${timeoutMs}ms`);
      }

      return failed(
        'NETWORK_REQUEST_FAILED',
        `HTTP request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  },
};
