import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

const TAB = {
  id: 7,
  index: 0,
  windowId: 2,
  active: true,
  status: 'complete',
  url: 'https://example.com/page',
} as chrome.tabs.Tab;

describe('userscript command routing', () => {
  let runtimeListeners: RuntimeListener[];
  let storage: Record<string, any>;
  let storageChangeListeners: Array<
    (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void
  >;
  let registeredScripts: Map<string, chrome.userScripts.RegisteredUserScript>;
  let userscriptTool: typeof import('@/entrypoints/background/tools/browser/userscript').userscriptTool;

  const dispatchRuntimeMessage = async (message: any): Promise<any> => {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const sendResponse = (response: any) => {
        if (settled) return;
        settled = true;
        resolve(response);
      };

      for (const listener of [...runtimeListeners]) {
        listener(message, {} as chrome.runtime.MessageSender, sendResponse);
      }

      setTimeout(() => {
        if (!settled) reject(new Error('No userscript handled the command.'));
      }, 0);
    });
  };

  const parseResult = (result: Awaited<ReturnType<typeof userscriptTool.execute>>) => {
    return JSON.parse(String((result.content[0] as { text?: string }).text || '{}'));
  };

  const createScript = async (name: string, world: 'ISOLATED' | 'MAIN', script: string) => {
    const result = await userscriptTool.execute({
      action: 'create',
      args: {
        name,
        world,
        script,
        matches: ['<all_urls>'],
        allFrames: false,
      },
    });
    expect(result.isError).toBe(false);
    return parseResult(result).id as string;
  };

  const sendCommand = async (id: string, payload: string) => {
    const result = await userscriptTool.execute({
      action: 'send_command',
      args: { id, tabId: TAB.id, payload },
    });
    return { result, body: result.isError ? null : parseResult(result) };
  };

  beforeEach(async () => {
    vi.resetModules();
    runtimeListeners = [];
    storage = {};
    storageChangeListeners = [];
    registeredScripts = new Map();

    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: RuntimeListener) => runtimeListeners.push(listener)),
          removeListener: vi.fn((listener: RuntimeListener) => {
            runtimeListeners = runtimeListeners.filter((candidate) => candidate !== listener);
          }),
        },
      },
      storage: {
        onChanged: {
          addListener: vi.fn((listener) => storageChangeListeners.push(listener)),
        },
        local: {
          get: vi.fn(async (keys: string[]) =>
            Object.fromEntries(
              keys.filter((key) => key in storage).map((key) => [key, storage[key]]),
            ),
          ),
          set: vi.fn(async (values: Record<string, any>) => Object.assign(storage, values)),
        },
      },
      tabs: {
        get: vi.fn(async () => TAB),
        query: vi.fn(async () => [TAB]),
        sendMessage: vi.fn((_tabId: number, message: any) => dispatchRuntimeMessage(message)),
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      webNavigation: {
        onCommitted: { addListener: vi.fn() },
        onDOMContentLoaded: { addListener: vi.fn() },
      },
      scripting: {
        insertCSS: vi.fn(async () => undefined),
        removeCSS: vi.fn(async () => undefined),
        executeScript: vi.fn(async (details: chrome.scripting.ScriptInjection<any[], any>) => {
          if ('files' in details) {
            // @ts-expect-error The browser-injected bridge intentionally has no TypeScript declaration.
            await import('@/inject-scripts/inject-bridge.js');
            return [];
          }
          const args = 'args' in details && details.args ? details.args : [];
          const result = await details.func!(...args);
          return [{ frameId: 0, result }];
        }),
      },
      userScripts: {
        configureWorld: vi.fn(async () => undefined),
        execute: vi.fn(async (details: chrome.userScripts.UserScriptInjection) => {
          const source = details.js[0]?.code || '';
          const result = window.eval(source);
          return [{ documentId: 'document-1', frameId: 0, result }];
        }),
        getScripts: vi.fn(async (filter?: chrome.userScripts.UserScriptFilter) => {
          const scripts = [...registeredScripts.values()];
          return filter?.ids
            ? scripts.filter((script) => filter.ids?.includes(script.id))
            : scripts;
        }),
        register: vi.fn(async (scripts: chrome.userScripts.RegisteredUserScript[]) => {
          for (const script of scripts) registeredScripts.set(script.id, script);
        }),
        update: vi.fn(async (scripts: chrome.userScripts.RegisteredUserScript[]) => {
          for (const script of scripts) registeredScripts.set(script.id, script);
        }),
        unregister: vi.fn(async (filter?: chrome.userScripts.UserScriptFilter) => {
          for (const id of filter?.ids || [...registeredScripts.keys()]) {
            registeredScripts.delete(id);
          }
        }),
      },
    });

    ({ userscriptTool } = await import('@/entrypoints/background/tools/browser/userscript'));
  });

  afterEach(() => {
    window.dispatchEvent(new CustomEvent('webpage-mcp:cleanup'));
    delete (window as any).__WEBPAGE_MCP_MAIN_USERSCRIPT_REGISTRY__;
    delete (globalThis as any).__WEBPAGE_MCP_ISOLATED_USERSCRIPT_REGISTRY__;
    delete (window as any).__userscriptRoutingCalls;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('routes ISOLATED commands to only the matching script and disposes old handlers', async () => {
    (globalThis as any).__userscriptRoutingCalls = { first: 0, second: 0 };
    const firstId = await createScript(
      'isolated-first',
      'ISOLATED',
      `globalThis.__userscript_onCommand__ = (_action, payload) => {
        globalThis.__userscriptRoutingCalls.first += 1;
        return 'first:' + payload;
      };`,
    );
    const secondId = await createScript(
      'isolated-second',
      'ISOLATED',
      `globalThis.__userscript_onCommand__ = (_action, payload) => {
        globalThis.__userscriptRoutingCalls.second += 1;
        return 'second:' + payload;
      };`,
    );

    expect(registeredScripts.get(firstId)).toEqual(
      expect.objectContaining({
        id: firstId,
        matches: ['<all_urls>'],
        world: 'USER_SCRIPT',
      }),
    );
    expect(registeredScripts.get(firstId)?.js[0]?.code).not.toMatch(
      /\beval\s*\(|new\s+Function\s*\(/,
    );

    expect((await sendCommand(firstId, 'a')).body.result).toEqual({ data: 'first:a' });
    expect((globalThis as any).__userscriptRoutingCalls).toEqual({ first: 1, second: 0 });
    expect((await sendCommand(secondId, 'b')).body.result).toEqual({ data: 'second:b' });
    expect((globalThis as any).__userscriptRoutingCalls).toEqual({ first: 1, second: 1 });

    await userscriptTool.execute({
      action: 'update',
      args: {
        id: firstId,
        script: `globalThis.__userscript_onCommand__ = (_action, payload) => {
          globalThis.__userscriptRoutingCalls.first += 10;
          return 'updated:' + payload;
        };`,
      },
    });

    expect((await sendCommand(firstId, 'c')).body.result).toEqual({ data: 'updated:c' });
    expect((globalThis as any).__userscriptRoutingCalls).toEqual({ first: 11, second: 1 });

    await userscriptTool.execute({ action: 'disable', args: { id: firstId } });
    expect(registeredScripts.has(firstId)).toBe(false);
    expect((await sendCommand(firstId, 'disabled')).result.isError).toBe(true);

    await userscriptTool.execute({ action: 'remove', args: { id: secondId } });
    expect(registeredScripts.has(secondId)).toBe(false);
    expect((await sendCommand(secondId, 'removed')).result.isError).toBe(true);
  });

  it('routes MAIN commands through the bridge to only the matching script once', async () => {
    (window as any).__userscriptRoutingCalls = { first: 0, second: 0 };
    const firstId = await createScript(
      'main-first',
      'MAIN',
      `window.__userscript_onCommand = (_action, payload) => {
        window.__userscriptRoutingCalls.first += 1;
        return 'main-first:' + payload;
      };`,
    );
    const secondId = await createScript(
      'main-second',
      'MAIN',
      `window.__userscript_onCommand = (_action, payload) => {
        window.__userscriptRoutingCalls.second += 1;
        return 'main-second:' + payload;
      };`,
    );

    expect(registeredScripts.get(firstId)?.world).toBe('MAIN');
    expect(registeredScripts.get(firstId)?.js[0]?.code).not.toMatch(
      /\beval\s*\(|new\s+Function\s*\(/,
    );

    expect((await sendCommand(firstId, 'a')).body.result).toEqual({ data: 'main-first:a' });
    expect((window as any).__userscriptRoutingCalls).toEqual({ first: 1, second: 0 });
    expect((await sendCommand(secondId, 'b')).body.result).toEqual({ data: 'main-second:b' });
    expect((window as any).__userscriptRoutingCalls).toEqual({ first: 1, second: 1 });
  });

  it('unregisters and cleans scripts while the emergency switch is enabled', async () => {
    (globalThis as any).__userscriptRoutingCalls = { first: 0 };
    const id = await createScript(
      'emergency-script',
      'ISOLATED',
      `globalThis.__userscript_onCommand__ = () => {
        globalThis.__userscriptRoutingCalls.first += 1;
        return 'enabled';
      };`,
    );
    expect(registeredScripts.has(id)).toBe(true);

    storage.userscripts_disabled = true;
    for (const listener of storageChangeListeners) {
      listener({ userscripts_disabled: { oldValue: false, newValue: true } }, 'local');
    }
    await vi.waitFor(() => expect(registeredScripts.has(id)).toBe(false));
    expect((await sendCommand(id, 'disabled')).result.isError).toBe(true);

    storage.userscripts_disabled = false;
    for (const listener of storageChangeListeners) {
      listener({ userscripts_disabled: { oldValue: true, newValue: false } }, 'local');
    }
    await vi.waitFor(() => expect(registeredScripts.has(id)).toBe(true));
    expect((await sendCommand(id, 'enabled')).body.result).toEqual({ data: 'enabled' });
  });
});
