import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  USER_SCRIPT_EXECUTION_LIMITS,
  executeUserScript,
  listRegisteredUserScripts,
  unregisterUserScripts,
  upsertRegisteredUserScript,
} from '@/utils/user-script-executor';

describe('user script executor', () => {
  const execute = vi.fn();
  const getScripts = vi.fn();
  const register = vi.fn();
  const unregister = vi.fn();
  const update = vi.fn();

  beforeEach(() => {
    execute.mockResolvedValue([{ documentId: 'document-1', frameId: 0, result: 'ok' }]);
    getScripts.mockResolvedValue([]);
    register.mockResolvedValue(undefined);
    unregister.mockResolvedValue(undefined);
    update.mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      userScripts: { execute, getScripts, register, unregister, update },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('executes bounded code in the requested world without enabling extension messaging', async () => {
    const first = await executeUserScript({
      tabId: 7,
      code: 'document.title',
      world: 'USER_SCRIPT',
    });
    await executeUserScript({
      tabId: 8,
      code: 'location.href',
      world: 'USER_SCRIPT',
    });

    expect(execute).toHaveBeenNthCalledWith(1, {
      target: { tabId: 7, allFrames: undefined, frameIds: undefined },
      world: 'USER_SCRIPT',
      injectImmediately: true,
      js: [{ code: 'document.title' }],
    });
    expect(first[0]?.result).toBe('ok');
  });

  it('fails closed for invalid targets, oversized code, and Chrome errors', async () => {
    await expect(
      executeUserScript({
        tabId: 7,
        code: '1',
        allFrames: true,
        frameIds: [0],
      }),
    ).rejects.toThrow('cannot combine');
    await expect(
      executeUserScript({
        tabId: 7,
        code: 'x'.repeat(USER_SCRIPT_EXECUTION_LIMITS.maxCodeBytes + 1),
      }),
    ).rejects.toThrow('byte limit');

    execute.mockResolvedValueOnce([
      {
        documentId: 'document-1',
        frameId: 0,
        error: 'blocked',
        result: undefined,
      },
    ]);
    await expect(executeUserScript({ tabId: 7, code: '1' })).rejects.toThrow('blocked');
  });

  it('registers, updates, lists, and unregisters bounded user scripts', async () => {
    const script: chrome.userScripts.RegisteredUserScript = {
      id: 'us_123',
      matches: ['https://example.com/*'],
      excludeMatches: ['https://example.com/private/*'],
      js: [{ code: 'globalThis.enabled = true;' }],
      runAt: 'document_idle',
      world: 'USER_SCRIPT',
    };

    await upsertRegisteredUserScript(script);
    expect(register).toHaveBeenCalledWith([script]);

    getScripts.mockResolvedValueOnce([script]);
    await upsertRegisteredUserScript({ ...script, runAt: 'document_start' });
    expect(update).toHaveBeenCalledWith([{ ...script, runAt: 'document_start' }]);

    getScripts.mockResolvedValueOnce([script]);
    await expect(listRegisteredUserScripts()).resolves.toEqual([script]);
    await unregisterUserScripts(['us_123']);
    expect(unregister).toHaveBeenCalledWith({ ids: ['us_123'] });
  });

  it('explains how to enable the API when Chrome hides it', async () => {
    vi.stubGlobal('chrome', {});

    await expect(executeUserScript({ tabId: 7, code: '1' })).rejects.toThrow(
      'enable Allow User Scripts',
    );
  });
});
