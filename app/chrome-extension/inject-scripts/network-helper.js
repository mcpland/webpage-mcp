/**
 * Network Capture Helper
 *
 * This script helps replay network requests with the original cookies and headers.
 */

// Prevent duplicate initialization
if (window.__NETWORK_CAPTURE_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__NETWORK_CAPTURE_HELPER_INITIALIZED__ = true;

  const hasDisallowedPublicUrlScheme = (value) => {
    const normalized = String(value || '').trim();
    const match = normalized.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
    if (!match) {
      return false;
    }

    const protocol = match[1]?.toLowerCase();
    return protocol !== 'http' && protocol !== 'https';
  };

  const getPageContextUrl = () => {
    if (typeof location?.href === 'string' && location.href.trim()) {
      return location.href;
    }
    if (typeof window?.location?.href === 'string' && window.location.href.trim()) {
      return window.location.href;
    }
    return '';
  };

  const DEFAULT_NETWORK_TIMEOUT_MS = 30000;
  const MAX_NETWORK_TIMEOUT_MS = 5 * 60 * 1000;
  const MAX_NETWORK_RESPONSE_BYTES = 8 * 1024 * 1024;
  const MAX_FORM_DATA_ATTACHMENT_BYTES = 16 * 1024 * 1024;
  const MAX_FORM_DATA_TOTAL_ATTACHMENT_BYTES = 32 * 1024 * 1024;

  const formatByteLimit = (bytes) => `${bytes / (1024 * 1024)} MiB`;

  const normalizeTimeout = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return DEFAULT_NETWORK_TIMEOUT_MS;
    }
    return Math.max(1, Math.min(Math.floor(numeric), MAX_NETWORK_TIMEOUT_MS));
  };

  const estimateBase64DecodedBytes = (value) => {
    let encodedCharacters = 0;
    let trailingPadding = 0;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (/\s/.test(character)) continue;
      encodedCharacters += 1;
      if (character === '=') {
        trailingPadding += 1;
      } else {
        trailingPadding = 0;
      }
    }
    return Math.max(
      0,
      Math.floor((encodedCharacters * 3) / 4) - Math.min(trailingPadding, 2),
    );
  };

  const getContentLength = (response) => {
    const value = response.headers.get('content-length');
    if (!value || !/^\d+$/.test(value.trim())) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };

  const readBoundedResponseBody = async (response, byteLimit, label) => {
    const contentLength = getContentLength(response);
    if (contentLength !== null && contentLength > byteLimit) {
      throw new Error(`${label} exceeds the ${formatByteLimit(byteLimit)} limit.`);
    }

    if (!response.body) {
      return new Uint8Array(0);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        totalBytes += value.byteLength;
        if (totalBytes > byteLimit) {
          await reader.cancel(`${label} exceeds byte limit`).catch(() => undefined);
          throw new Error(`${label} exceeds the ${formatByteLimit(byteLimit)} limit.`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  };

  const fetchBoundedResponse = async (
    url,
    options,
    timeoutMs,
    byteLimit,
    label,
    requireOk,
    consumeBody = true,
  ) => {
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (requireOk && !response.ok) {
        throw new Error(`${label} returned HTTP ${response.status}.`);
      }
      const bytes = consumeBody
        ? await readBoundedResponseBody(response, byteLimit, label)
        : new Uint8Array(0);
      return { response, bytes };
    } catch (error) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
      if (didTimeout) {
        throw new Error(`${label} timed out after ${timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  /**
   * Replay a network request
   * @param {string} url - The URL to send the request to
   * @param {string} method - The HTTP method to use
   * @param {Object} headers - The headers to include in the request
   * @param {any} body - The body of the request
   * @param {number} timeout - Timeout in milliseconds (default: 30000)
   * @returns {Promise<Object>} - The response data
   */
  async function replayNetworkRequest(
    url,
    method,
    headers,
    body,
    timeout = 30000,
    formDataDescriptor = null,
  ) {
    try {
      const effectiveTimeout = normalizeTimeout(timeout);

      if (hasDisallowedPublicUrlScheme(getPageContextUrl())) {
        return {
          success: false,
          error: 'Only http:// and https:// pages are supported by chrome_network_request.',
        };
      }

      if (hasDisallowedPublicUrlScheme(url)) {
        return {
          success: false,
          error: 'Only http:// and https:// URLs are allowed for chrome_network_request.',
        };
      }

      // Create fetch options
      const options = {
        method: method,
        headers: headers || {},
        credentials: 'include', // Include cookies
        mode: 'cors',
        cache: 'no-cache',
      };

      // Helper: convert base64 to Blob
      let totalAttachmentBytes = 0;
      const accountForAttachment = (byteLength) => {
        if (byteLength > MAX_FORM_DATA_ATTACHMENT_BYTES) {
          throw new Error(
            `FormData attachment exceeds the ${formatByteLimit(MAX_FORM_DATA_ATTACHMENT_BYTES)} limit.`,
          );
        }
        if (totalAttachmentBytes + byteLength > MAX_FORM_DATA_TOTAL_ATTACHMENT_BYTES) {
          throw new Error(
            `FormData attachments exceed the ${formatByteLimit(MAX_FORM_DATA_TOTAL_ATTACHMENT_BYTES)} total limit.`,
          );
        }
        totalAttachmentBytes += byteLength;
      };

      const base64ToBlob = (base64, contentType = 'application/octet-stream') => {
        const estimatedBytes = estimateBase64DecodedBytes(base64);
        accountForAttachment(estimatedBytes);
        try {
          const decodedString = atob(base64);
          const len = decodedString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) bytes[i] = decodedString.charCodeAt(i);
          return new Blob([bytes], { type: contentType });
        } catch (e) {
          totalAttachmentBytes -= estimatedBytes;
          throw new Error('Invalid base64 FormData attachment.');
        }
      };

      const downloadFormDataAttachment = async (attachmentUrl) => {
        const { response, bytes } = await fetchBoundedResponse(
          attachmentUrl,
          {},
          effectiveTimeout,
          MAX_FORM_DATA_ATTACHMENT_BYTES,
          'FormData attachment',
          true,
        );
        accountForAttachment(bytes.byteLength);
        return new Blob([bytes], {
          type: response.headers.get('content-type') || 'application/octet-stream',
        });
      };

      // Build multipart/form-data if descriptor is provided
      if (method !== 'GET' && method !== 'HEAD' && formDataDescriptor) {
        const fd = new FormData();
        try {
          if (Array.isArray(formDataDescriptor)) {
            for (const item of formDataDescriptor) {
              if (!Array.isArray(item) || item.length < 2) continue;
              const name = String(item[0] || 'file');
              const spec = String(item[1] || '');
              const filenameHint = item[2] ? String(item[2]) : undefined;
              if (/^(https?:\/\/|url:)/i.test(spec)) {
                const url = spec.replace(/^url:/i, '');
                if (hasDisallowedPublicUrlScheme(url)) {
                  throw new Error(
                    'Only http:// and https:// URLs are allowed for chrome_network_request formData attachments.',
                  );
                }
                const blob = await downloadFormDataAttachment(url);
                const fn =
                  filenameHint || url.split('?')[0].split('#')[0].split('/').pop() || 'file';
                fd.append(name, blob, fn);
              } else if (/^base64:/i.test(spec)) {
                const b64 = spec.replace(/^base64:/i, '');
                const blob = base64ToBlob(b64);
                fd.append(name, blob, filenameHint || 'file');
              } else if (/^file:/i.test(spec)) {
                throw new Error(
                  'Local file paths are not supported in chrome_network_request formData. Use fileUrl or base64Data instead.',
                );
              } else {
                // treat as string field
                fd.append(name, spec);
              }
            }
          } else if (typeof formDataDescriptor === 'object') {
            const fds = formDataDescriptor;
            const fields = fds.fields || {};
            const files = Array.isArray(fds.files) ? fds.files : [];
            for (const [k, v] of Object.entries(fields)) fd.append(String(k), String(v));
            for (const file of files) {
              const name = String(file.name || 'file');
              if (file.fileUrl) {
                if (hasDisallowedPublicUrlScheme(file.fileUrl)) {
                  throw new Error(
                    'Only http:// and https:// URLs are allowed for chrome_network_request formData attachments.',
                  );
                }
                const blob = await downloadFormDataAttachment(String(file.fileUrl));
                const fn =
                  file.filename ||
                  String(file.fileUrl).split('?')[0].split('#')[0].split('/').pop() ||
                  'file';
                fd.append(name, blob, fn);
              } else if (file.base64Data) {
                const blob = base64ToBlob(
                  String(file.base64Data),
                  String(file.contentType || 'application/octet-stream'),
                );
                fd.append(name, blob, file.filename || 'file');
              } else if (file.filePath) {
                throw new Error(
                  'Local file paths are not supported in chrome_network_request formData. Use fileUrl or base64Data instead.',
                );
              }
            }
          }
        } catch (e) {
          console.warn('Failed to construct FormData:', e);
          return {
            success: false,
            error: `Failed to construct FormData: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
        // Let browser set the correct multipart boundary
        try {
          if (options.headers) {
            delete options.headers['content-type'];
            delete options.headers['Content-Type'];
          }
        } catch {}
        options.body = fd;
      } else if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
        // Fallback to raw body
        options.body = body;
      }

      // Keep the request timeout active until the bounded response body has been consumed.
      const { response, bytes: responseBytes } = await fetchBoundedResponse(
        url,
        options,
        effectiveTimeout,
        MAX_NETWORK_RESPONSE_BYTES,
        'Network response',
        false,
        method !== 'HEAD',
      );

      // Process response
      const responseData = {
        status: response.status,
        statusText: response.statusText,
        headers: {},
      };

      // Get response headers
      response.headers.forEach((value, key) => {
        responseData.headers[key] = value;
      });

      // Try to get response body based on content type
      const contentType = response.headers.get('content-type') || '';
      const decodedBody = new TextDecoder().decode(responseBytes);

      try {
        if (contentType.includes('application/json')) {
          responseData.body = JSON.parse(decodedBody);
        } else if (
          contentType.includes('text/') ||
          contentType.includes('application/xml') ||
          contentType.includes('application/javascript')
        ) {
          responseData.body = decodedBody;
        } else {
          // For binary data, just indicate it was received but not parsed
          responseData.body = '[Binary data not displayed]';
        }
      } catch (error) {
        responseData.body = `[Error parsing response body: ${error.message}]`;
      }

      return {
        success: response.ok,
        ...(response.ok
          ? {}
          : { error: `Network request returned HTTP ${response.status}.` }),
        response: responseData,
      };
    } catch (error) {
      console.error('Error replaying request:', error);
      return {
        success: false,
        error: `Error replaying request: ${error.message}`,
      };
    }
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    // Respond to ping message
    if (request.action === 'chrome_network_request_ping') {
      sendResponse({ status: 'pong' });
      return false; // Synchronous response
    } else if (request.action === 'sendPureNetworkRequest') {
      replayNetworkRequest(
        request.url,
        request.method,
        request.headers,
        request.body,
        request.timeout,
        request.formData,
      )
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            success: false,
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    }
  });
}
