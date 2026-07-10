import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { LIMITS, NETWORK_FILTERS } from '@/common/constants';
import {
  NETWORK_CAPTURE_LIMITS,
  boundCaptureResult,
  jsonByteLength,
  normalizeCaptureTimings,
  normalizeEventTime,
  sanitizeWebRequestHeaders,
  serializeBoundedFormData,
  truncateUtf8,
  utf8ByteLength,
} from './network-capture-limits';

// Static resource file extensions
const STATIC_RESOURCE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.bmp', // Images
  '.css',
  '.scss',
  '.less', // Styles
  '.js',
  '.jsx',
  '.ts',
  '.tsx', // Scripts
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf', // Fonts
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.ogg',
  '.wav', // Media
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx', // Documents
];

// Ad and analytics domain list
const AD_ANALYTICS_DOMAINS = NETWORK_FILTERS.EXCLUDED_DOMAINS;

interface NetworkCaptureStartToolParams {
  url?: string; // URL to navigate to or focus. If not provided, uses active tab.
  maxCaptureTime?: number; // Maximum capture time (milliseconds)
  inactivityTimeout?: number; // Inactivity timeout (milliseconds)
  includeStatic?: boolean; // Whether to include static resources
  tabId?: number;
  windowId?: number;
  background?: boolean;
}

interface NetworkCaptureStopToolParams {
  tabId?: number;
  windowId?: number;
  all?: boolean;
}

interface NetworkRequestInfo {
  requestId: string;
  url: string;
  method: string;
  type: string;
  requestTime: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseTime?: number;
  status?: number;
  statusText?: string;
  responseSize?: number;
  responseType?: string;
  responseBody?: string;
  errorText?: string;
  specificRequestHeaders?: Record<string, string>;
  specificResponseHeaders?: Record<string, string>;
  mimeType?: string; // Response MIME type
}

interface CaptureInfo {
  tabId: number;
  tabUrl: string;
  tabTitle: string;
  startTime: number;
  endTime?: number;
  requests: Record<string, NetworkRequestInfo>;
  maxCaptureTime: number;
  inactivityTimeout: number;
  includeStatic: boolean;
  limitReached?: boolean; // Whether request count limit is reached
  byteLimitReached?: boolean;
  storedBytes: number;
  rootTabId: number;
  lineageDepth: number;
  deadlineAt: number;
}

interface CompletedCapture {
  expiresAt: number;
  result: { success: boolean; message?: string; data?: any };
}

interface NetworkCaptureListeners {
  onBeforeRequest?: (details: chrome.webRequest.WebRequestBodyDetails) => void;
  onSendHeaders?: (details: chrome.webRequest.WebRequestHeadersDetails) => void;
  onHeadersReceived?: (details: chrome.webRequest.WebResponseHeadersDetails) => void;
  onCompleted?: (details: chrome.webRequest.WebResponseCacheDetails) => void;
  onErrorOccurred?: (details: chrome.webRequest.WebResponseErrorDetails) => void;
}

/**
 * Network Capture Start Tool V2 - Uses Chrome webRequest API to start capturing network requests
 */
class NetworkCaptureStartTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_CAPTURE_START;
  public static instance: NetworkCaptureStartTool | null = null;
  public captureData: Map<number, CaptureInfo> = new Map(); // tabId -> capture data
  private captureTimers: Map<number, NodeJS.Timeout> = new Map(); // tabId -> max capture timer
  private inactivityTimers: Map<number, NodeJS.Timeout> = new Map(); // tabId -> inactivity timer
  private lastActivityTime: Map<number, number> = new Map(); // tabId -> timestamp of last activity
  private requestCounters: Map<number, number> = new Map(); // tabId -> count of captured requests
  private completedCaptures = new Map<number, CompletedCapture>();
  private pendingInheritedTabs = new Set<number>();
  public static MAX_REQUESTS_PER_CAPTURE = LIMITS.MAX_NETWORK_REQUESTS; // Maximum capture request count
  private listeners: NetworkCaptureListeners = {};

  // Static resource MIME types list (for filtering)
  private static STATIC_MIME_TYPES_TO_FILTER = [
    'image/', // All image types
    'font/', // All font types
    'audio/', // All audio types
    'video/', // All video types
    'text/css',
    'text/javascript',
    'application/javascript',
    'application/x-javascript',
    'application/pdf',
    'application/zip',
    'application/octet-stream', // Usually for downloads or generic binary data
  ];

  // API response MIME types list (these types are usually not filtered)
  private static API_MIME_TYPES = [
    'application/json',
    'application/xml',
    'text/xml',
    'application/x-www-form-urlencoded',
    'application/graphql',
    'application/grpc',
    'application/protobuf',
    'application/x-protobuf',
    'application/x-json',
    'application/ld+json',
    'application/problem+json',
    'application/problem+xml',
    'application/soap+xml',
    'application/vnd.api+json',
  ];

  constructor() {
    super();
    if (NetworkCaptureStartTool.instance) {
      return NetworkCaptureStartTool.instance;
    }
    NetworkCaptureStartTool.instance = this;

    // Listen for tab close events
    chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this));
    // Listen for tab creation events
    chrome.tabs.onCreated.addListener(this.handleTabCreated.bind(this));
  }

  /**
   * Handle tab close events
   */
  private handleTabRemoved(tabId: number) {
    if (this.captureData.has(tabId)) {
      console.log(`NetworkCaptureV2: Tab ${tabId} was closed, cleaning up resources.`);
      void this.stopCapture(tabId, true, 'tab_closed');
    }
  }

  /**
   * Handle tab creation events
   * If a new tab is opened from a tab being captured, automatically start capturing the new tab's requests
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
        `NetworkCaptureV2: New tab ${newTabId} created from capturing tab ${openerTabId}, will extend capture to it.`,
      );
      this.pendingInheritedTabs.add(newTabId);

      try {
        // Wait a short time to ensure the tab is ready
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

      console.log(`NetworkCaptureV2: Successfully extended capture to new tab ${newTabId}`);
    } catch (error) {
      console.error(`NetworkCaptureV2: Error extending capture to new tab:`, error);
    }
  }

  /**
   * Determine whether a request should be filtered (based on URL)
   * Uses full URL substring match to support patterns like 'facebook.com/tr'
   */
  private shouldFilterRequest(url: string, includeStatic: boolean): boolean {
    const normalizedUrl = String(url || '').toLowerCase();
    if (!normalizedUrl) return false;

    // Check if it's an ad or analytics domain (full URL substring match)
    if (AD_ANALYTICS_DOMAINS.some((pattern) => normalizedUrl.includes(pattern))) {
      return true;
    }

    // If not including static resources, check extensions
    if (!includeStatic) {
      try {
        const urlObj = new URL(url);
        const path = urlObj.pathname.toLowerCase();
        if (STATIC_RESOURCE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
          return true;
        }
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Filter based on MIME type
   */
  private shouldFilterByMimeType(mimeType: string, includeStatic: boolean): boolean {
    if (!mimeType) return false;

    // Always keep API response types
    if (NetworkCaptureStartTool.API_MIME_TYPES.some((type) => mimeType.startsWith(type))) {
      return false;
    }

    // If not including static resources, filter out static resource MIME types
    if (!includeStatic) {
      // Filter static resource MIME types
      if (
        NetworkCaptureStartTool.STATIC_MIME_TYPES_TO_FILTER.some((type) =>
          mimeType.startsWith(type),
        )
      ) {
        console.log(`NetworkCaptureV2: Filtering static resource by MIME type: ${mimeType}`);
        return true;
      }

      // Filter all MIME types starting with text/ (except those already in API_MIME_TYPES)
      if (mimeType.startsWith('text/')) {
        console.log(`NetworkCaptureV2: Filtering text response: ${mimeType}`);
        return true;
      }
    }

    return false;
  }

  /**
   * Update last activity time and reset inactivity timer
   */
  private updateLastActivityTime(tabId: number): void {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) return;

    this.lastActivityTime.set(tabId, Date.now());

    // Reset inactivity timer
    if (this.inactivityTimers.has(tabId)) {
      clearTimeout(this.inactivityTimers.get(tabId)!);
    }

    if (captureInfo.inactivityTimeout > 0) {
      this.inactivityTimers.set(
        tabId,
        setTimeout(() => this.checkInactivity(tabId), captureInfo.inactivityTimeout),
      );
    }
  }

  /**
   * Check for inactivity
   */
  private checkInactivity(tabId: number): void {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) return;

    const lastActivity = this.lastActivityTime.get(tabId) || captureInfo.startTime;
    const now = Date.now();
    const inactiveTime = now - lastActivity;

    if (inactiveTime >= captureInfo.inactivityTimeout) {
      console.log(
        `NetworkCaptureV2: No activity for ${inactiveTime}ms, stopping capture for tab ${tabId}`,
      );
      this.stopCaptureByInactivity(tabId);
    } else {
      // If inactivity time hasn't been reached yet, continue checking
      const remainingTime = captureInfo.inactivityTimeout - inactiveTime;
      this.inactivityTimers.set(
        tabId,
        setTimeout(() => this.checkInactivity(tabId), remainingTime),
      );
    }
  }

  /**
   * Stop capture due to inactivity
   */
  private async stopCaptureByInactivity(tabId: number): Promise<void> {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) return;

    console.log(`NetworkCaptureV2: Stopping capture due to inactivity for tab ${tabId}`);
    await this.stopCapture(tabId, true, 'inactivity_timeout');
  }

  /**
   * Clean up capture resources
   */
  private cleanupCapture(tabId: number): void {
    // Clear timers
    if (this.captureTimers.has(tabId)) {
      clearTimeout(this.captureTimers.get(tabId)!);
      this.captureTimers.delete(tabId);
    }

    if (this.inactivityTimers.has(tabId)) {
      clearTimeout(this.inactivityTimers.get(tabId)!);
      this.inactivityTimers.delete(tabId);
    }

    // Remove data
    this.lastActivityTime.delete(tabId);
    this.captureData.delete(tabId);
    this.requestCounters.delete(tabId);

    // Listener ownership is shared by all captures. Only the cleanup that
    // removes the final capture may release the global webRequest listeners.
    this.removeListeners();

    console.log(`NetworkCaptureV2: Cleaned up all resources for tab ${tabId}`);
  }

  private pruneCompletedCaptures(now = Date.now()): void {
    for (const [tabId, completed] of this.completedCaptures) {
      if (completed.expiresAt <= now) this.completedCaptures.delete(tabId);
    }
  }

  private cacheCompletedCapture(
    tabId: number,
    result: { success: boolean; message?: string; data?: any },
  ): void {
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

  /**
   * Set up request listeners (idempotent - won't add duplicate listeners)
   */
  private setupListeners(): void {
    // Skip if listeners are already set up
    if (this.listeners.onBeforeRequest) {
      return;
    }

    // Before request is sent
    this.listeners.onBeforeRequest = (details: chrome.webRequest.WebRequestBodyDetails) => {
      const captureInfo = this.captureData.get(details.tabId);
      if (!captureInfo) return;
      const boundedUrl = truncateUtf8(details.url, NETWORK_CAPTURE_LIMITS.maxUrlBytes);

      if (this.shouldFilterRequest(boundedUrl, captureInfo.includeStatic)) {
        return;
      }

      const currentCount = this.requestCounters.get(details.tabId) || 0;
      if (currentCount >= NetworkCaptureStartTool.MAX_REQUESTS_PER_CAPTURE) {
        console.log(
          `NetworkCaptureV2: Request limit (${NetworkCaptureStartTool.MAX_REQUESTS_PER_CAPTURE}) reached for tab ${details.tabId}, ignoring new request: ${truncateUtf8(boundedUrl, 512)}`,
        );
        captureInfo.limitReached = true;
        return;
      }

      this.requestCounters.set(details.tabId, currentCount + 1);
      this.updateLastActivityTime(details.tabId);

      if (!captureInfo.requests[details.requestId]) {
        const requestInfo: NetworkRequestInfo = {
          requestId: truncateUtf8(details.requestId, 256),
          url: boundedUrl,
          method: truncateUtf8(details.method, NETWORK_CAPTURE_LIMITS.maxMethodBytes),
          type: truncateUtf8(details.type, NETWORK_CAPTURE_LIMITS.maxTypeBytes),
          requestTime: normalizeEventTime(details.timeStamp) ?? Date.now(),
        };

        if (details.requestBody) {
          const requestBody = this.processRequestBody(details.requestBody);
          if (requestBody) {
            requestInfo.requestBody = requestBody;
          }
        }
        this.storeRequest(captureInfo, requestInfo, details.requestId);

        console.log(
          `NetworkCaptureV2: Captured request ${currentCount + 1}/${NetworkCaptureStartTool.MAX_REQUESTS_PER_CAPTURE} for tab ${details.tabId}: ${details.method} ${truncateUtf8(boundedUrl, 512)}`,
        );
      }
    };

    // Send request headers
    this.listeners.onSendHeaders = (details: chrome.webRequest.WebRequestHeadersDetails) => {
      const captureInfo = this.captureData.get(details.tabId);
      if (!captureInfo || !captureInfo.requests[details.requestId]) return;

      if (details.requestHeaders) {
        this.setRequestField(
          captureInfo,
          captureInfo.requests[details.requestId],
          'requestHeaders',
          sanitizeWebRequestHeaders(details.requestHeaders),
        );
      }
    };

    // Receive response headers
    this.listeners.onHeadersReceived = (details: chrome.webRequest.WebResponseHeadersDetails) => {
      const captureInfo = this.captureData.get(details.tabId);
      if (!captureInfo || !captureInfo.requests[details.requestId]) return;

      const requestInfo = captureInfo.requests[details.requestId];

      this.setRequestField(captureInfo, requestInfo, 'status', details.statusCode);
      this.setRequestField(
        captureInfo,
        requestInfo,
        'statusText',
        truncateUtf8(details.statusLine, NETWORK_CAPTURE_LIMITS.maxStatusTextBytes),
      );
      this.setRequestField(
        captureInfo,
        requestInfo,
        'responseTime',
        normalizeEventTime(details.timeStamp),
      );
      this.setRequestField(
        captureInfo,
        requestInfo,
        'mimeType',
        truncateUtf8(
          details.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value,
          NETWORK_CAPTURE_LIMITS.maxMimeTypeBytes,
        ),
      );

      // Secondary filtering based on MIME type
      if (
        requestInfo.mimeType &&
        this.shouldFilterByMimeType(requestInfo.mimeType, captureInfo.includeStatic)
      ) {
        delete captureInfo.requests[details.requestId];
        captureInfo.storedBytes = Math.max(
          0,
          captureInfo.storedBytes - jsonByteLength(requestInfo),
        );

        const currentCount = this.requestCounters.get(details.tabId) || 0;
        if (currentCount > 0) {
          this.requestCounters.set(details.tabId, currentCount - 1);
        }

        console.log(
          `NetworkCaptureV2: Filtered request by MIME type (${requestInfo.mimeType}): ${requestInfo.url}`,
        );
        return;
      }

      if (details.responseHeaders) {
        this.setRequestField(
          captureInfo,
          requestInfo,
          'responseHeaders',
          sanitizeWebRequestHeaders(details.responseHeaders),
        );
      }

      this.updateLastActivityTime(details.tabId);
    };

    // Request completed
    this.listeners.onCompleted = (details: chrome.webRequest.WebResponseCacheDetails) => {
      const captureInfo = this.captureData.get(details.tabId);
      if (!captureInfo || !captureInfo.requests[details.requestId]) return;

      const requestInfo = captureInfo.requests[details.requestId];
      if ('responseSize' in details) {
        const responseSize = details.fromCache
          ? 0
          : normalizeEventTime((details as any).responseSize);
        this.setRequestField(captureInfo, requestInfo, 'responseSize', responseSize);
      }

      this.updateLastActivityTime(details.tabId);
    };

    // Request failed
    this.listeners.onErrorOccurred = (details: chrome.webRequest.WebResponseErrorDetails) => {
      const captureInfo = this.captureData.get(details.tabId);
      if (!captureInfo || !captureInfo.requests[details.requestId]) return;

      const requestInfo = captureInfo.requests[details.requestId];
      this.setRequestField(
        captureInfo,
        requestInfo,
        'errorText',
        truncateUtf8(details.error, NETWORK_CAPTURE_LIMITS.maxErrorBytes),
      );

      this.updateLastActivityTime(details.tabId);
    };

    // Register all listeners
    chrome.webRequest.onBeforeRequest.addListener(
      this.listeners.onBeforeRequest,
      { urls: ['<all_urls>'] },
      ['requestBody'],
    );

    chrome.webRequest.onSendHeaders.addListener(
      this.listeners.onSendHeaders,
      { urls: ['<all_urls>'] },
      ['requestHeaders'],
    );

    chrome.webRequest.onHeadersReceived.addListener(
      this.listeners.onHeadersReceived,
      { urls: ['<all_urls>'] },
      ['responseHeaders'],
    );

    chrome.webRequest.onCompleted.addListener(this.listeners.onCompleted, { urls: ['<all_urls>'] });

    chrome.webRequest.onErrorOccurred.addListener(this.listeners.onErrorOccurred, {
      urls: ['<all_urls>'],
    });
  }

  /**
   * Remove all request listeners
   * Only remove listeners when all tab captures have stopped
   */
  private removeListeners(): void {
    // Don't remove listeners if there are still tabs being captured
    if (this.captureData.size > 0) {
      console.log(
        `NetworkCaptureV2: Still capturing on ${this.captureData.size} tabs, not removing listeners.`,
      );
      return;
    }

    console.log(`NetworkCaptureV2: No more active captures, removing all listeners.`);

    if (this.listeners.onBeforeRequest) {
      chrome.webRequest.onBeforeRequest.removeListener(this.listeners.onBeforeRequest);
    }

    if (this.listeners.onSendHeaders) {
      chrome.webRequest.onSendHeaders.removeListener(this.listeners.onSendHeaders);
    }

    if (this.listeners.onHeadersReceived) {
      chrome.webRequest.onHeadersReceived.removeListener(this.listeners.onHeadersReceived);
    }

    if (this.listeners.onCompleted) {
      chrome.webRequest.onCompleted.removeListener(this.listeners.onCompleted);
    }

    if (this.listeners.onErrorOccurred) {
      chrome.webRequest.onErrorOccurred.removeListener(this.listeners.onErrorOccurred);
    }

    // Clear listener object
    this.listeners = {};
  }

  /**
   * Process request body data
   */
  private processRequestBody(requestBody: chrome.webRequest.WebRequestBody): string | undefined {
    if (requestBody.raw && requestBody.raw.length > 0) {
      return '[Binary data]';
    } else if (requestBody.formData) {
      return serializeBoundedFormData(requestBody.formData);
    }
    return undefined;
  }

  private storeRequest(
    captureInfo: CaptureInfo,
    request: NetworkRequestInfo,
    storageKey = request.requestId,
  ): boolean {
    const bytes = jsonByteLength(request);
    if (captureInfo.storedBytes + bytes > NETWORK_CAPTURE_LIMITS.maxCaptureBytes) {
      captureInfo.byteLimitReached = true;
      return false;
    }
    captureInfo.requests[storageKey] = request;
    captureInfo.storedBytes += bytes;
    return true;
  }

  private setRequestField<K extends keyof NetworkRequestInfo>(
    captureInfo: CaptureInfo,
    requestInfo: NetworkRequestInfo,
    field: K,
    value: NetworkRequestInfo[K],
  ): boolean {
    const previousBytes =
      requestInfo[field] === undefined ? 0 : jsonByteLength({ [field]: requestInfo[field] });
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
        `NetworkCaptureV2: Already capturing on tab ${tabId}. Stopping previous session.`,
      );
      await this.stopCapture(tabId);
    }

    try {
      // Get tab information
      const tab = await chrome.tabs.get(tabId);
      this.completedCaptures.delete(tabId);

      // Initialize capture data
      this.captureData.set(tabId, {
        tabId: tabId,
        tabUrl: truncateUtf8(tab.url, NETWORK_CAPTURE_LIMITS.maxUrlBytes),
        tabTitle: truncateUtf8(tab.title, 1_024),
        startTime: Date.now(),
        requests: {},
        maxCaptureTime,
        inactivityTimeout,
        includeStatic,
        limitReached: false,
        byteLimitReached: false,
        storedBytes: 0,
        rootTabId: options.rootTabId ?? tabId,
        lineageDepth: options.lineageDepth ?? 0,
        deadlineAt,
      });

      // Initialize request counter
      this.requestCounters.set(tabId, 0);

      // Set up listeners
      this.setupListeners();

      // Update last activity time
      this.updateLastActivityTime(tabId);

      console.log(
        `NetworkCaptureV2: Started capture for tab ${tabId} (${truncateUtf8(tab.url, 512)}). Max requests: ${NetworkCaptureStartTool.MAX_REQUESTS_PER_CAPTURE}, Max time: ${maxCaptureTime}ms, Inactivity: ${inactivityTimeout}ms.`,
      );

      // Set maximum capture time
      if (maxCaptureTime > 0) {
        this.captureTimers.set(
          tabId,
          setTimeout(async () => {
            console.log(
              `NetworkCaptureV2: Max capture time (${maxCaptureTime}ms) reached for tab ${tabId}.`,
            );
            await this.stopCapture(tabId, true, 'max_capture_time');
          }, maxCaptureTime),
        );
      }
    } catch (error: any) {
      console.error(`NetworkCaptureV2: Error starting capture for tab ${tabId}:`, error);

      // Clean up resources
      if (this.captureData.has(tabId)) {
        this.cleanupCapture(tabId);
      }

      throw error;
    }
  }

  /**
   * Stop capture
   * @param tabId Tab ID
   */
  public async stopCapture(
    tabId: number,
    isAutoStop = false,
    stoppedBy = isAutoStop ? 'automatic' : 'user_request',
  ): Promise<{ success: boolean; message?: string; data?: any }> {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) {
      this.pruneCompletedCaptures();
      const completed = this.completedCaptures.get(tabId);
      if (completed) {
        this.completedCaptures.delete(tabId);
        return completed.result;
      }
      console.log(`NetworkCaptureV2: No capture in progress for tab ${tabId}`);
      return { success: false, message: `No capture in progress for tab ${tabId}` };
    }

    try {
      // Record end time
      captureInfo.endTime = Date.now();

      // Extract common request and response headers
      const requestsArray = Object.values(captureInfo.requests ?? {});
      const commonRequestHeaders = this.analyzeCommonHeaders(requestsArray, 'requestHeaders');
      const commonResponseHeaders = this.analyzeCommonHeaders(requestsArray, 'responseHeaders');

      // Process request data, remove common headers
      const processedRequests = requestsArray.map((req) => {
        const finalReq: NetworkRequestInfo = { ...req };

        if (finalReq.requestHeaders) {
          finalReq.specificRequestHeaders = this.filterOutCommonHeaders(
            finalReq.requestHeaders,
            commonRequestHeaders,
          );
          delete finalReq.requestHeaders;
        } else {
          finalReq.specificRequestHeaders = {};
        }

        if (finalReq.responseHeaders) {
          finalReq.specificResponseHeaders = this.filterOutCommonHeaders(
            finalReq.responseHeaders,
            commonResponseHeaders,
          );
          delete finalReq.responseHeaders;
        } else {
          finalReq.specificResponseHeaders = {};
        }

        return finalReq;
      });

      // Sort by time
      processedRequests.sort((a, b) => (a.requestTime || 0) - (b.requestTime || 0));

      // Prepare result data
      const resultData = boundCaptureResult({
        captureStartTime: captureInfo.startTime,
        captureEndTime: captureInfo.endTime,
        totalDurationMs: Math.max(0, captureInfo.endTime - captureInfo.startTime),
        settingsUsed: {
          maxCaptureTime: captureInfo.maxCaptureTime,
          inactivityTimeout: captureInfo.inactivityTimeout,
          includeStatic: captureInfo.includeStatic,
          maxRequests: NetworkCaptureStartTool.MAX_REQUESTS_PER_CAPTURE,
        },
        commonRequestHeaders,
        commonResponseHeaders,
        requests: processedRequests,
        requestCount: processedRequests.length,
        totalRequestsReceived: this.requestCounters.get(tabId) || 0,
        requestLimitReached: captureInfo.limitReached || false,
        byteLimitReached: captureInfo.byteLimitReached || false,
        stoppedBy,
        tabUrl: truncateUtf8(captureInfo.tabUrl, NETWORK_CAPTURE_LIMITS.maxUrlBytes),
        tabTitle: truncateUtf8(captureInfo.tabTitle, 1_024),
      });

      // Clean up resources
      this.cleanupCapture(tabId);

      const result = {
        success: true,
        data: resultData,
      };
      if (isAutoStop) {
        this.cacheCompletedCapture(tabId, result);
      }
      return result;
    } catch (error: any) {
      console.error(`NetworkCaptureV2: Error stopping capture for tab ${tabId}:`, error);

      // Ensure resources are cleaned up
      this.cleanupCapture(tabId);

      return {
        success: false,
        message: `Error stopping capture: ${error.message || String(error)}`,
      };
    }
  }

  /**
   * Analyze common request or response headers
   */
  private analyzeCommonHeaders(
    requests: NetworkRequestInfo[],
    headerType: 'requestHeaders' | 'responseHeaders',
  ): Record<string, string> {
    if (!requests || requests.length === 0) return {};

    // Find headers that are included in all requests
    const commonHeaders: Record<string, string> = {};
    const firstRequestWithHeaders = requests.find(
      (req) => req[headerType] && Object.keys(req[headerType] || {}).length > 0,
    );

    if (!firstRequestWithHeaders || !firstRequestWithHeaders[headerType]) {
      return {};
    }

    // Get all headers from the first request
    const headers = firstRequestWithHeaders[headerType] as Record<string, string>;
    const headerNames = Object.keys(headers);

    // Check if each header exists in all requests with the same value
    for (const name of headerNames) {
      const value = headers[name];
      const isCommon = requests.every((req) => {
        const reqHeaders = req[headerType] as Record<string, string>;
        return reqHeaders && reqHeaders[name] === value;
      });

      if (isCommon) {
        commonHeaders[name] = value;
      }
    }

    return commonHeaders;
  }

  /**
   * Filter out common headers
   */
  private filterOutCommonHeaders(
    headers: Record<string, string>,
    commonHeaders: Record<string, string>,
  ): Record<string, string> {
    if (!headers || typeof headers !== 'object') return {};

    const specificHeaders: Record<string, string> = {};
    // Use Object.keys to avoid ESLint no-prototype-builtins warning
    Object.keys(headers).forEach((name) => {
      if (!(name in commonHeaders) || headers[name] !== commonHeaders[name]) {
        specificHeaders[name] = headers[name];
      }
    });

    return specificHeaders;
  }

  async execute(args: NetworkCaptureStartToolParams): Promise<ToolResult> {
    const timings = normalizeCaptureTimings(args ?? {});
    const {
      url: targetUrl,
      includeStatic = false, // Default: don't include static resources
      tabId: targetTabId,
      windowId,
      background = false,
    } = args;
    const { maxCaptureTime, inactivityTimeout } = timings;

    if (targetUrl && utf8ByteLength(targetUrl) > NETWORK_CAPTURE_LIMITS.maxUrlBytes) {
      return createErrorResponse('Network capture URL is too long.');
    }


    try {
      const explicitTab = await this.tryGetTab(targetTabId);
      // Get current tab or create new tab
      let tabToOperateOn: chrome.tabs.Tab;

      if (targetUrl) {
        if (explicitTab?.id) {
          const updatedTab = await chrome.tabs.update(explicitTab.id, { url: targetUrl });
          if (!updatedTab) {
            return createErrorResponse(`Failed to update target tab ${explicitTab.id}`);
          }
          tabToOperateOn = updatedTab;
        } else {
          // Find tabs matching the URL
          const matchingTabs = await chrome.tabs.query({ url: targetUrl });

          if (matchingTabs.length > 0 && matchingTabs[0]) {
            // Use existing tab
            tabToOperateOn = matchingTabs[0];
            console.log(`NetworkCaptureV2: Found existing tab with URL: ${truncateUtf8(targetUrl, 512)}`);
          } else {
            // Create new tab
            console.log(`NetworkCaptureV2: Creating new tab with URL: ${truncateUtf8(targetUrl, 512)}`);
            tabToOperateOn = await chrome.tabs.create({
              url: targetUrl,
              active: background !== true,
              windowId,
            });

            // Wait for page to load
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }

        if (tabToOperateOn.id && background !== true) {
          await chrome.tabs.update(tabToOperateOn.id, { active: true });
          await chrome.windows.update(tabToOperateOn.windowId, { focused: true });
        }
      } else if (explicitTab?.id) {
        tabToOperateOn = explicitTab;
      } else {
        // Use current active tab
        const tabs =
          typeof windowId === 'number'
            ? await chrome.tabs.query({ active: true, windowId })
            : await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) {
          return createErrorResponse('No active tab found');
        }
        tabToOperateOn = tabs[0];
      }

      if (!tabToOperateOn?.id) {
        return createErrorResponse('Failed to identify or create a tab');
      }

      // Use startCaptureForTab method to start capture
      try {
        await this.startCaptureForTab(tabToOperateOn.id, {
          maxCaptureTime,
          inactivityTimeout,
          includeStatic,
          rootTabId: tabToOperateOn.id,
          lineageDepth: 0,
          deadlineAt: Date.now() + maxCaptureTime,
        });
      } catch (error: any) {
        return createErrorResponse(
          `Failed to start capture for tab ${tabToOperateOn.id}: ${error.message || String(error)}`,
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Network capture V2 started successfully, waiting for stop command.',
              tabId: tabToOperateOn.id,
              url: tabToOperateOn.url,
              maxCaptureTime,
              inactivityTimeout,
              includeStatic,
              maxRequests: NetworkCaptureStartTool.MAX_REQUESTS_PER_CAPTURE,
            }),
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      console.error('NetworkCaptureStartTool: Critical error:', error);
      return createErrorResponse(
        `Error in NetworkCaptureStartTool: ${error.message || String(error)}`,
      );
    }
  }
}

/**
 * Network capture stop tool V2 - Stop webRequest API capture and return results
 */
class NetworkCaptureStopTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_CAPTURE_STOP;
  public static instance: NetworkCaptureStopTool | null = null;

  constructor() {
    super();
    if (NetworkCaptureStopTool.instance) {
      return NetworkCaptureStopTool.instance;
    }
    NetworkCaptureStopTool.instance = this;
  }

  async execute(args: NetworkCaptureStopToolParams = {}): Promise<ToolResult> {
    console.log(`NetworkCaptureStopTool: Executing`);

    try {
      const startTool = NetworkCaptureStartTool.instance;

      if (!startTool) {
        return createErrorResponse('Network capture V2 start tool instance not found');
      }

      // Get all tabs currently capturing
      const ongoingCaptures = startTool.getAvailableTabIds();
      console.log(
        `NetworkCaptureStopTool: Found ${ongoingCaptures.length} ongoing captures: ${ongoingCaptures.join(', ')}`,
      );

      if (ongoingCaptures.length === 0) {
        return createErrorResponse('No active network captures found in any tab.');
      }

      if (args.all === true) {
        const tabIds = [...ongoingCaptures];
        let primaryStopResult: Awaited<ReturnType<NetworkCaptureStartTool['stopCapture']>> | null = null;
        for (const tabId of tabIds) {
          const stopResult = await startTool.stopCapture(tabId);
          if (!primaryStopResult) {
            primaryStopResult = stopResult;
          }
        }
        if (!primaryStopResult?.success) {
          return createErrorResponse('Failed to stop network captures');
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Stopped all active network captures.',
                stoppedTabIds: tabIds,
                remainingCaptures: startTool.getAvailableTabIds(),
              }),
            },
          ],
          isError: false,
        };
      }

      if (typeof args.tabId === 'number') {
        if (!ongoingCaptures.includes(args.tabId)) {
          return createErrorResponse(`No active network capture found for tab ${args.tabId}.`);
        }
        const targetedStop = await startTool.stopCapture(args.tabId);
        if (!targetedStop.success) {
          return createErrorResponse(
            targetedStop.message || `Failed to stop network capture for tab ${args.tabId}`,
          );
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Capture complete. ${targetedStop.data?.requestCount || 0} requests captured.`,
                tabId: args.tabId,
                tabUrl: targetedStop.data?.tabUrl || 'N/A',
                tabTitle: targetedStop.data?.tabTitle || 'Unknown Tab',
                requestCount: targetedStop.data?.requestCount || 0,
                commonRequestHeaders: targetedStop.data?.commonRequestHeaders || {},
                commonResponseHeaders: targetedStop.data?.commonResponseHeaders || {},
                requests: targetedStop.data?.requests || [],
                captureStartTime: targetedStop.data?.captureStartTime,
                captureEndTime: targetedStop.data?.captureEndTime,
                totalDurationMs: targetedStop.data?.totalDurationMs,
                settingsUsed: targetedStop.data?.settingsUsed || {},
                totalRequestsReceived: targetedStop.data?.totalRequestsReceived || 0,
                requestLimitReached: targetedStop.data?.requestLimitReached || false,
                byteLimitReached: targetedStop.data?.byteLimitReached || false,
                resultTruncated: targetedStop.data?.resultTruncated || false,
                stoppedBy: targetedStop.data?.stoppedBy || 'user_request',
                remainingCaptures: startTool.getAvailableTabIds(),
              }),
            },
          ],
          isError: false,
        };
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
          `NetworkCaptureStopTool: Active tab ${activeTabId} is capturing, will stop it first.`,
        );
      } else if (ongoingCaptures.length === 1) {
        // If only one tab is capturing, stop it
        primaryTabId = ongoingCaptures[0];
        console.log(
          `NetworkCaptureStopTool: Only one tab ${primaryTabId} is capturing, stopping it.`,
        );
      } else {
        // If multiple tabs are capturing but current active tab is not among them, stop the first one
        primaryTabId = ongoingCaptures[0];
        console.log(
          `NetworkCaptureStopTool: Multiple tabs capturing, active tab not among them. Stopping tab ${primaryTabId} first.`,
        );
      }

      const stopResult = await startTool.stopCapture(primaryTabId);

      if (!stopResult.success) {
        return createErrorResponse(
          stopResult.message || `Failed to stop network capture for tab ${primaryTabId}`,
        );
      }

      // If multiple tabs are capturing, stop other tabs
      if (ongoingCaptures.length > 1) {
        const otherTabIds = ongoingCaptures.filter((id) => id !== primaryTabId);
        console.log(
          `NetworkCaptureStopTool: Stopping ${otherTabIds.length} additional captures: ${otherTabIds.join(', ')}`,
        );

        for (const tabId of otherTabIds) {
          try {
            await startTool.stopCapture(tabId);
          } catch (error) {
            console.error(`NetworkCaptureStopTool: Error stopping capture on tab ${tabId}:`, error);
          }
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Capture complete. ${stopResult.data?.requestCount || 0} requests captured.`,
              tabId: primaryTabId,
              tabUrl: stopResult.data?.tabUrl || 'N/A',
              tabTitle: stopResult.data?.tabTitle || 'Unknown Tab',
              requestCount: stopResult.data?.requestCount || 0,
              commonRequestHeaders: stopResult.data?.commonRequestHeaders || {},
              commonResponseHeaders: stopResult.data?.commonResponseHeaders || {},
              requests: stopResult.data?.requests || [],
              captureStartTime: stopResult.data?.captureStartTime,
              captureEndTime: stopResult.data?.captureEndTime,
              totalDurationMs: stopResult.data?.totalDurationMs,
              settingsUsed: stopResult.data?.settingsUsed || {},
              totalRequestsReceived: stopResult.data?.totalRequestsReceived || 0,
              requestLimitReached: stopResult.data?.requestLimitReached || false,
              byteLimitReached: stopResult.data?.byteLimitReached || false,
              resultTruncated: stopResult.data?.resultTruncated || false,
              stoppedBy: stopResult.data?.stoppedBy || 'user_request',
              remainingCaptures: startTool.getAvailableTabIds(),
            }),
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      console.error('NetworkCaptureStopTool: Critical error:', error);
      return createErrorResponse(
        `Error in NetworkCaptureStopTool: ${error.message || String(error)}`,
      );
    }
  }
}

export const networkCaptureStartTool = new NetworkCaptureStartTool();
export const networkCaptureStopTool = new NetworkCaptureStopTool();
