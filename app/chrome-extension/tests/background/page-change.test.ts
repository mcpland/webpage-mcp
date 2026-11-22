import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  observePageChanges,
  pageChangeSettleMs,
  PAGE_CHANGE_LOAD_WAIT_MS,
  PAGE_CHANGE_SETTLE_MS,
  withPageChange,
} from '@/entrypoints/background/tools/page-change';

type Listener = (...args: any[]) => void;

const okResult = (payload: Record<string, unknown> = { success: true }) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  isError: false,
});

describe('page change summary', () => {
  let tabs: Map<number, Partial<chrome.tabs.Tab>>;
  let created: Listener[];
  let updated: Listener[];

  beforeEach(() => {
    tabs = new Map([[7, { id: 7, url: 'https://example.com/login', title: 'Login', status: 'complete' }]]);
    created = [];
    updated = [];
    vi.mocked(chrome.tabs.get).mockImplementation(async (id: number) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      return { ...tab } as chrome.tabs.Tab;
    });
    vi.mocked(chrome.tabs.onCreated.addListener).mockImplementation((l: Listener) => created.push(l));
    vi.mocked(chrome.tabs.onCreated.removeListener).mockImplementation((l: Listener) => {
      created = created.filter((x) => x !== l);
    });
    vi.mocked(chrome.tabs.onUpdated.addListener).mockImplementation((l: Listener) => updated.push(l));
    vi.mocked(chrome.tabs.onUpdated.removeListener).mockImplementation((l: Listener) => {
      updated = updated.filter((x) => x !== l);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const navigate = (url: string, title: string, status = 'complete') => {
    tabs.set(7, { id: 7, url, title, status });
    for (const l of updated) l(7, { status: 'loading', url });
  };

  it('settles only after actions that can navigate or open tabs', () => {
    expect(pageChangeSettleMs('chrome_click_element', {})).toBe(PAGE_CHANGE_SETTLE_MS);
    expect(pageChangeSettleMs('chrome_keyboard', { keys: 'Enter' })).toBe(PAGE_CHANGE_SETTLE_MS);
    expect(pageChangeSettleMs('chrome_fill_or_select', { value: 'x' })).toBe(0);
    expect(pageChangeSettleMs('chrome_fill_or_select', { value: 'x', submit: true })).toBe(
      PAGE_CHANGE_SETTLE_MS,
    );
    expect(pageChangeSettleMs('chrome_computer', { action: 'left_click' })).toBe(PAGE_CHANGE_SETTLE_MS);
    expect(pageChangeSettleMs('chrome_computer', { action: 'type' })).toBe(0);
    expect(pageChangeSettleMs('chrome_computer', { action: 'screenshot' })).toBeUndefined();
    expect(pageChangeSettleMs('chrome_read_page', {})).toBeUndefined();
  });

  it('reports a navigation with the new page once it has loaded', async () => {
    const observer = (await observePageChanges(7, 0))!;
    navigate('https://example.com/home', '', 'loading');
    setTimeout(() => tabs.set(7, { id: 7, url: 'https://example.com/home', title: 'Home', status: 'complete' }), 50);

    const summary = await observer.finish(okResult());

    expect(summary).toEqual({ navigated: true, url: 'https://example.com/home', title: 'Home' });
    expect(updated).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it('reports tabs the action opened, without non-public URLs', async () => {
    const observer = (await observePageChanges(7, 0))!;
    tabs.set(21, { id: 21, url: 'https://docs.example.com/', title: 'Docs', openerTabId: 7 });
    tabs.set(22, { id: 22, url: 'chrome://settings/', title: 'Settings', openerTabId: 7 });
    tabs.set(23, { id: 23, url: 'https://other.example/', openerTabId: 99 });
    for (const id of [21, 22, 23]) for (const l of created) l(tabs.get(id));

    const summary = await observer.finish(okResult());

    expect(summary).toEqual({
      newTabs: [{ tabId: 21, url: 'https://docs.example.com/', title: 'Docs' }, { tabId: 22 }],
    });
  });

  it('ignores a pending resource that was already loading before the action', async () => {
    tabs.set(7, { id: 7, url: 'https://example.com/', status: 'loading' });
    const observer = (await observePageChanges(7, 0))!;
    expect(await observer.finish(okResult())).toBeUndefined();
  });

  it.each(['commit', 'error'])('follows a new main-frame reload on a loading page until %s', async (outcome) => {
    vi.useFakeTimers();
    const original = chrome.webNavigation;
    const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
    const events = { onBeforeNavigate: event(), onCommitted: event(), onErrorOccurred: event() };
    Object.assign(chrome, { webNavigation: events });
    try {
      const tab = { id: 7, url: 'https://example.com/', title: 'Old', status: 'loading' as const };
      tabs.set(7, tab);
      const observer = (await observePageChanges(7, 0))!;
      const details = { tabId: 7, frameId: 0, url: tab.url };
      events.onBeforeNavigate.addListener.mock.calls[0]?.[0](details);
      // The old document can finish before the replacement commits.
      tabs.set(7, { ...tab, status: 'complete' });
      const pending = observer.finish(okResult());
      setTimeout(() => {
        if (outcome === 'commit') {
          tabs.set(7, { ...tab, status: 'complete', title: 'Reloaded' });
          events.onCommitted.addListener.mock.calls[0]?.[0](details);
        } else {
          events.onErrorOccurred.addListener.mock.calls[0]?.[0](details);
        }
      }, 300);
      await vi.advanceTimersByTimeAsync(400);
      expect(await pending).toEqual(outcome === 'commit'
        ? { navigated: true, url: tab.url, title: 'Reloaded' }
        : undefined);
      for (const source of Object.values(events)) {
        expect(source.removeListener).toHaveBeenCalledWith(source.addListener.mock.calls[0][0]);
      }
    } finally {
      Object.assign(chrome, { webNavigation: original });
    }
  });

  it('settles a redirected download on a loading tab without reporting a navigation', async () => {
    vi.useFakeTimers();
    const originalNavigation = chrome.webNavigation;
    const originalRequests = chrome.webRequest;
    const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
    const onBeforeNavigate = event(), onBeforeRedirect = event(), onErrorOccurred = event();
    Object.assign(chrome, { webNavigation: { onBeforeNavigate, onCommitted: event(), onErrorOccurred },
      webRequest: { onBeforeRedirect } });
    try {
      tabs.set(7, { id: 7, url: 'https://example.com/', status: 'loading' });
      const observer = (await observePageChanges(7, 0))!;
      const frame = { tabId: 7, frameId: 0 };
      const start = 'https://example.com/go', middle = 'https://example.com/next', file = 'https://example.com/file';
      onBeforeNavigate.addListener.mock.calls[0][0]({ ...frame, url: start });
      const redirect = onBeforeRedirect.addListener.mock.calls[0][0];
      redirect({ ...frame, url: start, redirectUrl: middle });
      redirect({ ...frame, url: middle, redirectUrl: file });
      onErrorOccurred.addListener.mock.calls[0][0]({ ...frame, url: file, error: 'net::ERR_ABORTED' });
      expect(await observer.finish(okResult())).toBeUndefined();
      expect(onBeforeRedirect.removeListener).toHaveBeenCalledWith(redirect);
    } finally {
      Object.assign(chrome, { webNavigation: originalNavigation, webRequest: originalRequests });
    }
  });

  it('returns nothing when the page did not change', async () => {
    const observer = (await observePageChanges(7, 0))!;
    expect(await observer.finish(okResult())).toBeUndefined();
  });

  it('reports a closed tab', async () => {
    const observer = (await observePageChanges(7, 0))!;
    tabs.delete(7);
    expect(await observer.finish(okResult())).toEqual({ tabClosed: true });
  });

  it('does not wait for a load blocked by a pending dialog, and flags slow loads', async () => {
    vi.useFakeTimers();
    let observer = (await observePageChanges(7, 0))!;
    navigate('https://example.com/next', '', 'loading');
    const blocked = await observer.finish(okResult({ dialog: { type: 'confirm', handled: false } }));
    expect(blocked).toMatchObject({ navigated: true, loading: true });

    observer = (await observePageChanges(7, 0))!;
    navigate('https://example.com/slow', '', 'loading');
    const pending = observer.finish(okResult());
    await vi.advanceTimersByTimeAsync(PAGE_CHANGE_LOAD_WAIT_MS + 200);
    expect(await pending).toMatchObject({ navigated: true, url: 'https://example.com/slow', loading: true });
  });

  it('merges the summary into JSON results and keeps navigationOccurred consistent', () => {
    const merged = withPageChange(okResult({ success: true, navigationOccurred: false }), {
      navigated: true,
      url: 'https://example.com/home',
    });
    expect(JSON.parse(String((merged.content[0] as { text: string }).text))).toEqual({
      success: true,
      navigationOccurred: true,
      pageChange: { navigated: true, url: 'https://example.com/home' },
    });

    const error = { content: [{ type: 'text' as const, text: 'boom' }], isError: true };
    expect(withPageChange(error, { navigated: true })).toBe(error);
    expect(withPageChange(okResult(), undefined)).toEqual(okResult());
  });

  it('cancel stops listening', async () => {
    const observer = (await observePageChanges(7, 0))!;
    observer.cancel();
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('cleans up listeners and returns undefined when aborted by signal', async () => {
    const controller = new AbortController();
    const observer = (await observePageChanges(7, 500, controller.signal))!;
    const pending = observer.finish(okResult());
    controller.abort();

    expect(await pending).toBeUndefined();
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('does not wait for load when chained dialogs leave an unhandled dialog', async () => {
    const observer = (await observePageChanges(7, 0))!;
    navigate('https://example.com/chained', '', 'loading');
    const summary = await observer.finish(
      okResult({
        dialogs: [
          { type: 'confirm', handled: 'accept' },
          { type: 'alert', handled: false },
        ],
      }),
    );
    expect(summary).toMatchObject({ navigated: true, loading: true });
  });

  it('ignores transient status=loading updates without webNavigation.onCommitted', async () => {
    const committed: Listener[] = [];
    const originalWebNavigation = (chrome as any).webNavigation;
    (chrome as any).webNavigation = {
      onCommitted: {
        addListener: vi.fn((l: Listener) => committed.push(l)),
        removeListener: vi.fn((l: Listener) => {
          const idx = committed.indexOf(l);
          if (idx >= 0) committed.splice(idx, 1);
        }),
      },
    };
    try {
      const observer = (await observePageChanges(7, 0))!;
      for (const l of updated) l(7, { status: 'loading' });
      expect(await observer.finish(okResult())).toBeUndefined();
      expect(committed).toHaveLength(0);
    } finally {
      (chrome as any).webNavigation = originalWebNavigation;
    }
  });
});
