import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STEP_TYPES } from "@/common/step-types";

const mocks = vi.hoisted(() => ({
  ensureRecorderInjected: vi.fn().mockResolvedValue(undefined),
  broadcastControlToTab: vi.fn().mockResolvedValue(undefined),
}));

vi.mock(
  "@/entrypoints/background/record-replay/recording/content-injection",
  () => ({
    ensureRecorderInjected: mocks.ensureRecorderInjected,
    broadcastControlToTab: mocks.broadcastControlToTab,
    REC_CMD: { START: "start" },
  }),
);

import { initBrowserEventListeners } from "@/entrypoints/background/record-replay/recording/browser-event-listener";

type ActivatedListener = (
  info: chrome.tabs.TabActiveInfo,
) => void | Promise<void>;
type CommittedListener = (
  details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
) => void | Promise<void>;

function createSession(activeTabs = new Set([101])) {
  const activeDocuments = new Map<number, string>();
  const state = {
    sessionId: "sess-1",
    status: "recording",
    flow: {
      id: "flow-1",
      name: "Flow",
      nodes: [],
      edges: [],
    },
    stepSequence: 0,
    recordedSteps: [] as Array<
      { id: string; type: string } & Record<string, unknown>
    >,
  };
  return {
    state,
    getStatus: vi.fn(() => state.status),
    getFlow: vi.fn(() => state.flow),
    getSession: vi.fn(() => ({
      sessionId: state.sessionId,
      status: state.status,
    })),
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    hasActiveTab: vi.fn((tabId: number) => activeTabs.has(tabId)),
    addActiveTab: vi.fn((tabId: number) => {
      activeTabs.add(tabId);
      return true;
    }),
    removeActiveTab: vi.fn((tabId: number) => {
      activeDocuments.delete(tabId);
      return activeTabs.delete(tabId);
    }),
    appendSteps: vi.fn(
      (
        steps: Array<{ id: string; type: string } & Record<string, unknown>>,
      ) => {
        for (const step of steps) {
          if (!step.id) {
            state.stepSequence += 1;
            step.id = `background-step-${state.stepSequence}`;
          }
          state.recordedSteps.push(step);
        }
        return { accepted: steps.length, truncated: false };
      },
    ),
    persistRecoveryState: vi.fn().mockResolvedValue(undefined),
    getActiveTabDocument: vi.fn((tabId: number) => activeDocuments.get(tabId)),
    setActiveTabDocument: vi.fn(
      (tabId: number, documentId: string | undefined) => {
        if (!activeTabs.has(tabId)) return;
        if (documentId) activeDocuments.set(tabId, documentId);
        else activeDocuments.delete(tabId);
      },
    ),
    rollbackLastStep: vi.fn((stepId: string) => {
      const last = state.recordedSteps.at(-1);
      if (last?.id !== stepId) return false;
      state.recordedSteps.pop();
      return true;
    }),
    broadcastTimelineUpdate: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("recording tab membership", () => {
  let activated: ActivatedListener;
  let committed: CommittedListener;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRecorderInjected.mockResolvedValue(undefined);
    mocks.broadcastControlToTab.mockResolvedValue(true);
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi
          .fn()
          .mockResolvedValue({ id: 101, url: "https://adopted.test/" }),
        onActivated: {
          addListener: vi.fn((listener: ActivatedListener) => {
            activated = listener;
          }),
        },
        onRemoved: { addListener: vi.fn() },
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          {
            frameId: 0,
            documentId: "document-current",
            url: "https://adopted.test/",
          },
        ]),
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

  it("ignores top-level navigations from tabs not adopted by the session", async () => {
    const session = createSession();
    initBrowserEventListeners(session as any);

    await committed({
      tabId: 999,
      frameId: 0,
      transitionType: "typed",
      url: "https://unrelated.test/private",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);

    expect(mocks.ensureRecorderInjected).not.toHaveBeenCalled();
    expect(mocks.broadcastControlToTab).not.toHaveBeenCalled();
    expect(session.appendSteps).not.toHaveBeenCalled();
    expect(session.addActiveTab).not.toHaveBeenCalled();
  });

  it("continues recording navigation in an already adopted tab", async () => {
    const session = createSession();
    initBrowserEventListeners(session as any);

    await committed({
      tabId: 101,
      frameId: 0,
      transitionType: "typed",
      url: "https://adopted.test/next",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);

    expect(mocks.ensureRecorderInjected).toHaveBeenCalledWith(101);
    expect(session.appendSteps).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: "navigate",
          url: "https://adopted.test/",
        }),
      ]),
    );
    expect(session.addActiveTab).not.toHaveBeenCalled();
    expect(session.appendSteps.mock.invocationCallOrder[0]).toBeLessThan(
      session.persistRecoveryState.mock.invocationCallOrder[0],
    );
    expect(
      session.persistRecoveryState.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.broadcastControlToTab.mock.invocationCallOrder[0]);
  });

  it("adopts an explicitly activated tab and rolls it back when injection fails", async () => {
    const session = createSession();
    mocks.ensureRecorderInjected.mockRejectedValueOnce(
      new Error("restricted page"),
    );
    initBrowserEventListeners(session as any);

    await activated({ tabId: 202, windowId: 1 });

    expect(session.addActiveTab).toHaveBeenCalledWith(202);
    expect(session.removeActiveTab).toHaveBeenCalledWith(202);
    expect(session.appendSteps).not.toHaveBeenCalled();
  });

  it("hands a delayed failed activation to the superseding commit without deleting its new document", async () => {
    const session = createSession();
    const delayedInjection = deferred<void>();
    mocks.ensureRecorderInjected
      .mockImplementationOnce(() => delayedInjection.promise)
      .mockResolvedValueOnce(undefined);
    vi.mocked(chrome.tabs.get).mockResolvedValue({
      id: 202,
      url: "https://adopted.test/new-document",
    } as chrome.tabs.Tab);
    initBrowserEventListeners(session as any);

    const staleActivation = activated({ tabId: 202, windowId: 1 });
    await vi.waitFor(() =>
      expect(mocks.ensureRecorderInjected).toHaveBeenCalledWith(202),
    );
    const currentCommit = committed({
      tabId: 202,
      frameId: 0,
      transitionType: "typed",
      url: "https://adopted.test/new-document",
      documentId: "document-new",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    delayedInjection.reject(new Error("old document disappeared"));

    await Promise.all([staleActivation, currentCommit]);

    expect(session.removeActiveTab).toHaveBeenCalledOnce();
    expect(session.addActiveTab).toHaveBeenCalledTimes(2);
    expect(session.state.recordedSteps).toMatchObject([
      { type: STEP_TYPES.SWITCH_TAB },
      {
        type: STEP_TYPES.NAVIGATE,
        url: "https://adopted.test/new-document",
      },
    ]);
    expect(session.hasActiveTab(202)).toBe(true);
    expect(session.getActiveTabDocument(202)).toBe("document-new");
    expect(mocks.broadcastControlToTab).toHaveBeenCalledWith(
      202,
      "start",
      expect.objectContaining({ sessionId: "sess-1" }),
      "document-new",
    );
    expect(session.removeActiveTab.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.broadcastControlToTab.mock.invocationCallOrder[0],
    );
  });

  it("rolls back the durable navigation node and membership when START is rejected", async () => {
    const session = createSession();
    mocks.broadcastControlToTab.mockResolvedValueOnce(false as any);
    initBrowserEventListeners(session as any);

    await committed({
      tabId: 101,
      frameId: 0,
      transitionType: "typed",
      url: "https://adopted.test/rejected",
      documentId: "document-rejected",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);

    expect(session.rollbackLastStep).toHaveBeenCalledWith("background-step-1");
    expect(session.removeActiveTab).toHaveBeenCalledWith(101);
    expect(session.persistRecoveryState).toHaveBeenCalledTimes(2);
  });

  it("serializes same-tab commits and only publishes the newest document generation", async () => {
    const session = createSession();
    const firstTabLookup = deferred<chrome.tabs.Tab>();
    vi.mocked(chrome.tabs.get)
      .mockImplementationOnce(() => firstTabLookup.promise)
      .mockResolvedValueOnce({
        id: 101,
        url: "https://adopted.test/new",
      } as chrome.tabs.Tab);
    initBrowserEventListeners(session as any);

    const first = committed({
      tabId: 101,
      frameId: 0,
      transitionType: "typed",
      url: "https://adopted.test/old",
      documentId: "document-old",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledOnce());
    const latest = committed({
      tabId: 101,
      frameId: 0,
      transitionType: "typed",
      url: "https://adopted.test/new",
      documentId: "document-new",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);

    expect(chrome.tabs.get).toHaveBeenCalledOnce();
    firstTabLookup.resolve({
      id: 101,
      url: "https://adopted.test/old",
    } as chrome.tabs.Tab);
    await Promise.all([first, latest]);

    expect(chrome.tabs.get).toHaveBeenCalledTimes(2);
    expect(session.appendSteps).toHaveBeenCalledOnce();
    expect(session.appendSteps).toHaveBeenCalledWith([
      expect.objectContaining({ url: "https://adopted.test/new" }),
    ]);
    expect(mocks.broadcastControlToTab).toHaveBeenCalledOnce();
    expect(mocks.broadcastControlToTab).toHaveBeenCalledWith(
      101,
      "start",
      expect.objectContaining({ sessionId: "sess-1" }),
      "document-new",
    );
    expect(session.hasActiveTab(101)).toBe(true);
    expect(session.getActiveTabDocument(101)).toBe("document-new");
  });

  it("finishes stale rollback before a newer same-tab START can commit membership", async () => {
    const session = createSession();
    const firstStart = deferred<boolean>();
    mocks.broadcastControlToTab
      .mockImplementationOnce(() => firstStart.promise)
      .mockResolvedValueOnce(true);
    initBrowserEventListeners(session as any);

    const stale = committed({
      tabId: 101,
      frameId: 0,
      transitionType: "typed",
      url: "https://adopted.test/stale",
      documentId: "document-stale",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await vi.waitFor(() =>
      expect(mocks.broadcastControlToTab).toHaveBeenCalledOnce(),
    );
    const current = committed({
      tabId: 101,
      frameId: 0,
      transitionType: "typed",
      url: "https://adopted.test/current",
      documentId: "document-current",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    firstStart.resolve(false);

    await Promise.all([stale, current]);

    expect(session.rollbackLastStep).toHaveBeenCalledWith("background-step-1");
    expect(session.removeActiveTab).toHaveBeenCalledOnce();
    expect(mocks.broadcastControlToTab).toHaveBeenCalledTimes(2);
    expect(mocks.broadcastControlToTab.mock.calls[1]?.[3]).toBe(
      "document-current",
    );
    expect(session.removeActiveTab.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.broadcastControlToTab.mock.invocationCallOrder[1],
    );
    expect(session.hasActiveTab(101)).toBe(true);
    expect(session.getActiveTabDocument(101)).toBe("document-current");
  });

  it("keeps another tab's interleaved success when stale activation rollback is no longer last", async () => {
    const session = createSession();
    const staleStart = deferred<boolean>();
    mocks.broadcastControlToTab
      .mockImplementationOnce(() => staleStart.promise)
      .mockResolvedValueOnce(true);
    vi.mocked(chrome.tabs.get).mockResolvedValue({
      id: 202,
      url: "https://adopted.test/current",
    } as chrome.tabs.Tab);
    initBrowserEventListeners(session as any);

    const staleActivation = activated({ tabId: 202, windowId: 1 });
    await vi.waitFor(() =>
      expect(mocks.broadcastControlToTab).toHaveBeenCalledOnce(),
    );
    session.appendSteps([
      {
        id: "other-tab-success",
        type: STEP_TYPES.SWITCH_TAB,
        urlContains: "https://other-tab.test/",
      },
    ]);
    const currentCommit = committed({
      tabId: 202,
      frameId: 0,
      transitionType: "typed",
      url: "https://adopted.test/current",
      documentId: "document-current",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    staleStart.resolve(false);

    await Promise.all([staleActivation, currentCommit]);

    expect(session.rollbackLastStep).toHaveBeenCalledWith("background-step-1");
    expect(session.state.recordedSteps.map((step) => step.id)).toContain(
      "other-tab-success",
    );
    expect(session.state.recordedSteps.slice(-2)).toMatchObject([
      { type: STEP_TYPES.SWITCH_TAB },
      {
        type: STEP_TYPES.NAVIGATE,
        url: "https://adopted.test/current",
      },
    ]);
    expect(
      session.state.recordedSteps.findIndex(
        (step) => step.id === "other-tab-success",
      ),
    ).toBeLessThan(session.state.recordedSteps.length - 2);
    expect(session.hasActiveTab(202)).toBe(true);
    expect(session.getActiveTabDocument(202)).toBe("document-current");
  });

  it("does not let queued work captured from an old session mutate its replacement", async () => {
    const session = createSession();
    const oldSessionReady = deferred<void>();
    session.waitUntilReady.mockImplementationOnce(
      () => oldSessionReady.promise,
    );
    initBrowserEventListeners(session as any);

    const oldWork = committed({
      tabId: 101,
      frameId: 0,
      transitionType: "typed",
      url: "https://adopted.test/old-session",
      documentId: "document-old-session",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await vi.waitFor(() =>
      expect(session.waitUntilReady).toHaveBeenCalledOnce(),
    );
    session.state.sessionId = "sess-2";
    session.state.flow = {
      id: "flow-2",
      name: "Replacement flow",
      nodes: [],
      edges: [],
    };
    oldSessionReady.resolve();
    await oldWork;

    expect(session.appendSteps).not.toHaveBeenCalled();
    expect(session.persistRecoveryState).not.toHaveBeenCalled();
    expect(session.removeActiveTab).not.toHaveBeenCalled();
    expect(mocks.ensureRecorderInjected).not.toHaveBeenCalled();
    expect(mocks.broadcastControlToTab).not.toHaveBeenCalled();

    await committed({
      tabId: 101,
      frameId: 0,
      transitionType: "typed",
      url: "https://adopted.test/new-session",
      documentId: "document-new-session",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    expect(session.appendSteps).toHaveBeenCalledOnce();
    expect(mocks.broadcastControlToTab).toHaveBeenCalledWith(
      101,
      "start",
      expect.objectContaining({ sessionId: "sess-2" }),
      "document-new-session",
    );
  });

  it("sends exact-document START messages and fails closed after top replacement", async () => {
    const { broadcastControlToTab } = await vi.importActual<
      typeof import("@/entrypoints/background/record-replay/recording/content-injection")
    >("@/entrypoints/background/record-replay/recording/content-injection");
    vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue([
      {
        frameId: 0,
        documentId: "document-new",
        url: "https://adopted.test/new",
      },
      {
        frameId: 4,
        documentId: "document-child",
        url: "https://adopted.test/frame",
      },
    ] as chrome.webNavigation.GetAllFrameResultDetails[]);
    (chrome.tabs as any).sendMessage = vi
      .fn()
      .mockResolvedValue({ success: true });

    await expect(
      broadcastControlToTab(
        101,
        "start",
        { sessionId: "sess-1" },
        "document-old",
      ),
    ).resolves.toBe(false);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();

    await expect(
      broadcastControlToTab(
        101,
        "start",
        { sessionId: "sess-1" },
        "document-new",
      ),
    ).resolves.toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ cmd: "start" }),
      { documentId: "document-new" },
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ cmd: "start" }),
      { documentId: "document-child" },
    );
  });
});
