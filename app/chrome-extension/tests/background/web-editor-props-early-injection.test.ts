import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Web Editor props early injection registry', () => {
  let sessionData: Record<string, unknown>;
  let registeredScripts: Map<string, chrome.scripting.RegisteredContentScript>;
  let unregisterContentScripts: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    sessionData = {};
    registeredScripts = new Map();
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
  });

  it('registers only for the current browser session and records the requesting tab', async () => {
    const { registerPropsAgentEarlyInjection } = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );

    const result = await registerPropsAgentEarlyInjection(12, 'https://example.com/editor');

    expect(result.id).toBe('mcp_we_props_early_example_com');
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: result.id,
        matches: ['*://example.com/*'],
        world: 'MAIN',
        runAt: 'document_start',
        persistAcrossSessions: false,
      }),
    ]);
    expect(sessionData['web-editor-props-early-tab-12']).toBe(result.id);
  });

  it('keeps a shared host registration until the final editor tab releases it', async () => {
    const { registerPropsAgentEarlyInjection, releasePropsAgentEarlyInjection } = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );

    await registerPropsAgentEarlyInjection(12, 'https://example.com/one');
    await registerPropsAgentEarlyInjection(13, 'https://example.com/two');
    await releasePropsAgentEarlyInjection(12);

    expect(unregisterContentScripts).not.toHaveBeenCalled();
    expect(registeredScripts.has('mcp_we_props_early_example_com')).toBe(true);

    await releasePropsAgentEarlyInjection(13);

    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: ['mcp_we_props_early_example_com'],
    });
    expect(registeredScripts.has('mcp_we_props_early_example_com')).toBe(false);
  });

  it('prunes orphaned legacy registrations without touching unrelated scripts', async () => {
    registeredScripts.set('mcp_we_props_early_kept_example', {
      id: 'mcp_we_props_early_kept_example',
      matches: ['*://kept.example/*'],
      js: ['inject-scripts/props-agent.js'],
    });
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
    sessionData['web-editor-props-early-tab-21'] = 'mcp_we_props_early_kept_example';

    const { pruneOrphanedPropsAgentEarlyInjections } = await import(
      '@/entrypoints/background/web-editor/props-early-injection'
    );
    await pruneOrphanedPropsAgentEarlyInjections();

    expect(unregisterContentScripts).toHaveBeenCalledWith({
      ids: ['mcp_we_props_early_orphan_example'],
    });
    expect(registeredScripts.has('mcp_we_props_early_kept_example')).toBe(true);
    expect(registeredScripts.has('unrelated-script')).toBe(true);
  });
});
