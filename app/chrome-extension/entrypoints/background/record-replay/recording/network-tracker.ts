interface RecordedRequest {
  url: string;
  method: string;
  status?: number;
  duration?: number;
  startedAt: number;
  completedAt: number;
}

interface ActiveRequestState {
  tabId: number;
  startedAt: number;
  url: string;
  method: string;
}

const MAX_RECENT_PER_TAB = 120;
const RECENT_WINDOW_MS = 15_000;
const MAX_ACTIVE_REQUESTS = 2_000;
const MAX_RECENT_TABS = 200;
const MAX_RECORDED_URL_LENGTH = 16_384;

interface RecordingNetworkTrackerOptions {
  maxActiveRequests?: number;
  maxRecentTabs?: number;
  maxRecordedUrlLength?: number;
}

export class RecordingNetworkTracker {
  private initialized = false;
  private enabled = false;
  private readonly activeByRequestId = new Map<string, ActiveRequestState>();
  private readonly recentByTabId = new Map<number, RecordedRequest[]>();

  private readonly maxActiveRequests: number;
  private readonly maxRecentTabs: number;
  private readonly maxRecordedUrlLength: number;

  constructor(options: RecordingNetworkTrackerOptions = {}) {
    this.maxActiveRequests = Math.max(
      1,
      Math.floor(options.maxActiveRequests ?? MAX_ACTIVE_REQUESTS),
    );
    this.maxRecentTabs = Math.max(1, Math.floor(options.maxRecentTabs ?? MAX_RECENT_TABS));
    this.maxRecordedUrlLength = Math.max(
      1,
      Math.floor(options.maxRecordedUrlLength ?? MAX_RECORDED_URL_LENGTH),
    );
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    chrome.webRequest.onBeforeRequest.addListener((details) => {
      if (!this.shouldTrack(details.tabId)) return;
      this.activeByRequestId.set(details.requestId, {
        tabId: details.tabId,
        startedAt: Date.now(),
        url: details.url.slice(0, this.maxRecordedUrlLength),
        method: details.method || 'GET',
      });
      this.enforceActiveCapacity();
    }, { urls: ['<all_urls>'] });

    chrome.webRequest.onCompleted.addListener((details) => {
      this.completeRequest(details.requestId, details.statusCode);
    }, { urls: ['<all_urls>'] });

    chrome.webRequest.onErrorOccurred.addListener((details) => {
      this.completeRequest(details.requestId, undefined);
    }, { urls: ['<all_urls>'] });

    chrome.tabs.onRemoved.addListener((tabId) => {
      this.clearTab(tabId);
    });
  }

  beginSession(): void {
    this.clear();
    this.enabled = true;
  }

  pauseSession(): void {
    this.enabled = false;
    this.clear();
  }

  resumeSession(): void {
    this.clear();
    this.enabled = true;
  }

  endSession(): void {
    this.enabled = false;
    this.clear();
  }

  takeRecent(tabId: number, maxAgeMs = 3500): RecordedRequest[] {
    if (typeof tabId !== 'number' || tabId < 0) return [];
    const list = this.recentByTabId.get(tabId);
    if (!list || list.length === 0) return [];

    const now = Date.now();
    const recent: RecordedRequest[] = [];
    const keep: RecordedRequest[] = [];

    for (const item of list) {
      const age = now - item.completedAt;
      if (age <= maxAgeMs) {
        recent.push(item);
      } else if (age <= RECENT_WINDOW_MS) {
        keep.push(item);
      }
    }

    if (keep.length > 0) {
      this.recentByTabId.set(tabId, keep);
    } else {
      this.recentByTabId.delete(tabId);
    }
    return recent;
  }

  private shouldTrack(tabId: number): boolean {
    return this.enabled && typeof tabId === 'number' && tabId >= 0;
  }

  private completeRequest(requestId: string, status?: number): void {
    const active = this.activeByRequestId.get(requestId);
    if (!active) return;
    this.activeByRequestId.delete(requestId);

    const completedAt = Date.now();
    const entry: RecordedRequest = {
      url: active.url,
      method: active.method,
      status,
      duration: Math.max(0, completedAt - active.startedAt),
      startedAt: active.startedAt,
      completedAt,
    };

    const list = this.recentByTabId.get(active.tabId) || [];
    list.push(entry);
    const trimmed = list
      .filter((item) => completedAt - item.completedAt <= RECENT_WINDOW_MS)
      .slice(-MAX_RECENT_PER_TAB);
    // Refresh insertion order so capacity eviction behaves like an LRU.
    this.recentByTabId.delete(active.tabId);
    this.recentByTabId.set(active.tabId, trimmed);
    this.enforceRecentTabCapacity();
  }

  private enforceActiveCapacity(): void {
    while (this.activeByRequestId.size > this.maxActiveRequests) {
      const oldestRequestId = this.activeByRequestId.keys().next().value;
      if (typeof oldestRequestId !== 'string') break;
      this.activeByRequestId.delete(oldestRequestId);
    }
  }

  private enforceRecentTabCapacity(): void {
    while (this.recentByTabId.size > this.maxRecentTabs) {
      const oldestTabId = this.recentByTabId.keys().next().value;
      if (typeof oldestTabId !== 'number') break;
      this.recentByTabId.delete(oldestTabId);
    }
  }

  private clearTab(tabId: number): void {
    this.recentByTabId.delete(tabId);
    for (const [requestId, active] of this.activeByRequestId) {
      if (active.tabId === tabId) {
        this.activeByRequestId.delete(requestId);
      }
    }
  }

  private clear(): void {
    this.activeByRequestId.clear();
    this.recentByTabId.clear();
  }
}

export const recordingNetworkTracker = new RecordingNetworkTracker();
export type { RecordedRequest };
