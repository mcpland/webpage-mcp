import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SURFACE_SESSION_ID = "a".repeat(64);

describe("Web Editor props early injection registry", () => {
  let sessionData: Record<string, unknown>;
  let registeredScripts: Map<string, chrome.scripting.RegisteredContentScript>;
  let tabsById: Map<number, chrome.tabs.Tab>;
  let unregisterContentScripts: ReturnType<typeof vi.fn>;
  let executeScript: ReturnType<typeof vi.fn>;
  let addNavigationListener: ReturnType<typeof vi.fn>;
  let addTabReplacedListener: ReturnType<typeof vi.fn>;

  function storedRegistration(tabId: number): {
    version: number;
    registrationId: string;
    host: string;
    origin: string;
    surfaceSessionId: string;
  } {
    return sessionData[`web-editor-props-early-tab-${tabId}`] as {
      version: number;
      registrationId: string;
      host: string;
      origin: string;
      surfaceSessionId: string;
    };
  }

  beforeEach(() => {
    vi.resetModules();
    sessionData = {};
    registeredScripts = new Map();
    tabsById = new Map();
    addNavigationListener = vi.fn();
    addTabReplacedListener = vi.fn();
    unregisterContentScripts = vi.fn(async ({ ids }: { ids?: string[] }) => {
      for (const id of ids ?? []) {
        registeredScripts.delete(id);
      }
    });
    executeScript = vi.fn(async (options: any) => [
      {
        frameId: 0,
        documentId: options.target.documentIds?.[0] ?? "current-top-document",
        result: undefined,
      },
    ]);

    chrome.storage.session = {
      get: vi.fn(async (keys?: string | string[] | null) => {
        if (keys == null) return { ...sessionData };
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          requested
            .filter((key) => key in sessionData)
            .map((key) => [key, sessionData[key]]),
        );
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(sessionData, items);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          delete sessionData[key];
        }
      }),
    } as unknown as typeof chrome.storage.session;

    chrome.scripting = {
      getRegisteredContentScripts: vi.fn(
        async (filter?: { ids?: string[] }) => {
          const scripts = Array.from(registeredScripts.values());
          return filter?.ids
            ? scripts.filter((script) => filter.ids?.includes(script.id))
            : scripts;
        },
      ),
      registerContentScripts: vi.fn(
        async (scripts: chrome.scripting.RegisteredContentScript[]) => {
          for (const script of scripts) {
            registeredScripts.set(script.id, script);
          }
        },
      ),
      unregisterContentScripts,
      executeScript,
    } as unknown as typeof chrome.scripting;

    chrome.tabs.get = vi.fn(async (tabId: number) => {
      const tab = tabsById.get(tabId);
      if (!tab) throw new Error(`No tab with id ${tabId}`);
      return tab;
    });
    chrome.tabs.query = vi.fn(async () => Array.from(tabsById.values()));
    chrome.webNavigation.onCommitted.addListener = addNavigationListener;
    Object.assign(chrome.webNavigation, {
      onTabReplaced: {
        addListener: addTabReplacedListener,
        removeListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    delete (window as any).__MCP_WEB_EDITOR_PROPS_AGENT__;
    delete (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it("registers only for the current browser session and records the requesting tab", async () => {
    const { registerPropsAgentEarlyInjection } =
      await import("@/entrypoints/background/web-editor/props-early-injection");

    const result = await registerPropsAgentEarlyInjection(
      12,
      "https://example.com/editor",
      SURFACE_SESSION_ID,
    );

    expect(result.id).toMatch(/^mcp_we_props_early_example_com_[a-f0-9]{24}$/);
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: result.id,
        matches: ["*://example.com/*"],
        world: "MAIN",
        runAt: "document_start",
        persistAcrossSessions: false,
      }),
    ]);
    expect(storedRegistration(12)).toEqual({
      version: 2,
      registrationId: result.id,
      host: "example.com",
      origin: "https://example.com",
      surfaceSessionId: SURFACE_SESSION_ID,
    });
  });

  it("keeps a shared host registration until the final editor tab releases it", async () => {
    const {
      registerPropsAgentEarlyInjection,
      releasePropsAgentEarlyInjection,
    } =
      await import("@/entrypoints/background/web-editor/props-early-injection");

    await registerPropsAgentEarlyInjection(
      12,
      "https://example.com/one",
      SURFACE_SESSION_ID,
    );
    await registerPropsAgentEarlyInjection(
      13,
      "https://example.com/two",
      SURFACE_SESSION_ID,
    );
    await releasePropsAgentEarlyInjection(12);

    expect(unregisterContentScripts).not.toHaveBeenCalled();
    const registrationId = storedRegistration(13).registrationId;
    expect(registrationId).toMatch(
      /^mcp_we_props_early_example_com_[a-f0-9]{24}$/,
    );
    expect(registeredScripts.has(registrationId)).toBe(true);

    await releasePropsAgentEarlyInjection(13);

    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: [registrationId],
    });
    expect(registeredScripts.has(registrationId)).toBe(false);
  });

  it("releases only for the surface session that owns the tab registration", async () => {
    const {
      registerPropsAgentEarlyInjection,
      releasePropsAgentEarlyInjection,
    } =
      await import("@/entrypoints/background/web-editor/props-early-injection");
    const otherSurfaceSessionId = "b".repeat(64);
    const registration = await registerPropsAgentEarlyInjection(
      12,
      "https://owned.example/editor",
      SURFACE_SESSION_ID,
    );

    await expect(
      releasePropsAgentEarlyInjection(12, otherSurfaceSessionId),
    ).resolves.toBe(false);
    expect(storedRegistration(12).surfaceSessionId).toBe(SURFACE_SESSION_ID);
    expect(unregisterContentScripts).not.toHaveBeenCalled();

    await expect(
      releasePropsAgentEarlyInjection(12, SURFACE_SESSION_ID),
    ).resolves.toBe(true);
    expect(sessionData["web-editor-props-early-tab-12"]).toBeUndefined();
    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: [registration.id],
    });
  });

  it("keeps distinct hosts separate when their sanitized names collide", async () => {
    const { registerPropsAgentEarlyInjection } =
      await import("@/entrypoints/background/web-editor/props-early-injection");

    const dotted = await registerPropsAgentEarlyInjection(
      12,
      "https://foo.bar/editor",
      SURFACE_SESSION_ID,
    );
    const underscored = await registerPropsAgentEarlyInjection(
      13,
      "https://foo_bar/editor",
      SURFACE_SESSION_ID,
    );

    expect(dotted.id).not.toBe(underscored.id);
    expect(dotted.id).toMatch(/^mcp_we_props_early_foo_bar_[a-f0-9]{24}$/);
    expect(underscored.id).toMatch(/^mcp_we_props_early_foo_bar_[a-f0-9]{24}$/);
    expect(registeredScripts.get(dotted.id)?.matches).toEqual([
      "*://foo.bar/*",
    ]);
    expect(registeredScripts.get(underscored.id)?.matches).toEqual([
      "*://foo_bar/*",
    ]);
  });

  it("releases the old host after tab A crosses sites so tab B no longer receives it", async () => {
    const {
      registerPropsAgentEarlyInjection,
      reconcilePropsAgentEarlyInjectionNavigation,
    } =
      await import("@/entrypoints/background/web-editor/props-early-injection");

    const registration = await registerPropsAgentEarlyInjection(
      12,
      "https://old.example/editor",
      SURFACE_SESSION_ID,
    );
    const released = await reconcilePropsAgentEarlyInjectionNavigation(
      12,
      "https://new.example/page",
    );

    expect(released).toBe(true);
    expect(sessionData["web-editor-props-early-tab-12"]).toBeUndefined();
    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: [registration.id],
    });
    expect(registeredScripts.has(registration.id)).toBe(false);
    expect(
      Array.from(registeredScripts.values()).some((script) =>
        script.matches?.includes("*://old.example/*"),
      ),
    ).toBe(false);
  });

  it("retains registration across same-host navigation and refreshes the normalized origin", async () => {
    const {
      registerPropsAgentEarlyInjection,
      reconcilePropsAgentEarlyInjectionNavigation,
    } =
      await import("@/entrypoints/background/web-editor/props-early-injection");

    const registration = await registerPropsAgentEarlyInjection(
      12,
      "https://Example.COM/editor",
      SURFACE_SESSION_ID,
    );
    const released = await reconcilePropsAgentEarlyInjectionNavigation(
      12,
      "http://example.com:8080/next",
    );

    expect(released).toBe(false);
    expect(unregisterContentScripts).not.toHaveBeenCalled();
    expect(registeredScripts.has(registration.id)).toBe(true);
    expect(storedRegistration(12)).toEqual({
      version: 2,
      registrationId: registration.id,
      host: "example.com",
      origin: "http://example.com:8080",
      surfaceSessionId: SURFACE_SESSION_ID,
    });
  });

  it("retires an unowned legacy registration on a same-host commit", async () => {
    const {
      registerPropsAgentEarlyInjection,
      reconcilePropsAgentEarlyInjectionNavigation,
    } =
      await import("@/entrypoints/background/web-editor/props-early-injection");

    const registration = await registerPropsAgentEarlyInjection(
      12,
      "https://legacy.example/a",
      SURFACE_SESSION_ID,
    );
    sessionData["web-editor-props-early-tab-12"] = registration.id;

    await reconcilePropsAgentEarlyInjectionNavigation(
      12,
      "https://legacy.example/b",
    );

    expect(sessionData["web-editor-props-early-tab-12"]).toBeUndefined();
    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: [registration.id],
    });
  });

  it("keeps a shared registration until every editor tab leaves the host", async () => {
    const {
      registerPropsAgentEarlyInjection,
      reconcilePropsAgentEarlyInjectionNavigation,
    } =
      await import("@/entrypoints/background/web-editor/props-early-injection");

    const registration = await registerPropsAgentEarlyInjection(
      12,
      "https://shared.example/a",
      SURFACE_SESSION_ID,
    );
    await registerPropsAgentEarlyInjection(
      13,
      "https://shared.example/b",
      SURFACE_SESSION_ID,
    );

    await reconcilePropsAgentEarlyInjectionNavigation(
      12,
      "https://other.example/a",
    );
    expect(unregisterContentScripts).not.toHaveBeenCalled();
    expect(registeredScripts.has(registration.id)).toBe(true);

    await reconcilePropsAgentEarlyInjectionNavigation(13, "chrome://settings/");
    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: [registration.id],
    });
    expect(registeredScripts.has(registration.id)).toBe(false);
  });

  it("restores persisted ownership after a service-worker restart", async () => {
    tabsById.set(12, {
      id: 12,
      url: "https://restart.example/current",
    } as chrome.tabs.Tab);
    const firstWorker =
      await import("@/entrypoints/background/web-editor/props-early-injection");
    const registration = await firstWorker.registerPropsAgentEarlyInjection(
      12,
      "https://restart.example/editor",
      SURFACE_SESSION_ID,
    );

    vi.resetModules();
    const restartedWorker =
      await import("@/entrypoints/background/web-editor/props-early-injection");
    restartedWorker.initPropsAgentEarlyInjectionNavigationLifecycle();
    await restartedWorker.pruneOrphanedPropsAgentEarlyInjections();

    expect(addNavigationListener).toHaveBeenCalledOnce();
    expect(unregisterContentScripts).not.toHaveBeenCalled();
    expect(storedRegistration(12)).toEqual({
      version: 2,
      registrationId: registration.id,
      host: "restart.example",
      origin: "https://restart.example",
      surfaceSessionId: SURFACE_SESSION_ID,
    });
    expect(registeredScripts.has(registration.id)).toBe(true);

    await restartedWorker.reconcilePropsAgentEarlyInjectionNavigation(
      12,
      "https://after-restart.example/",
    );
    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: [registration.id],
    });
  });

  it("registers the top-level navigation listener once per worker instance", async () => {
    const { initPropsAgentEarlyInjectionNavigationLifecycle } =
      await import("@/entrypoints/background/web-editor/props-early-injection");

    initPropsAgentEarlyInjectionNavigationLifecycle();
    initPropsAgentEarlyInjectionNavigationLifecycle();

    expect(addNavigationListener).toHaveBeenCalledOnce();
    expect(addNavigationListener).toHaveBeenCalledWith(expect.any(Function));
    expect(addTabReplacedListener).toHaveBeenCalledOnce();
    expect(addTabReplacedListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it("ignores subframe commits and releases only on a top-frame cross-host commit", async () => {
    const propsInjection =
      await import("@/entrypoints/background/web-editor/props-early-injection");
    const registration = await propsInjection.registerPropsAgentEarlyInjection(
      12,
      "https://frames.example/editor",
      SURFACE_SESSION_ID,
    );
    propsInjection.initPropsAgentEarlyInjectionNavigationLifecycle();
    const listener = addNavigationListener.mock.calls[0]?.[0] as
      | ((
          details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
        ) => void)
      | undefined;

    listener?.({
      tabId: 12,
      frameId: 3,
      url: "https://cross-host.example/frame",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    expect(storedRegistration(12).registrationId).toBe(registration.id);
    expect(unregisterContentScripts).not.toHaveBeenCalled();

    listener?.({
      tabId: 12,
      frameId: 0,
      url: "https://cross-host.example/top",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    // Queue behind the listener's async reconciliation to await completion.
    await propsInjection.reconcilePropsAgentEarlyInjectionNavigation(
      12,
      "https://cross-host.example/top",
    );
    expect(sessionData["web-editor-props-early-tab-12"]).toBeUndefined();
    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: [registration.id],
    });
  });

  it("retires an untracked legacy agent on top-level commits while migration is pending", async () => {
    const propsInjection =
      await import("@/entrypoints/background/web-editor/props-early-injection");
    propsInjection.initPropsAgentEarlyInjectionNavigationLifecycle();
    const listener = addNavigationListener.mock.calls[0]?.[0] as
      | ((
          details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
        ) => void)
      | undefined;

    listener?.({
      tabId: 44,
      frameId: 0,
      documentId: "new-document",
      url: "https://untracked.example/current",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledOnce());

    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 44, documentIds: ["new-document"] },
        world: "MAIN",
      }),
    );
  });

  it("stops probing every navigation after the legacy retirement migration completes", async () => {
    sessionData["web-editor-props-legacy-retirement-version"] = 2;
    const propsInjection =
      await import("@/entrypoints/background/web-editor/props-early-injection");
    propsInjection.initPropsAgentEarlyInjectionNavigationLifecycle();
    const listener = addNavigationListener.mock.calls[0]?.[0] as
      | ((
          details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
        ) => void)
      | undefined;

    listener?.({
      tabId: 44,
      frameId: 0,
      documentId: "post-migration-document",
      url: "https://untracked.example/current",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await vi.waitFor(() =>
      expect(chrome.storage.session.get).toHaveBeenCalled(),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(executeScript).not.toHaveBeenCalled();
  });

  it("does not attempt MAIN retirement on an unscriptable top-level URL", async () => {
    const propsInjection =
      await import("@/entrypoints/background/web-editor/props-early-injection");
    propsInjection.initPropsAgentEarlyInjectionNavigationLifecycle();
    const listener = addNavigationListener.mock.calls[0]?.[0] as
      | ((
          details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
        ) => void)
      | undefined;

    listener?.({
      tabId: 44,
      frameId: 0,
      documentId: "browser-document",
      url: "chrome://settings/",
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await Promise.resolve();
    await Promise.resolve();

    expect(executeScript).not.toHaveBeenCalled();
  });

  it("releases ownership when Chrome replaces the tab document", async () => {
    const propsInjection =
      await import("@/entrypoints/background/web-editor/props-early-injection");
    const registration = await propsInjection.registerPropsAgentEarlyInjection(
      12,
      "https://replace.example/editor",
      SURFACE_SESSION_ID,
    );
    propsInjection.initPropsAgentEarlyInjectionNavigationLifecycle();
    const listener = addTabReplacedListener.mock.calls[0]?.[0] as
      | ((
          details: chrome.webNavigation.WebNavigationReplacementCallbackDetails,
        ) => void)
      | undefined;

    listener?.({ tabId: 99, replacedTabId: 12, timeStamp: Date.now() });
    // Queue a no-op reconciliation behind the listener's release operation.
    await propsInjection.reconcilePropsAgentEarlyInjectionNavigation(
      12,
      "https://replace.example/after",
    );

    expect(sessionData["web-editor-props-early-tab-12"]).toBeUndefined();
    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: [registration.id],
    });
  });

  it("prunes orphaned managed registrations without touching unrelated scripts", async () => {
    tabsById.set(21, {
      id: 21,
      url: "https://kept.example/current",
    } as chrome.tabs.Tab);
    registeredScripts.set("mcp_we_props_early_orphan_example", {
      id: "mcp_we_props_early_orphan_example",
      matches: ["*://orphan.example/*"],
      js: ["inject-scripts/props-hook-bootstrap.js"],
    });
    registeredScripts.set("unrelated-script", {
      id: "unrelated-script",
      matches: ["<all_urls>"],
      js: ["unrelated.js"],
    });

    const {
      pruneOrphanedPropsAgentEarlyInjections,
      registerPropsAgentEarlyInjection,
    } =
      await import("@/entrypoints/background/web-editor/props-early-injection");
    const kept = await registerPropsAgentEarlyInjection(
      21,
      "https://kept.example/editor",
      SURFACE_SESSION_ID,
    );
    await pruneOrphanedPropsAgentEarlyInjections();

    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: ["mcp_we_props_early_orphan_example"],
    });
    expect(registeredScripts.has(kept.id)).toBe(true);
    expect(registeredScripts.has("unrelated-script")).toBe(true);
  });

  it("replaces stale legacy registration settings with the exact bootstrap config", async () => {
    tabsById.set(21, {
      id: 21,
      url: "https://stale.example/current",
    } as chrome.tabs.Tab);
    const propsInjection =
      await import("@/entrypoints/background/web-editor/props-early-injection");
    const registration = await propsInjection.registerPropsAgentEarlyInjection(
      21,
      "https://stale.example/editor",
      SURFACE_SESSION_ID,
    );
    registeredScripts.set(registration.id, {
      id: registration.id,
      js: ["inject-scripts/props-agent.js"],
      matches: ["*://stale.example/*"],
      runAt: "document_idle",
      world: "ISOLATED",
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
    });
    unregisterContentScripts.mockClear();
    vi.mocked(chrome.scripting.registerContentScripts).mockClear();

    await propsInjection.pruneOrphanedPropsAgentEarlyInjections();

    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: [registration.id],
    });
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([
      {
        id: registration.id,
        js: ["inject-scripts/props-hook-bootstrap.js"],
        matches: ["*://stale.example/*"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: false,
        matchOriginAsFallback: false,
        persistAcrossSessions: false,
      },
    ]);
  });

  it("retires legacy agents in open http tabs without an early-injection record", async () => {
    tabsById.set(31, {
      id: 31,
      url: "https://ordinary.example/current",
    } as chrome.tabs.Tab);
    tabsById.set(32, {
      id: 32,
      url: "https://discarded.example/current",
      discarded: true,
    } as chrome.tabs.Tab);
    tabsById.set(33, {
      id: 33,
      url: "chrome://settings/",
    } as chrome.tabs.Tab);
    const { pruneOrphanedPropsAgentEarlyInjections } =
      await import("@/entrypoints/background/web-editor/props-early-injection");

    await pruneOrphanedPropsAgentEarlyInjections();

    expect(executeScript).toHaveBeenCalledOnce();
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 31, frameIds: [0] },
        world: "MAIN",
        func: expect.any(Function),
      }),
    );
    expect(sessionData["web-editor-props-legacy-retirement-version"]).toBe(2);
  });

  it("marks the migration only after a successful sweep and retries failures", async () => {
    tabsById.set(31, {
      id: 31,
      url: "https://retry.example/current",
    } as chrome.tabs.Tab);
    executeScript.mockResolvedValueOnce([]);
    const propsInjection =
      await import("@/entrypoints/background/web-editor/props-early-injection");

    await expect(
      propsInjection.pruneOrphanedPropsAgentEarlyInjections(),
    ).rejects.toThrow("must be retried");
    expect(
      sessionData["web-editor-props-legacy-retirement-version"],
    ).toBeUndefined();

    await propsInjection.pruneOrphanedPropsAgentEarlyInjections();
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(sessionData["web-editor-props-legacy-retirement-version"]).toBe(2);
  });

  it("times out a stuck sweep without blocking operational registration", async () => {
    vi.useFakeTimers();
    try {
      tabsById.set(31, {
        id: 31,
        url: "https://stuck.example/current",
      } as chrome.tabs.Tab);
      executeScript.mockReturnValueOnce(new Promise(() => {}));
      const propsInjection =
        await import("@/entrypoints/background/web-editor/props-early-injection");

      const pruning = propsInjection.pruneOrphanedPropsAgentEarlyInjections();
      const pruningRejection =
        expect(pruning).rejects.toThrow("must be retried");
      await vi.waitFor(() => expect(executeScript).toHaveBeenCalledOnce());
      await expect(
        propsInjection.registerPropsAgentEarlyInjection(
          32,
          "https://operational.example/editor",
          SURFACE_SESSION_ID,
        ),
      ).resolves.toMatchObject({ host: "operational.example" });

      await vi.advanceTimersByTimeAsync(1_500);
      await pruningRejection;
      await expect(
        propsInjection.releasePropsAgentEarlyInjection(32),
      ).resolves.toBe(true);
      expect(
        sessionData["web-editor-props-legacy-retirement-version"],
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes the actual bootstrap safe in both legacy/new injection orders", () => {
    const bootstrap = readFileSync(
      join(process.cwd(), "inject-scripts", "props-hook-bootstrap.js"),
      "utf8",
    );
    const runBootstrap = () => Function(bootstrap)();
    const dispose = vi.fn(() => {
      throw new Error("legacy dispose failure");
    });
    const cleanup = vi.fn();
    window.addEventListener("web-editor-props:cleanup", cleanup, {
      once: true,
    });
    (window as any).__MCP_WEB_EDITOR_PROPS_AGENT__ = { version: 1, dispose };

    runBootstrap();

    expect(dispose).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    const sentinel = (window as any).__MCP_WEB_EDITOR_PROPS_AGENT__;
    expect(sentinel).toEqual({ version: 2, transport: "background-only" });
    expect(Object.isFrozen(sentinel)).toBe(true);

    delete (window as any).__MCP_WEB_EDITOR_PROPS_AGENT__;
    runBootstrap();
    let legacyInstalled = false;
    (() => {
      if ((window as any).__MCP_WEB_EDITOR_PROPS_AGENT__) return;
      legacyInstalled = true;
    })();
    expect(legacyInstalled).toBe(false);
  });
});
