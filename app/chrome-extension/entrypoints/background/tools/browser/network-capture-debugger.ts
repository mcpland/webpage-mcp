import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { NETWORK_FILTERS } from '@/common/constants';
import {
  NETWORK_CAPTURE_LIMITS,
  boundCaptureResult,
  jsonByteLength,
  normalizeCaptureTimings,
  normalizeEventTime,
  responseBodyKnownTooLarge,
  sanitizeHeaderRecord,
  truncateUtf8,
  utf8ByteLength,
} from './network-capture-limits';

interface NetworkDebuggerStartToolParams {
  url?: string; // URL to navigate to or focus. If not provided, uses active tab.
  maxCaptureTime?: number;
  inactivityTimeout?: number; // Inactivity timeout (milliseconds)
  includeStatic?: boolean; // if include static resources
  tabId?: number;
  windowId?: number;
  background?: boolean;
}

interface NetworkDebuggerStopToolParams {
  tabId?: number;
  windowId?: number;
  all?: boolean;
}

// Network request object interface
interface NetworkRequestInfo {
  requestId: string;
  url: string;
  method: string;
  requestHeaders?: Record<string, string>; // Will be removed after common headers extraction
  responseHeaders?: Record<string, string>; // Will be removed after common headers extraction
  requestTime?: number; // Timestamp of the request
  responseTime?: number; // Timestamp of the response
  type: string; // Resource type (e.g., Document, XHR, Fetch, Script, Stylesheet)
  status: string; // 'pending', 'complete', 'error'
  statusCode?: number;
  statusText?: string;
  requestBody?: string;
  responseBody?: string;
  base64Encoded?: boolean; // For responseBody
  encodedDataLength?: number; // Actual bytes received
  errorText?: string; // If loading failed
  canceled?: boolean; // If loading was canceled
  mimeType?: string;
  specificRequestHeaders?: Record<string, string>; // Headers unique to this request
  specificResponseHeaders?: Record<string, string>; // Headers unique to this response
  [key: string]: any; // Allow other properties from debugger events
}

const DEBUGGER_PROTOCOL_VERSION = '1.3';
/**
 * Network capture start tool - uses Chrome Debugger API to start capturing network requests
 */
class NetworkDebuggerStartTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START;
  private captureData: Map<number, any> = new Map(); // tabId -> capture data
  private captureTimers: Map<number, NodeJS.Timeout> = new Map(); // tabId -> max capture timer
  private inactivityTimers: Map<number, NodeJS.Timeout> = new Map(); // tabId -> inactivity timer
  private lastActivityTime: Map<number, number> = new Map(); // tabId -> timestamp of last network activity
  private pendingResponseBodies: Map<string, Promise<any>> = new Map(); // requestId -> promise for getResponseBody
  private requestCounters: Map<number, number> = new Map(); // tabId -> count of captured requests (after filtering)
  private completedCaptures = new Map<
    number,
    { expiresAt: number; result: { success: boolean; message?: string; data?: any } }
  >();
  private pendingInheritedTabs = new Set<number>();
  private static MAX_REQUESTS_PER_CAPTURE = 100; // Max requests to store to prevent memory issues
  public static instance: NetworkDebuggerStartTool | null = null;

  constructor() {
    super();
    if (NetworkDebuggerStartTool.instance) {
      return NetworkDebuggerStartTool.instance;
    }
    NetworkDebuggerStartTool.instance = this;

    chrome.debugger.onEvent.addListener(this.handleDebuggerEvent.bind(this));
    chrome.debugger.onDetach.addListener(this.handleDebuggerDetach.bind(this));
    chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this));
    chrome.tabs.onCreated.addListener(this.handleTabCreated.bind(this));
  }

  private handleTabRemoved(tabId: number) {
    if (this.captureData.has(tabId)) {
      console.log(`NetworkDebuggerStartTool: Tab ${tabId} was closed, cleaning up resources.`);
      void this.stopCapture(tabId, true, 'tab_closed');
    }
  }

  /**
   * Handle tab creation events
   * If a new tab is opened from a tab that is currently capturing, automatically start capturing the new tab's requests
   */
  private async handleTabCreated(tab: chrome.tabs.Tab) {
    try {
      // Check if there are any tabs currently capturing
      if (this.captureData.size === 0) return;

      // Get the openerTabId of the new tab (ID of the tab that opened this tab)
      const openerTabId = tab.openerTabId;
      if (!openerTabId) return;

      // Check if the opener tab is currently capturing
      if (!this.captureData.has(openerTabId)) return;

      // Get the new tab's ID
      const newTabId = tab.id;
      if (!newTabId) return;

      // Get the opener tab's capture settings
      const openerCaptureInfo = this.captureData.get(openerTabId);
      if (!openerCaptureInfo) return;
      if (
        openerCaptureInfo.lineageDepth >= NETWORK_CAPTURE_LIMITS.maxLineageDepth ||
        this.captureData.size + this.pendingInheritedTabs.size >= NETWORK_CAPTURE_LIMITS.maxTabs ||
        this.pendingInheritedTabs.has(newTabId) ||
        Date.now() >= openerCaptureInfo.deadlineAt
      ) {
        return;
      }
      console.log(
        `NetworkDebuggerStartTool: New tab ${newTabId} created from capturing tab ${openerTabId}, will extend capture to it.`,
      );
      this.pendingInheritedTabs.add(newTabId);

      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const remainingMs = openerCaptureInfo.deadlineAt - Date.now();
        if (
          remainingMs < NETWORK_CAPTURE_LIMITS.minCaptureTimeMs ||
          this.captureData.size >= NETWORK_CAPTURE_LIMITS.maxTabs
        ) {
          return;
        }
        await this.startCaptureForTab(newTabId, {
          maxCaptureTime: remainingMs,
          inactivityTimeout: Math.min(openerCaptureInfo.inactivityTimeout, remainingMs),
          includeStatic: openerCaptureInfo.includeStatic,
          rootTabId: openerCaptureInfo.rootTabId,
          lineageDepth: openerCaptureInfo.lineageDepth + 1,
          deadlineAt: openerCaptureInfo.deadlineAt,
        });
      } finally {
        this.pendingInheritedTabs.delete(newTabId);
      }

      console.log(`NetworkDebuggerStartTool: Successfully extended capture to new tab ${newTabId}`);
    } catch (error) {
      console.error(`NetworkDebuggerStartTool: Error extending capture to new tab:`, error);
    }
  }

  /**
   * Start network request capture for specified tab
   * @param tabId Tab ID
   * @param options Capture options
   */
  private async startCaptureForTab(
    tabId: number,
    options: {
      maxCaptureTime: number;
      inactivityTimeout: number;
      includeStatic: boolean;
      rootTabId?: number;
      lineageDepth?: number;
      deadlineAt?: number;
    },
  ): Promise<void> {
    this.pruneCompletedCaptures();
    if (!this.captureData.has(tabId) && this.captureData.size >= NETWORK_CAPTURE_LIMITS.maxTabs) {
      throw new Error(`network capture is limited to ${NETWORK_CAPTURE_LIMITS.maxTabs} tabs`);
    }
    const now = Date.now();
    const deadlineAt = options.deadlineAt ?? now + options.maxCaptureTime;
    const maxCaptureTime = Math.max(
      NETWORK_CAPTURE_LIMITS.minCaptureTimeMs,
      Math.min(options.maxCaptureTime, deadlineAt - now),
    );
    const inactivityTimeout = Math.min(options.inactivityTimeout, maxCaptureTime);
    const { includeStatic } = options;

    // If already capturing, stop first
    if (this.captureData.has(tabId)) {
      console.log(
        `NetworkDebuggerStartTool: Already capturing on tab ${tabId}. Stopping previous session.`,
      );
      await this.stopCapture(tabId);
    }

    try {
      // Get tab information
      const tab = await chrome.tabs.get(tabId);
      this.completedCaptures.delete(tabId);

      // Attach via shared manager (handles conflicts and refcount)
      await cdpSessionManager.attach(tabId, 'network-capture');

      // Enable network tracking
      try {
        await cdpSessionManager.sendCommand(tabId, 'Network.enable', {
          maxTotalBufferSize: NETWORK_CAPTURE_LIMITS.maxCaptureBytes,
          maxResourceBufferSize: NETWORK_CAPTURE_LIMITS.maxResponseBodyBytes,
          maxPostDataSize: NETWORK_CAPTURE_LIMITS.maxRequestBodyBytes,
        });
      } catch (error: any) {
        await cdpSessionManager
          .detach(tabId, 'network-capture')
          .catch((e) => console.warn('Error detaching after failed enable:', e));
        throw error;
      }

      // Initialize capture data
      this.captureData.set(tabId, {
        startTime: Date.now(),
        tabUrl: truncateUtf8(tab.url, NETWORK_CAPTURE_LIMITS.maxUrlBytes),
        tabTitle: truncateUtf8(tab.title, 1_024),
        maxCaptureTime,
        inactivityTimeout,
        includeStatic,
        requests: {},
        limitReached: false,
        byteLimitReached: false,
        storedBytes: 0,
        responseBodyBytes: 0,
        rootTabId: options.rootTabId ?? tabId,
        lineageDepth: options.lineageDepth ?? 0,
        deadlineAt,
      });

      // Initialize request counter
      this.requestCounters.set(tabId, 0);

      // Update last activity time
      this.updateLastActivityTime(tabId);

      console.log(
        `NetworkDebuggerStartTool: Started capture for tab ${tabId} (${truncateUtf8(tab.url, 512)}). Max requests: ${NetworkDebuggerStartTool.MAX_REQUESTS_PER_CAPTURE}, Max time: ${maxCaptureTime}ms, Inactivity: ${inactivityTimeout}ms.`,
      );

      // Set maximum capture time
      if (maxCaptureTime > 0) {
        this.captureTimers.set(
          tabId,
          setTimeout(async () => {
            console.log(
              `NetworkDebuggerStartTool: Max capture time (${maxCaptureTime}ms) reached for tab ${tabId}.`,
            );
            await this.stopCapture(tabId, true, 'max_capture_time');
          }, maxCaptureTime),
        );
      }
    } catch (error: any) {
      console.error(`NetworkDebuggerStartTool: Error starting capture for tab ${tabId}:`, error);

      // Clean up resources
      if (this.captureData.has(tabId)) {
        await cdpSessionManager
          .detach(tabId, 'network-capture')
          .catch((e) => console.warn('Cleanup detach error:', e));
        this.cleanupCapture(tabId);
      }

      throw error;
    }
  }

  private handleDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params?: any) {
    if (!source.tabId) return;

    const tabId = source.tabId;
    const captureInfo = this.captureData.get(tabId);

    if (!captureInfo) return; // Not capturing for this tab

    // Update last activity time for any relevant network event
    this.updateLastActivityTime(tabId);

    switch (method) {
      case 'Network.requestWillBeSent':
        this.handleRequestWillBeSent(tabId, params);
        break;
      case 'Network.responseReceived':
        this.handleResponseReceived(tabId, params);
        break;
      case 'Network.loadingFinished':
        this.handleLoadingFinished(tabId, params);
        break;
      case 'Network.loadingFailed':
        this.handleLoadingFailed(tabId, params);
        break;
    }
  }

  private handleDebuggerDetach(source: chrome.debugger.Debuggee, reason: string) {
    if (source.tabId && this.captureData.has(source.tabId)) {
      console.log(
        `NetworkDebuggerStartTool: Debugger detached from tab ${source.tabId}, reason: ${reason}. Cleaning up.`,
      );
      // Potentially inform the user or log the result if the detachment was unexpected
      this.cleanupCapture(source.tabId); // Ensure cleanup happens
    }
  }

  private updateLastActivityTime(tabId: number) {
    this.lastActivityTime.set(tabId, Date.now());
    const captureInfo = this.captureData.get(tabId);

    if (captureInfo && captureInfo.inactivityTimeout > 0) {
      if (this.inactivityTimers.has(tabId)) {
        clearTimeout(this.inactivityTimers.get(tabId)!);
      }
      this.inactivityTimers.set(
        tabId,
        setTimeout(() => this.checkInactivity(tabId), captureInfo.inactivityTimeout),
      );
    }
  }

  private checkInactivity(tabId: number) {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) return;

    const lastActivity = this.lastActivityTime.get(tabId) || captureInfo.startTime; // Use startTime if no activity yet
    const now = Date.now();
    const inactiveTime = now - lastActivity;

    if (inactiveTime >= captureInfo.inactivityTimeout) {
      console.log(
        `NetworkDebuggerStartTool: No activity for ${inactiveTime}ms (threshold: ${captureInfo.inactivityTimeout}ms), stopping capture for tab ${tabId}`,
      );
      this.stopCaptureByInactivity(tabId);
    } else {
      // Reschedule check for the remaining time, this handles system sleep or other interruptions
      const remainingTime = Math.max(0, captureInfo.inactivityTimeout - inactiveTime);
      this.inactivityTimers.set(
        tabId,
        setTimeout(() => this.checkInactivity(tabId), remainingTime),
      );
    }
  }

  private async stopCaptureByInactivity(tabId: number) {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) return;

    console.log(`NetworkDebuggerStartTool: Stopping capture due to inactivity for tab ${tabId}.`);
    // Potentially, we might want to notify the client/user that this happened.
    // For now, just stop and make the results available if StopTool is called.
    await this.stopCapture(tabId, true, 'inactivity_timeout');
  }

  /**
   * Check if URL should be filtered based on EXCLUDED_DOMAINS patterns.
   * Uses full URL substring match to support patterns like 'facebook.com/tr'.
   */
  private shouldFilterRequestByUrl(url: string): boolean {
    const normalizedUrl = String(url || '').toLowerCase();
    if (!normalizedUrl) return false;
    return NETWORK_FILTERS.EXCLUDED_DOMAINS.some((pattern) => normalizedUrl.includes(pattern));
  }

  private shouldFilterRequestByExtension(url: string, includeStatic: boolean): boolean {
    if (includeStatic) return false;

    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname.toLowerCase();
      return NETWORK_FILTERS.STATIC_RESOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
    } catch {
      return false;
    }
  }

  private shouldFilterByMimeType(mimeType: string, includeStatic: boolean): boolean {
    if (!mimeType) return false;

    // Never filter API MIME types
    if (NETWORK_FILTERS.API_MIME_TYPES.some((apiMime) => mimeType.startsWith(apiMime))) {
      return false;
    }

    // Filter static MIME types when not including static resources
    if (!includeStatic) {
      return NETWORK_FILTERS.STATIC_MIME_TYPES_TO_FILTER.some((staticMime) =>
        mimeType.startsWith(staticMime),
      );
    }

    return false;
  }

  private storeRequest(captureInfo: any, storageKey: string, requestInfo: NetworkRequestInfo) {
    const bytes = jsonByteLength(requestInfo);
    if (captureInfo.storedBytes + bytes > NETWORK_CAPTURE_LIMITS.maxCaptureBytes) {
      captureInfo.byteLimitReached = true;
      return false;
    }
    captureInfo.requests[storageKey] = requestInfo;
    captureInfo.storedBytes += bytes;
    return true;
  }

  private setRequestField(
    captureInfo: any,
    requestInfo: NetworkRequestInfo,
    field: keyof NetworkRequestInfo,
    value: unknown,
  ): boolean {
    const previous = requestInfo[field];
    const previousBytes = previous === undefined ? 0 : jsonByteLength({ [field]: previous });
    const nextBytes = value === undefined ? 0 : jsonByteLength({ [field]: value });
    const projected = captureInfo.storedBytes - previousBytes + nextBytes;
    if (projected > NETWORK_CAPTURE_LIMITS.maxCaptureBytes) {
      captureInfo.byteLimitReached = true;
      return false;
    }
    requestInfo[field] = value;
    captureInfo.storedBytes = Math.max(0, projected);
    return true;
  }

  private handleRequestWillBeSent(tabId: number, params: any) {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) return;

    const { requestId, request, timestamp, type, loaderId, frameId } = params;
    const boundedUrl = truncateUtf8(request.url, NETWORK_CAPTURE_LIMITS.maxUrlBytes);

    // Initial filtering by URL (ads, analytics) and extension (if !includeStatic)
    if (
      this.shouldFilterRequestByUrl(boundedUrl) ||
      this.shouldFilterRequestByExtension(boundedUrl, captureInfo.includeStatic)
    ) {
      return;
    }

    const currentCount = this.requestCounters.get(tabId) || 0;
    if (currentCount >= NetworkDebuggerStartTool.MAX_REQUESTS_PER_CAPTURE) {
      // console.log(`NetworkDebuggerStartTool: Request limit (${NetworkDebuggerStartTool.MAX_REQUESTS_PER_CAPTURE}) reached for tab ${tabId}. Ignoring: ${request.url}`);
      captureInfo.limitReached = true; // Mark that limit was hit
      return;
    }

    // Store initial request info
    // Ensure we don't overwrite if a redirect (same requestId) occurred, though usually loaderId changes
    if (!captureInfo.requests[requestId]) {
      // Or check based on loaderId as well if needed
      const requestInfo: NetworkRequestInfo = {
        requestId: truncateUtf8(requestId, 256),
        url: boundedUrl,
        method: truncateUtf8(request.method, NETWORK_CAPTURE_LIMITS.maxMethodBytes),
        requestHeaders: sanitizeHeaderRecord(request.headers),
        requestTime: normalizeEventTime(timestamp, 1_000),
        type: truncateUtf8(type || 'Other', NETWORK_CAPTURE_LIMITS.maxTypeBytes),
        status: 'pending', // Initial status
        loaderId: truncateUtf8(loaderId, 256),
        frameId: truncateUtf8(frameId, 256),
      };

      if (request.postData) {
        requestInfo.requestBody = truncateUtf8(
          request.postData,
          NETWORK_CAPTURE_LIMITS.maxRequestBodyBytes,
        );
      }
      this.storeRequest(captureInfo, requestId, requestInfo);
      // console.log(`NetworkDebuggerStartTool: Captured request for tab ${tabId}: ${request.method} ${request.url}`);
    } else {
      // This could be a redirect. Update URL and other relevant fields.
      // Chrome often issues a new `requestWillBeSent` for redirects with the same `requestId` but a new `loaderId`.
      // console.log(`NetworkDebuggerStartTool: Request ${requestId} updated (likely redirect) for tab ${tabId} to URL: ${request.url}`);
      const existingRequest = captureInfo.requests[requestId];
      this.setRequestField(
        captureInfo,
        existingRequest,
        'url',
        boundedUrl,
      );
      this.setRequestField(
        captureInfo,
        existingRequest,
        'requestTime',
        normalizeEventTime(timestamp, 1_000),
      );
      if (request.headers) {
        this.setRequestField(
          captureInfo,
          existingRequest,
          'requestHeaders',
          sanitizeHeaderRecord(request.headers),
        );
      }
      this.setRequestField(
        captureInfo,
        existingRequest,
        'requestBody',
        request.postData
          ? truncateUtf8(request.postData, NETWORK_CAPTURE_LIMITS.maxRequestBodyBytes)
          : undefined,
      );
    }
  }

  private handleResponseReceived(tabId: number, params: any) {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) return;

    const { requestId, response, timestamp, type } = params; // type here is resource type
    const requestInfo: NetworkRequestInfo = captureInfo.requests[requestId];

    if (!requestInfo) {
      // console.warn(`NetworkDebuggerStartTool: Received response for unknown requestId ${requestId} on tab ${tabId}`);
      return;
    }

    // Secondary filtering based on MIME type, now that we have it
    if (this.shouldFilterByMimeType(response.mimeType, captureInfo.includeStatic)) {
      // console.log(`NetworkDebuggerStartTool: Filtering request by MIME type (${response.mimeType}): ${requestInfo.url}`);
      delete captureInfo.requests[requestId]; // Remove from captured data
      captureInfo.storedBytes = Math.max(
        0,
        captureInfo.storedBytes - jsonByteLength(requestInfo),
      );
      // Note: We don't decrement requestCounter here as it's meant to track how many *potential* requests were processed up to MAX_REQUESTS.
      // Or, if MAX_REQUESTS is strictly for *stored* requests, then decrement. For now, let's assume it's for stored.
      // const currentCount = this.requestCounters.get(tabId) || 0;
      // if (currentCount > 0) this.requestCounters.set(tabId, currentCount -1);
      return;
    }

    // If not filtered by MIME, then increment actual stored request counter
    const currentStoredCount = Object.keys(captureInfo.requests).length; // A bit inefficient but accurate
    this.requestCounters.set(tabId, currentStoredCount);

    this.setRequestField(
      captureInfo,
      requestInfo,
      'status',
      response.status === 0 ? 'pending' : 'complete',
    );
    this.setRequestField(captureInfo, requestInfo, 'statusCode', response.status);
    this.setRequestField(
      captureInfo,
      requestInfo,
      'statusText',
      truncateUtf8(response.statusText, NETWORK_CAPTURE_LIMITS.maxStatusTextBytes),
    );
    this.setRequestField(
      captureInfo,
      requestInfo,
      'responseHeaders',
      sanitizeHeaderRecord(response.headers),
    );
    this.setRequestField(
      captureInfo,
      requestInfo,
      'mimeType',
      truncateUtf8(response.mimeType, NETWORK_CAPTURE_LIMITS.maxMimeTypeBytes),
    );
    this.setRequestField(
      captureInfo,
      requestInfo,
      'responseTime',
      normalizeEventTime(timestamp, 1_000),
    );
    if (type) {
      this.setRequestField(
        captureInfo,
        requestInfo,
        'type',
        truncateUtf8(type, NETWORK_CAPTURE_LIMITS.maxTypeBytes),
      );
    }

    // console.log(`NetworkDebuggerStartTool: Received response for ${requestId} on tab ${tabId}: ${response.status}`);
  }

  private async handleLoadingFinished(tabId: number, params: any) {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) return;

    const { requestId, encodedDataLength } = params;
    const requestInfo: NetworkRequestInfo = captureInfo.requests[requestId];

    if (!requestInfo) {
      // console.warn(`NetworkDebuggerStartTool: LoadingFinished for unknown requestId ${requestId} on tab ${tabId}`);
      return;
    }

    const normalizedEncodedLength = normalizeEventTime(encodedDataLength);
    this.setRequestField(
      captureInfo,
      requestInfo,
      'encodedDataLength',
      normalizedEncodedLength,
    );
    if (requestInfo.status === 'pending') {
      this.setRequestField(captureInfo, requestInfo, 'status', 'complete');
    }
    // requestInfo.responseTime is usually set by responseReceived, but this timestamp is later.
    // timestamp here is when the resource finished loading. Could be useful for duration calculation.

    const remainingBodyBytes = Math.max(
      0,
      NETWORK_CAPTURE_LIMITS.maxResponseBodiesBytes - captureInfo.responseBodyBytes,
    );
    if (
      this.shouldCaptureResponseBody(requestInfo) &&
      remainingBodyBytes > 0 &&
      !responseBodyKnownTooLarge(requestInfo)
    ) {
      try {
        // console.log(`NetworkDebuggerStartTool: Attempting to get response body for ${requestId} (${requestInfo.url})`);
        const responseBodyData = await this.getResponseBody(tabId, requestId);
        if (responseBodyData) {
          const bodyLimit = Math.min(
            NETWORK_CAPTURE_LIMITS.maxResponseBodyBytes,
            remainingBodyBytes,
            Math.max(0, NETWORK_CAPTURE_LIMITS.maxCaptureBytes - captureInfo.storedBytes),
          );
          if (bodyLimit <= 0) {
            this.setRequestField(
              captureInfo,
              requestInfo,
              'responseBodyOmitted',
              'capture_byte_budget',
            );
            return;
          }
          const originalBodyBytes = utf8ByteLength(responseBodyData.body);
          if (responseBodyData.base64Encoded === true && originalBodyBytes > bodyLimit) {
            this.setRequestField(
              captureInfo,
              requestInfo,
              'responseBodyOmitted',
              'base64_size_limit',
            );
            return;
          }
          const boundedBody = truncateUtf8(responseBodyData.body, bodyLimit);
          if (this.setRequestField(captureInfo, requestInfo, 'responseBody', boundedBody)) {
            const storedBodyBytes = utf8ByteLength(boundedBody);
            captureInfo.responseBodyBytes += storedBodyBytes;
            if (storedBodyBytes < originalBodyBytes) {
              this.setRequestField(
                captureInfo,
                requestInfo,
                'responseBodyTruncated',
                true,
              );
            }
            this.setRequestField(
              captureInfo,
              requestInfo,
              'base64Encoded',
              responseBodyData.base64Encoded === true,
            );
          }
          // console.log(`NetworkDebuggerStartTool: Successfully got response body for ${requestId}, size: ${requestInfo.responseBody?.length || 0} bytes`);
        }
      } catch (error) {
        // console.warn(`NetworkDebuggerStartTool: Failed to get response body for ${requestId}:`, error);
        this.setRequestField(
          captureInfo,
          requestInfo,
          'errorText',
          truncateUtf8(
            `${requestInfo.errorText || ''} Failed to get body: ${
              error instanceof Error ? error.message : String(error)
            }`,
            NETWORK_CAPTURE_LIMITS.maxErrorBytes,
          ),
        );
      }
    } else if (this.shouldCaptureResponseBody(requestInfo)) {
      this.setRequestField(
        captureInfo,
        requestInfo,
        'responseBodyOmitted',
        remainingBodyBytes <= 0 ? 'capture_body_budget' : 'known_size_limit',
      );
    }
  }

  private shouldCaptureResponseBody(requestInfo: NetworkRequestInfo): boolean {
    const mimeType = requestInfo.mimeType || '';

    // Prioritize API MIME types for body capture
    if (NETWORK_FILTERS.API_MIME_TYPES.some((type) => mimeType.startsWith(type))) {
      return true;
    }

    // Heuristics for other potential API calls not perfectly matching MIME types
    const url = requestInfo.url.toLowerCase();
    if (
      /\/(api|service|rest|graphql|query|data|rpc|v[0-9]+)\//i.test(url) ||
      url.includes('.json') ||
      url.includes('json=') ||
      url.includes('format=json')
    ) {
      // If it looks like an API call by URL structure, try to get body,
      // unless it's a known non-API MIME type that slipped through (e.g. a script from a /api/ path)
      if (
        mimeType &&
        NETWORK_FILTERS.STATIC_MIME_TYPES_TO_FILTER.some((staticMime) =>
          mimeType.startsWith(staticMime),
        )
      ) {
        return false; // e.g. a CSS file served from an /api/ path
      }
      return true;
    }

    return false;
  }

  private handleLoadingFailed(tabId: number, params: any) {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) return;

    const { requestId, errorText, canceled, type } = params;
    const requestInfo: NetworkRequestInfo = captureInfo.requests[requestId];

    if (!requestInfo) {
      // console.warn(`NetworkDebuggerStartTool: LoadingFailed for unknown requestId ${requestId} on tab ${tabId}`);
      return;
    }

    this.setRequestField(captureInfo, requestInfo, 'status', 'error');
    this.setRequestField(
      captureInfo,
      requestInfo,
      'errorText',
      truncateUtf8(errorText, NETWORK_CAPTURE_LIMITS.maxErrorBytes),
    );
    this.setRequestField(captureInfo, requestInfo, 'canceled', canceled === true);
    if (type) {
      this.setRequestField(
        captureInfo,
        requestInfo,
        'type',
        truncateUtf8(type, NETWORK_CAPTURE_LIMITS.maxTypeBytes),
      );
    }
    // timestamp here is when loading failed.
    // console.log(`NetworkDebuggerStartTool: Loading failed for ${requestId} on tab ${tabId}: ${errorText}`);
  }

  private async getResponseBody(
    tabId: number,
    requestId: string,
  ): Promise<{ body: string; base64Encoded: boolean } | null> {
    const pendingKey = `${tabId}_${requestId}`;
    if (this.pendingResponseBodies.has(pendingKey)) {
      return this.pendingResponseBodies.get(pendingKey)!; // Return existing promise
    }
    if (this.pendingResponseBodies.size >= NETWORK_CAPTURE_LIMITS.maxPendingResponseBodies) {
      return null;
    }

    const responseBodyPromise = (async () => {
      try {
        // Will attach temporarily if needed
        const result = (await cdpSessionManager.sendCommand(tabId, 'Network.getResponseBody', {
          requestId,
        })) as { body: string; base64Encoded: boolean };
        return result;
      } finally {
        this.pendingResponseBodies.delete(pendingKey); // Clean up after promise resolves or rejects
      }
    })();

    this.pendingResponseBodies.set(pendingKey, responseBodyPromise);
    return responseBodyPromise;
  }

  private cleanupCapture(tabId: number) {
    if (this.captureTimers.has(tabId)) {
      clearTimeout(this.captureTimers.get(tabId)!);
      this.captureTimers.delete(tabId);
    }
    if (this.inactivityTimers.has(tabId)) {
      clearTimeout(this.inactivityTimers.get(tabId)!);
      this.inactivityTimers.delete(tabId);
    }

    this.lastActivityTime.delete(tabId);
    this.captureData.delete(tabId);
    this.requestCounters.delete(tabId);

    // In-flight CDP commands cannot be aborted. Keep their entries until their
    // own finally block runs so the global concurrency cap remains truthful.

    console.log(`NetworkDebuggerStartTool: Cleaned up resources for tab ${tabId}.`);
  }

  private pruneCompletedCaptures(now = Date.now()) {
    for (const [tabId, completed] of this.completedCaptures) {
      if (completed.expiresAt <= now) this.completedCaptures.delete(tabId);
    }
  }

  private cacheCompletedCapture(
    tabId: number,
    result: { success: boolean; message?: string; data?: any },
  ) {
    this.pruneCompletedCaptures();
    while (this.completedCaptures.size >= NETWORK_CAPTURE_LIMITS.maxCompletedResults) {
      const oldest = this.completedCaptures.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.completedCaptures.delete(oldest);
    }
    this.completedCaptures.set(tabId, {
      expiresAt: Date.now() + NETWORK_CAPTURE_LIMITS.completedResultTtlMs,
      result,
    });
  }

  public getAvailableTabIds(): number[] {
    this.pruneCompletedCaptures();
    return Array.from(new Set([...this.captureData.keys(), ...this.completedCaptures.keys()]));
  }

  public hasAvailableCapture(): boolean {
    return this.getAvailableTabIds().length > 0;
  }

  // isAutoStop is true if stop was triggered by timeout, false if by user/explicit call
  async stopCapture(
    tabId: number,
    isAutoStop: boolean = false,
    stoppedBy = isAutoStop ? 'automatic' : 'user_request',
  ): Promise<any> {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) {
      this.pruneCompletedCaptures();
      const completed = this.completedCaptures.get(tabId);
      if (completed) {
        this.completedCaptures.delete(tabId);
        return completed.result;
      }
      return { success: false, message: 'No capture in progress for this tab.' };
    }

    console.log(
      `NetworkDebuggerStartTool: Stopping capture for tab ${tabId}. Auto-stop: ${isAutoStop}`,
    );

    try {
      // Attempt to disable network and detach via manager; it will no-op if others own the session
      try {
        await cdpSessionManager.sendCommand(tabId, 'Network.disable');
      } catch (e) {
        console.warn(
          `NetworkDebuggerStartTool: Error disabling network for tab ${tabId} (possibly already detached):`,
          e,
        );
      }
      try {
        await cdpSessionManager.detach(tabId, 'network-capture');
      } catch (e) {
        console.warn(
          `NetworkDebuggerStartTool: Error detaching debugger for tab ${tabId} (possibly already detached):`,
          e,
        );
      }
    } catch (error: any) {
      // Catch errors from getTargets or general logic
      console.error(
        'NetworkDebuggerStartTool: Error during debugger interaction in stopCapture:',
        error,
      );
      // Proceed to cleanup and data formatting
    }

    // Process data even if detach/disable failed, as some data might have been captured.
    const allRequests = Object.values(captureInfo.requests) as NetworkRequestInfo[];
    const commonRequestHeaders = this.analyzeCommonHeaders(allRequests, 'requestHeaders');
    const commonResponseHeaders = this.analyzeCommonHeaders(allRequests, 'responseHeaders');

    const processedRequests = allRequests.map((req) => {
      const finalReq: Partial<NetworkRequestInfo> &
        Pick<NetworkRequestInfo, 'requestId' | 'url' | 'method' | 'type' | 'status'> = { ...req };

      if (finalReq.requestHeaders) {
        finalReq.specificRequestHeaders = this.filterOutCommonHeaders(
          finalReq.requestHeaders,
          commonRequestHeaders,
        );
        delete finalReq.requestHeaders; // Remove original full headers
      } else {
        finalReq.specificRequestHeaders = {};
      }

      if (finalReq.responseHeaders) {
        finalReq.specificResponseHeaders = this.filterOutCommonHeaders(
          finalReq.responseHeaders,
          commonResponseHeaders,
        );
        delete finalReq.responseHeaders; // Remove original full headers
      } else {
        finalReq.specificResponseHeaders = {};
      }
      return finalReq as NetworkRequestInfo; // Cast back to full type
    });

    // Sort requests by requestTime
    processedRequests.sort((a, b) => (a.requestTime || 0) - (b.requestTime || 0));

    const resultData = boundCaptureResult({
      captureStartTime: captureInfo.startTime,
      captureEndTime: Date.now(),
      totalDurationMs: Math.max(0, Date.now() - captureInfo.startTime),
      commonRequestHeaders,
      commonResponseHeaders,
      requests: processedRequests,
      requestCount: processedRequests.length, // Actual stored requests
      totalRequestsReceivedBeforeLimit: captureInfo.limitReached
        ? NetworkDebuggerStartTool.MAX_REQUESTS_PER_CAPTURE
        : processedRequests.length,
      requestLimitReached: !!captureInfo.limitReached,
      byteLimitReached: !!captureInfo.byteLimitReached,
      stoppedBy,
      tabUrl: truncateUtf8(captureInfo.tabUrl, NETWORK_CAPTURE_LIMITS.maxUrlBytes),
      tabTitle: truncateUtf8(captureInfo.tabTitle, 1_024),
    });

    console.log(
      `NetworkDebuggerStartTool: Capture stopped for tab ${tabId}. ${resultData.requestCount} requests processed. Limit reached: ${resultData.requestLimitReached}. Stopped by: ${resultData.stoppedBy}`,
    );

    this.cleanupCapture(tabId); // Final cleanup of all internal states for this tab

    const result = {
      success: true,
      message: `Capture stopped. ${resultData.requestCount} requests.`,
      data: resultData,
    };
    if (isAutoStop) {
      this.cacheCompletedCapture(tabId, result);
    }
    return result;
  }

  private analyzeCommonHeaders(
    requests: NetworkRequestInfo[],
    headerTypeKey: 'requestHeaders' | 'responseHeaders',
  ): Record<string, string> {
    if (!requests || requests.length === 0) return {};

    const headerValueCounts = new Map<string, Map<string, number>>(); // headerName -> (headerValue -> count)
    let requestsWithHeadersCount = 0;

    for (const req of requests) {
      const headers = req[headerTypeKey] as Record<string, string> | undefined;
      if (headers && Object.keys(headers).length > 0) {
        requestsWithHeadersCount++;
        for (const name in headers) {
          // Normalize header name to lowercase for consistent counting
          const lowerName = name.toLowerCase();
          const value = headers[name];
          if (!headerValueCounts.has(lowerName)) {
            headerValueCounts.set(lowerName, new Map());
          }
          const values = headerValueCounts.get(lowerName)!;
          values.set(value, (values.get(value) || 0) + 1);
        }
      }
    }

    if (requestsWithHeadersCount === 0) return {};

    const commonHeaders: Record<string, string> = {};
    headerValueCounts.forEach((values, name) => {
      values.forEach((count, value) => {
        if (count === requestsWithHeadersCount) {
          // This (name, value) pair is present in all requests that have this type of headers.
          // We need to find the original casing for the header name.
          // This is tricky as HTTP headers are case-insensitive. Let's pick the first encountered one.
          // A more robust way would be to store original names, but lowercase comparison is standard.
          // For simplicity, we'll use the lowercase name for commonHeaders keys.
          // Or, find one original casing:
          let originalName = name;
          for (const req of requests) {
            const hdrs = req[headerTypeKey] as Record<string, string> | undefined;
            if (hdrs) {
              const foundName = Object.keys(hdrs).find((k) => k.toLowerCase() === name);
              if (foundName) {
                originalName = foundName;
                break;
              }
            }
          }
          commonHeaders[originalName] = value;
        }
      });
    });
    return commonHeaders;
  }

  private filterOutCommonHeaders(
    headers: Record<string, string>,
    commonHeaders: Record<string, string>,
  ): Record<string, string> {
    if (!headers || typeof headers !== 'object') return {};

    const specificHeaders: Record<string, string> = {};
    const commonHeadersLower: Record<string, string> = {};

    // Use Object.keys to avoid ESLint no-prototype-builtins warning
    Object.keys(commonHeaders).forEach((commonName) => {
      commonHeadersLower[commonName.toLowerCase()] = commonHeaders[commonName];
    });

    // Use Object.keys to avoid ESLint no-prototype-builtins warning
    Object.keys(headers).forEach((name) => {
      const lowerName = name.toLowerCase();
      // If the header (by name, case-insensitively) is not in commonHeaders OR
      // if its value is different from the common one, then it's specific.
      if (!(lowerName in commonHeadersLower) || headers[name] !== commonHeadersLower[lowerName]) {
        specificHeaders[name] = headers[name];
      }
    });

    return specificHeaders;
  }

  async execute(args: NetworkDebuggerStartToolParams): Promise<ToolResult> {
    const timings = normalizeCaptureTimings(args ?? {});
    const {
      url: targetUrl,
      includeStatic = false,
      tabId: targetTabId,
      windowId,
      background = false,
    } = args;
    const { maxCaptureTime, inactivityTimeout } = timings;
    if (targetUrl && utf8ByteLength(targetUrl) > NETWORK_CAPTURE_LIMITS.maxUrlBytes) {
      return createErrorResponse('Network capture URL is too long.');
    }

    console.log(
      `NetworkDebuggerStartTool: Executing with args: url=${truncateUtf8(targetUrl, 512)}, maxTime=${maxCaptureTime}, inactivityTime=${inactivityTimeout}, includeStatic=${includeStatic}`,
    );

    let tabToOperateOn: chrome.tabs.Tab | undefined;

    try {
      const explicitTab = await this.tryGetTab(targetTabId);
      if (targetUrl) {
        if (explicitTab?.id) {
          tabToOperateOn = await chrome.tabs.update(explicitTab.id, { url: targetUrl });
        } else {
          const existingTabs = await chrome.tabs.query({
            url: targetUrl.startsWith('http') ? targetUrl : `*://*/*${targetUrl}*`,
          }); // More specific query
          if (existingTabs.length > 0 && existingTabs[0]?.id) {
            tabToOperateOn = existingTabs[0];
          } else {
            tabToOperateOn = await chrome.tabs.create({
              url: targetUrl,
              active: background !== true,
              windowId,
            });
            // Wait for tab to be somewhat ready. A better way is to listen to tabs.onUpdated status='complete'
            // but for debugger attachment, it just needs the tabId.
            await new Promise((resolve) => setTimeout(resolve, 500)); // Short delay
          }
        }

        if (tabToOperateOn?.id && background !== true) {
          // Ensure window gets focus and tab is truly activated
          await chrome.windows.update(tabToOperateOn.windowId, { focused: true });
          await chrome.tabs.update(tabToOperateOn.id, { active: true });
        }
      } else if (explicitTab?.id) {
        tabToOperateOn = explicitTab;
      } else {
        const activeTabs =
          typeof windowId === 'number'
            ? await chrome.tabs.query({ active: true, windowId })
            : await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTabs.length > 0 && activeTabs[0]?.id) {
          tabToOperateOn = activeTabs[0];
        } else {
          return createErrorResponse('No active tab found and no URL provided.');
        }
      }

      if (!tabToOperateOn?.id) {
        return createErrorResponse('Failed to identify or create a target tab.');
      }
      const tabId = tabToOperateOn.id;

      // Use startCaptureForTab method to start capture
      try {
        await this.startCaptureForTab(tabId, {
          maxCaptureTime,
          inactivityTimeout,
          includeStatic,
          rootTabId: tabId,
          lineageDepth: 0,
          deadlineAt: Date.now() + maxCaptureTime,
        });
      } catch (error: any) {
        return createErrorResponse(
          `Failed to start capture for tab ${tabId}: ${error.message || String(error)}`,
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Network capture started on tab ${tabId}. Waiting for stop command or timeout.`,
              tabId,
              url: tabToOperateOn.url,
              maxCaptureTime,
              inactivityTimeout,
              includeStatic,
              maxRequests: NetworkDebuggerStartTool.MAX_REQUESTS_PER_CAPTURE,
            }),
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      console.error('NetworkDebuggerStartTool: Critical error during execute:', error);
      // If a tabId was involved and debugger might be attached, try to clean up.
      const tabIdToClean = tabToOperateOn?.id;
      if (tabIdToClean && this.captureData.has(tabIdToClean)) {
        await cdpSessionManager
          .detach(tabIdToClean, 'network-capture')
          .catch((e) => console.warn('Cleanup detach error:', e));
        this.cleanupCapture(tabIdToClean);
      }
      return createErrorResponse(
        `Error in NetworkDebuggerStartTool: ${error.message || String(error)}`,
      );
    }
  }
}

/**
 * Network capture stop tool - stops capture and returns results for the active tab
 */
class NetworkDebuggerStopTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP;
  public static instance: NetworkDebuggerStopTool | null = null;

  constructor() {
    super();
    if (NetworkDebuggerStopTool.instance) {
      return NetworkDebuggerStopTool.instance;
    }
    NetworkDebuggerStopTool.instance = this;
  }

  async execute(args: NetworkDebuggerStopToolParams = {}): Promise<ToolResult> {
    console.log(`NetworkDebuggerStopTool: Executing command.`);

    const startTool = NetworkDebuggerStartTool.instance;
    if (!startTool) {
      return createErrorResponse(
        'NetworkDebuggerStartTool instance not available. Cannot stop capture.',
      );
    }

    // Get all tabs currently capturing
    const ongoingCaptures = startTool.getAvailableTabIds();
    console.log(
      `NetworkDebuggerStopTool: Found ${ongoingCaptures.length} ongoing captures: ${ongoingCaptures.join(', ')}`,
    );

    if (ongoingCaptures.length === 0) {
      return createErrorResponse('No active network captures found in any tab.');
    }

    if (args.all === true) {
      const tabIds = [...ongoingCaptures];
      let primaryResult: ToolResult | null = null;
      for (const tabId of tabIds) {
        const result = await this.performStop(startTool, tabId);
        if (!primaryResult) {
          primaryResult = result;
        }
      }
      return primaryResult || createErrorResponse('No active network captures found in any tab.');
    }

    if (typeof args.tabId === 'number') {
      if (!ongoingCaptures.includes(args.tabId)) {
        return createErrorResponse(`No active network capture found for tab ${args.tabId}.`);
      }
      return await this.performStop(startTool, args.tabId);
    }

    // Get current active tab
    const activeTabs =
      typeof args.windowId === 'number'
        ? await chrome.tabs.query({ active: true, windowId: args.windowId })
        : await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTabId = activeTabs[0]?.id;

    // Determine the primary tab to stop
    let primaryTabId: number;

    if (activeTabId && ongoingCaptures.includes(activeTabId)) {
      // If current active tab is capturing, prioritize stopping it
      primaryTabId = activeTabId;
      console.log(
        `NetworkDebuggerStopTool: Active tab ${activeTabId} is capturing, will stop it first.`,
      );
    } else if (ongoingCaptures.length === 1) {
      // If only one tab is capturing, stop it
      primaryTabId = ongoingCaptures[0];
      console.log(
        `NetworkDebuggerStopTool: Only one tab ${primaryTabId} is capturing, stopping it.`,
      );
    } else {
      // If multiple tabs are capturing but current active tab is not among them, stop the first one
      primaryTabId = ongoingCaptures[0];
      console.log(
        `NetworkDebuggerStopTool: Multiple tabs capturing, active tab not among them. Stopping tab ${primaryTabId} first.`,
      );
    }

    // Stop capture for the primary tab
    const result = await this.performStop(startTool, primaryTabId);

    // If multiple tabs are capturing, stop other tabs
    if (ongoingCaptures.length > 1) {
      const otherTabIds = ongoingCaptures.filter((id) => id !== primaryTabId);
      console.log(
        `NetworkDebuggerStopTool: Stopping ${otherTabIds.length} additional captures: ${otherTabIds.join(', ')}`,
      );

      for (const tabId of otherTabIds) {
        try {
          await startTool.stopCapture(tabId);
        } catch (error) {
          console.error(`NetworkDebuggerStopTool: Error stopping capture on tab ${tabId}:`, error);
        }
      }
    }

    return result;
  }

  private async performStop(
    startTool: NetworkDebuggerStartTool,
    tabId: number,
  ): Promise<ToolResult> {
    console.log(`NetworkDebuggerStopTool: Attempting to stop capture for tab ${tabId}.`);
    const stopResult = await startTool.stopCapture(tabId);

    if (!stopResult?.success) {
      return createErrorResponse(
        stopResult?.message ||
          `Failed to stop network capture for tab ${tabId}. It might not have been capturing.`,
      );
    }

    const resultData = stopResult.data || {};

    // Get all tabs still capturing (there might be other tabs still capturing after stopping)
    const remainingCaptures = startTool.getAvailableTabIds();

    // Sort requests by time
    if (resultData.requests && Array.isArray(resultData.requests)) {
      resultData.requests.sort(
        (a: NetworkRequestInfo, b: NetworkRequestInfo) =>
          (a.requestTime || 0) - (b.requestTime || 0),
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `Capture for tab ${tabId} (${resultData.tabUrl || 'N/A'}) stopped. ${resultData.requestCount || 0} requests captured.`,
            tabId: tabId,
            tabUrl: resultData.tabUrl || 'N/A',
            tabTitle: resultData.tabTitle || 'Unknown Tab',
            requestCount: resultData.requestCount || 0,
            commonRequestHeaders: resultData.commonRequestHeaders || {},
            commonResponseHeaders: resultData.commonResponseHeaders || {},
            requests: resultData.requests || [],
            captureStartTime: resultData.captureStartTime,
            captureEndTime: resultData.captureEndTime,
            totalDurationMs: resultData.totalDurationMs,
            settingsUsed: resultData.settingsUsed || {},
            remainingCaptures: remainingCaptures,
            totalRequestsReceived: resultData.totalRequestsReceived || resultData.requestCount || 0,
            requestLimitReached: resultData.requestLimitReached || false,
            byteLimitReached: resultData.byteLimitReached || false,
            resultTruncated: resultData.resultTruncated || false,
            stoppedBy: resultData.stoppedBy || 'user_request',
          }),
        },
      ],
      isError: false,
    };
  }
}

export const networkDebuggerStartTool = new NetworkDebuggerStartTool();
export const networkDebuggerStopTool = new NetworkDebuggerStopTool();
