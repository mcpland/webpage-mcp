import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordingNetworkTracker } from '@/entrypoints/background/record-replay/recording/network-tracker';

type Listener<T> = (details: T) => void;

function createChromeEvent<T>() {
  const listeners: Array<Listener<T>> = [];
  return {
    api: {
      addListener: vi.fn((listener: Listener<T>) => {
        listeners.push(listener);
      }),
      removeListener: vi.fn(),
    },
    emit(details: T): void {
      for (const listener of listeners) listener(details);
    },
  };
}

describe('RecordingNetworkTracker', () => {
  const originalWebRequest = chrome.webRequest;
  const originalTabsOnRemoved = chrome.tabs.onRemoved;

  let beforeRequest: ReturnType<
    typeof createChromeEvent<{
      requestId: string;
      tabId: number;
      url: string;
      method: string;
    }>
  >;
  let completed: ReturnType<
    typeof createChromeEvent<{ requestId: string; statusCode: number }>
  >;
  let failed: ReturnType<typeof createChromeEvent<{ requestId: string }>>;
  let tabRemoved: ReturnType<typeof createChromeEvent<number>>;

  beforeEach(() => {
    beforeRequest = createChromeEvent();
    completed = createChromeEvent();
    failed = createChromeEvent();
    tabRemoved = createChromeEvent();

    chrome.webRequest = {
      onBeforeRequest: beforeRequest.api,
      onCompleted: completed.api,
      onErrorOccurred: failed.api,
    } as unknown as typeof chrome.webRequest;
    chrome.tabs.onRemoved = tabRemoved.api as unknown as typeof chrome.tabs.onRemoved;
  });

  afterEach(() => {
    chrome.webRequest = originalWebRequest;
    chrome.tabs.onRemoved = originalTabsOnRemoved;
  });

  it('collects only during an active recording and clears across lifecycle changes', () => {
    const tracker = new RecordingNetworkTracker({ maxRecordedUrlLength: 8 });
    tracker.init();

    beforeRequest.emit({
      requestId: 'inactive',
      tabId: 1,
      url: 'https://ignored.example',
      method: 'GET',
    });
    completed.emit({ requestId: 'inactive', statusCode: 200 });
    expect(tracker.takeRecent(1)).toEqual([]);

    tracker.beginSession();
    beforeRequest.emit({
      requestId: 'active',
      tabId: 1,
      url: 'https://example.test/very-long-path',
      method: 'POST',
    });
    completed.emit({ requestId: 'active', statusCode: 201 });

    expect(tracker.takeRecent(1)).toEqual([
      expect.objectContaining({
        url: 'https://',
        method: 'POST',
        status: 201,
      }),
    ]);

    tracker.pauseSession();
    beforeRequest.emit({
      requestId: 'paused',
      tabId: 1,
      url: 'https://paused.example',
      method: 'GET',
    });
    completed.emit({ requestId: 'paused', statusCode: 200 });
    expect(tracker.takeRecent(1)).toEqual([]);

    tracker.resumeSession();
    beforeRequest.emit({
      requestId: 'resumed',
      tabId: 1,
      url: 'https://resumed.example',
      method: 'GET',
    });
    tracker.endSession();
    completed.emit({ requestId: 'resumed', statusCode: 200 });
    expect(tracker.takeRecent(1)).toEqual([]);
  });

  it('evicts oldest in-flight requests when the active-request budget is exceeded', () => {
    const tracker = new RecordingNetworkTracker({ maxActiveRequests: 2 });
    tracker.init();
    tracker.beginSession();

    for (const requestId of ['first', 'second', 'third']) {
      beforeRequest.emit({
        requestId,
        tabId: 7,
        url: `https://example.test/${requestId}`,
        method: 'GET',
      });
    }

    completed.emit({ requestId: 'first', statusCode: 200 });
    expect(tracker.takeRecent(7)).toEqual([]);

    completed.emit({ requestId: 'second', statusCode: 200 });
    completed.emit({ requestId: 'third', statusCode: 204 });
    expect(tracker.takeRecent(7)).toHaveLength(2);
  });

  it('bounds recent tabs and releases pending and completed data when a tab closes', () => {
    const tracker = new RecordingNetworkTracker({ maxRecentTabs: 2 });
    tracker.init();
    tracker.beginSession();

    for (const tabId of [1, 2, 3]) {
      const requestId = `tab-${tabId}`;
      beforeRequest.emit({
        requestId,
        tabId,
        url: `https://example.test/${tabId}`,
        method: 'GET',
      });
      completed.emit({ requestId, statusCode: 200 });
    }

    expect(tracker.takeRecent(1)).toEqual([]);
    expect(tracker.takeRecent(2)).toHaveLength(1);

    beforeRequest.emit({
      requestId: 'pending-tab-3',
      tabId: 3,
      url: 'https://example.test/pending',
      method: 'GET',
    });
    tabRemoved.emit(3);
    completed.emit({ requestId: 'pending-tab-3', statusCode: 200 });
    expect(tracker.takeRecent(3)).toEqual([]);
  });
});
