import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Web Editor props early injection registry', () => {
  let sessionData: Record<string, unknown>;
  let registeredScripts: Map<string, chrome.scripting.RegisteredContentScript>;
  let tabsById: Map<number, chrome.tabs.Tab>;
  let unregisterContentScripts: ReturnType<typeof vi.fn>;
  let addNavigationListener: ReturnType<typeof vi.fn>;
  let addTabReplacedListener: ReturnType<typeof vi.fn>;

  function storedRegistration(tabId: number): {
    version: number;
    registrationId: string;
    host: string;
    origin: string;
  } {
    return sessionData[`web-editor-props-early-tab-${tabId}`] as {
      version: number;
      registrationId: string;
      host: string;
      origin: string;
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

    chrome.storage.session = {
      get: vi.fn(async (keys?: string | string[] | null) => {
        if (keys == null) return { ...sessionData };
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          requested.filter((key) => key in sessionData).map((key) => [key, sessionData[key]]),
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
      getRegisteredContentScripts: vi.fn(async (filter?: { ids?: string[] }) => {
        const scripts = Array.from(registeredScripts.values());
        return filter?.ids ? scripts.filter((script) => filter.ids?.includes(script.id)) : scripts;
      }),
      registerContentScripts: vi.fn(
        async (scripts: chrome.scripting.RegisteredContentScript[]) => {
          for (const script of scripts) {
            registeredScripts.set(script.id, script);
          }
        },
      ),
      unregisterContentScripts,
    } as unknown as typeof chrome.scripting;

    chrome.tabs.get = vi.fn(async (tabId: number) => {
      const tab = tabsById.get(tabId);
      if (!tab) throw new Error(`No tab with id ${tabId}`);
      return tab;
    });
    chrome.webNavigation.onCommitted.addListener = addNavigationListener;
    Object.assign(chrome.webNavigation, {
      onTabReplaced: {
        addListener: addTabReplacedListener,
        removeListener: vi.fn(),
      },
    });
  });

  it('registers only for the current browser session and records the requesting tab', async () => {
    const { registerPropsAgentEarlyInjection } = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );

    const result = await registerPropsAgentEarlyInjection(12, 'https://example.com/editor');

    expect(result.id).toMatch(/^mcp_we_props_early_example_com_[a-f0-9]{24}$/);
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: result.id,
        matches: ['*://example.com/*'],
        world: 'MAIN',
        runAt: 'document_start',
        persistAcrossSessions: false,
      }),
    ]);
    expect(storedRegistration(12)).toEqual({
      version: 1,
      registrationId: result.id,
      host: 'example.com',
      origin: 'https://example.com',
    });
  });

  it('keeps a shared host registration until the final editor tab releases it', async () => {
    const { registerPropsAgentEarlyInjection, releasePropsAgentEarlyInjection } = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );

    await registerPropsAgentEarlyInjection(12, 'https://example.com/one');
    await registerPropsAgentEarlyInjection(13, 'https://example.com/two');
    await releasePropsAgentEarlyInjection(12);

    expect(unregisterContentScripts).not.toHaveBeenCalled();
    const registrationId = storedRegistration(13).registrationId;
    expect(registrationId).toMatch(/^mcp_we_props_early_example_com_[a-f0-9]{24}$/);
    expect(registeredScripts.has(registrationId)).toBe(true);

    await releasePropsAgentEarlyInjection(13);

    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: [registrationId],
    });
    expect(registeredScripts.has(registrationId)).toBe(false);
  });

  it('keeps distinct hosts separate when their sanitized names collide', async () => {
    const { registerPropsAgentEarlyInjection } = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );

    const dotted = await registerPropsAgentEarlyInjection(12, 'https://foo.bar/editor');
    const underscored = await registerPropsAgentEarlyInjection(13, 'https://foo_bar/editor');

    expect(dotted.id).not.toBe(underscored.id);
    expect(dotted.id).toMatch(/^mcp_we_props_early_foo_bar_[a-f0-9]{24}$/);
    expect(underscored.id).toMatch(/^mcp_we_props_early_foo_bar_[a-f0-9]{24}$/);
    expect(registeredScripts.get(dotted.id)?.matches).toEqual(['*://foo.bar/*']);
    expect(registeredScripts.get(underscored.id)?.matches).toEqual(['*://foo_bar/*']);
  });

  it('releases the old host after tab A crosses sites so tab B no longer receives it', async () => {
    const { registerPropsAgentEarlyInjection, reconcilePropsAgentEarlyInjectionNavigation } =
      await import('@/entrypoints/background/web-editor/props-early-injection');

    const registration = await registerPropsAgentEarlyInjection(
      12,
      'https://old.example/editor',
    );
    const released = await reconcilePropsAgentEarlyInjectionNavigation(
      12,
      'https://new.example/page',
    );

    expect(released).toBe(true);
    expect(sessionData['web-editor-props-early-tab-12']).toBeUndefined();
    expect(unregisterContentScripts).toHaveBeenCalledWith({ ids: [registration.id] });
    expect(registeredScripts.has(registration.id)).toBe(false);
    expect(
      Array.from(registeredScripts.values()).some((script) =>
        script.matches?.includes('*://old.example/*'),
      ),
    ).toBe(false);
  });

  it('retains registration across same-host navigation and refreshes the normalized origin', async () => {
    const { registerPropsAgentEarlyInjection, reconcilePropsAgentEarlyInjectionNavigation } =
      await import('@/entrypoints/background/web-editor/props-early-injection');

    const registration = await registerPropsAgentEarlyInjection(
      12,
      'https://Example.COM/editor',
    );
    const released = await reconcilePropsAgentEarlyInjectionNavigation(
      12,
      'http://example.com:8080/next',
    );

    expect(released).toBe(false);
    expect(unregisterContentScripts).not.toHaveBeenCalled();
    expect(registeredScripts.has(registration.id)).toBe(true);
    expect(storedRegistration(12)).toEqual({
      version: 1,
      registrationId: registration.id,
      host: 'example.com',
      origin: 'http://example.com:8080',
    });
  });

  it('migrates the legacy tab-to-registrationId schema on a same-host commit', async () => {
    const { registerPropsAgentEarlyInjection, reconcilePropsAgentEarlyInjectionNavigation } =
      await import('@/entrypoints/background/web-editor/props-early-injection');

    const registration = await registerPropsAgentEarlyInjection(12, 'https://legacy.example/a');
    sessionData['web-editor-props-early-tab-12'] = registration.id;

    await reconcilePropsAgentEarlyInjectionNavigation(12, 'https://legacy.example/b');

    expect(unregisterContentScripts).not.toHaveBeenCalled();
    expect(storedRegistration(12)).toEqual({
      version: 1,
      registrationId: registration.id,
      host: 'legacy.example',
      origin: 'https://legacy.example',
    });
  });

  it('keeps a shared registration until every editor tab leaves the host', async () => {
    const { registerPropsAgentEarlyInjection, reconcilePropsAgentEarlyInjectionNavigation } =
      await import('@/entrypoints/background/web-editor/props-early-injection');

    const registration = await registerPropsAgentEarlyInjection(12, 'https://shared.example/a');
    await registerPropsAgentEarlyInjection(13, 'https://shared.example/b');

    await reconcilePropsAgentEarlyInjectionNavigation(12, 'https://other.example/a');
    expect(unregisterContentScripts).not.toHaveBeenCalled();
    expect(registeredScripts.has(registration.id)).toBe(true);

    await reconcilePropsAgentEarlyInjectionNavigation(13, 'chrome://settings/');
    expect(unregisterContentScripts).toHaveBeenCalledWith({ ids: [registration.id] });
    expect(registeredScripts.has(registration.id)).toBe(false);
  });

  it('restores persisted ownership after a service-worker restart', async () => {
    tabsById.set(12, {
      id: 12,
      url: 'https://restart.example/current',
    } as chrome.tabs.Tab);
    const firstWorker = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );
    const registration = await firstWorker.registerPropsAgentEarlyInjection(
      12,
      'https://restart.example/editor',
    );

    vi.resetModules();
    const restartedWorker = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );
    restartedWorker.initPropsAgentEarlyInjectionNavigationLifecycle();
    await restartedWorker.pruneOrphanedPropsAgentEarlyInjections();

    expect(addNavigationListener).toHaveBeenCalledOnce();
    expect(unregisterContentScripts).not.toHaveBeenCalled();
    expect(storedRegistration(12)).toEqual({
      version: 1,
      registrationId: registration.id,
      host: 'restart.example',
      origin: 'https://restart.example',
    });
    expect(registeredScripts.has(registration.id)).toBe(true);

    await restartedWorker.reconcilePropsAgentEarlyInjectionNavigation(
      12,
      'https://after-restart.example/',
    );
    expect(unregisterContentScripts).toHaveBeenCalledWith({ ids: [registration.id] });
  });

  it('registers the top-level navigation listener once per worker instance', async () => {
    const { initPropsAgentEarlyInjectionNavigationLifecycle } = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );

    initPropsAgentEarlyInjectionNavigationLifecycle();
    initPropsAgentEarlyInjectionNavigationLifecycle();

    expect(addNavigationListener).toHaveBeenCalledOnce();
    expect(addNavigationListener).toHaveBeenCalledWith(expect.any(Function));
    expect(addTabReplacedListener).toHaveBeenCalledOnce();
    expect(addTabReplacedListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it('ignores subframe commits and releases only on a top-frame cross-host commit', async () => {
    const propsInjection = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );
    const registration = await propsInjection.registerPropsAgentEarlyInjection(
      12,
      'https://frames.example/editor',
    );
    propsInjection.initPropsAgentEarlyInjectionNavigationLifecycle();
    const listener = addNavigationListener.mock.calls[0]?.[0] as
      | ((details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => void)
      | undefined;

    listener?.({
      tabId: 12,
      frameId: 3,
      url: 'https://cross-host.example/frame',
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    expect(storedRegistration(12).registrationId).toBe(registration.id);
    expect(unregisterContentScripts).not.toHaveBeenCalled();

    listener?.({
      tabId: 12,
      frameId: 0,
      url: 'https://cross-host.example/top',
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    // Queue behind the listener's async reconciliation to await completion.
    await propsInjection.reconcilePropsAgentEarlyInjectionNavigation(
      12,
      'https://cross-host.example/top',
    );
    expect(sessionData['web-editor-props-early-tab-12']).toBeUndefined();
    expect(unregisterContentScripts).toHaveBeenCalledWith({ ids: [registration.id] });
  });

  it('releases ownership when Chrome replaces the tab document', async () => {
    const propsInjection = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );
    const registration = await propsInjection.registerPropsAgentEarlyInjection(
      12,
      'https://replace.example/editor',
    );
    propsInjection.initPropsAgentEarlyInjectionNavigationLifecycle();
    const listener = addTabReplacedListener.mock.calls[0]?.[0] as
      | ((details: chrome.webNavigation.WebNavigationReplacementCallbackDetails) => void)
      | undefined;

    listener?.({ tabId: 99, replacedTabId: 12, timeStamp: Date.now() });
    // Queue a no-op reconciliation behind the listener's release operation.
    await propsInjection.reconcilePropsAgentEarlyInjectionNavigation(
      12,
      'https://replace.example/after',
    );

    expect(sessionData['web-editor-props-early-tab-12']).toBeUndefined();
    expect(unregisterContentScripts).toHaveBeenCalledWith({ ids: [registration.id] });
  });

  it('prunes orphaned managed registrations without touching unrelated scripts', async () => {
    tabsById.set(21, {
      id: 21,
      url: 'https://kept.example/current',
    } as chrome.tabs.Tab);
    registeredScripts.set('mcp_we_props_early_orphan_example', {
      id: 'mcp_we_props_early_orphan_example',
      matches: ['*://orphan.example/*'],
      js: ['inject-scripts/props-agent.js'],
    });
    registeredScripts.set('unrelated-script', {
      id: 'unrelated-script',
      matches: ['<all_urls>'],
      js: ['unrelated.js'],
    });

    const { pruneOrphanedPropsAgentEarlyInjections, registerPropsAgentEarlyInjection } = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );
    const kept = await registerPropsAgentEarlyInjection(21, 'https://kept.example/editor');
    await pruneOrphanedPropsAgentEarlyInjections();

    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: ['mcp_we_props_early_orphan_example'],
    });
    expect(registeredScripts.has(kept.id)).toBe(true);
    expect(registeredScripts.has('unrelated-script')).toBe(true);
  });
});
