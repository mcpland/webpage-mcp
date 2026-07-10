import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addNavigationStep: vi.fn(),
  ensureRecorderInjected: vi.fn().mockResolvedValue(undefined),
  broadcastControlToTab: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/entrypoints/background/record-replay/recording/flow-builder', () => ({
  addNavigationStep: mocks.addNavigationStep,
}));
vi.mock('@/entrypoints/background/record-replay/recording/content-injection', () => ({
  ensureRecorderInjected: mocks.ensureRecorderInjected,
  broadcastControlToTab: mocks.broadcastControlToTab,
  REC_CMD: { START: 'start' },
}));

import { initBrowserEventListeners } from '@/entrypoints/background/record-replay/recording/browser-event-listener';

type ActivatedListener = (info: chrome.tabs.TabActiveInfo) => void | Promise<void>;
type CommittedListener = (
  details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
) => void | Promise<void>;

function createSession(activeTabs = new Set([101])) {
  return {
    getStatus: vi.fn(() => 'recording'),
    getFlow: vi.fn(() => ({ id: 'flow-1', name: 'Flow', nodes: [], edges: [] })),
    getSession: vi.fn(() => ({ sessionId: 'sess-1' })),
    hasActiveTab: vi.fn((tabId: number) => activeTabs.has(tabId)),
    addActiveTab: vi.fn((tabId: number) => {
      activeTabs.add(tabId);
      return true;
    }),
    removeActiveTab: vi.fn((tabId: number) => activeTabs.delete(tabId)),
    appendSteps: vi.fn(),
    broadcastTimelineUpdate: vi.fn(),
  };
}

describe('recording tab membership', () => {
  let activated: ActivatedListener;
  let committed: CommittedListener;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 101, url: 'https://adopted.test/' }),
        onActivated: {
          addListener: vi.fn((listener: ActivatedListener) => {
            activated = listener;
          }),
        },
        onRemoved: { addListener: vi.fn() },
      },
      webNavigation: {
        onCommitted: {
          addListener: vi.fn((listener: CommittedListener) => {
            committed = listener;
          }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ignores top-level navigations from tabs not adopted by the session', async () => {
    const session = createSession();
    initBrowserEventListeners(session as any);

    await committed({
      tabId: 999,
      frameId: 0,
      transitionType: 'typed',
      url: 'https://unrelated.test/private',
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);

    expect(mocks.ensureRecorderInjected).not.toHaveBeenCalled();
    expect(mocks.broadcastControlToTab).not.toHaveBeenCalled();
    expect(mocks.addNavigationStep).not.toHaveBeenCalled();
    expect(session.addActiveTab).not.toHaveBeenCalled();
  });

  it('continues recording navigation in an already adopted tab', async () => {
    const session = createSession();
    initBrowserEventListeners(session as any);

    await committed({
      tabId: 101,
      frameId: 0,
      transitionType: 'typed',
      url: 'https://adopted.test/next',
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);

    expect(mocks.ensureRecorderInjected).toHaveBeenCalledWith(101);
    expect(mocks.addNavigationStep).toHaveBeenCalledWith(
      expect.anything(),
      'https://adopted.test/',
    );
    expect(session.addActiveTab).not.toHaveBeenCalled();
  });

  it('adopts an explicitly activated tab and rolls it back when injection fails', async () => {
    const session = createSession();
    mocks.ensureRecorderInjected.mockRejectedValueOnce(new Error('restricted page'));
    initBrowserEventListeners(session as any);

    await activated({ tabId: 202, windowId: 1 });

    expect(session.addActiveTab).toHaveBeenCalledWith(202);
    expect(session.removeActiveTab).toHaveBeenCalledWith(202);
    expect(session.appendSteps).not.toHaveBeenCalled();
  });
});
