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

class RecordingNetworkTracker {
  private initialized = false;
  private readonly activeByRequestId = new Map<string, ActiveRequestState>();
  private readonly recentByTabId = new Map<number, RecordedRequest[]>();

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    chrome.webRequest.onBeforeRequest.addListener((details) => {
      if (!this.shouldTrack(details.tabId)) return;
      this.activeByRequestId.set(details.requestId, {
        tabId: details.tabId,
        startedAt: Date.now(),
        url: details.url,
        method: details.method || 'GET',
      });
    }, { urls: ['<all_urls>'] });

    chrome.webRequest.onCompleted.addListener((details) => {
      this.completeRequest(details.requestId, details.statusCode);
    }, { urls: ['<all_urls>'] });

    chrome.webRequest.onErrorOccurred.addListener((details) => {
      this.completeRequest(details.requestId, undefined);
    }, { urls: ['<all_urls>'] });
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
    return typeof tabId === 'number' && tabId >= 0;
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
    this.recentByTabId.set(active.tabId, trimmed);
  }
}

export const recordingNetworkTracker = new RecordingNetworkTracker();
export type { RecordedRequest };
