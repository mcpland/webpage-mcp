import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKGROUND_MESSAGE_TYPES,
  PRIVILEGED_UI_ACTIONS,
  PRIVILEGED_UI_SURFACES,
} from '@/common/message-types';

const STORAGE_KEY = 'privileged-ui-active-surfaces-v1';

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

function sender(documentId = 'document-a'): chrome.runtime.MessageSender {
  return {
    id: chrome.runtime.id,
    tab: { id: 17 } as chrome.tabs.Tab,
    frameId: 0,
    documentId,
  };
}

describe('privileged UI surface listener', () => {
  let listener: RuntimeListener;
  let tabRemovedListener: (tabId: number) => void;
  let sessionData: Record<string, unknown>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionData = {};
    chrome.storage.session = {
      get: vi.fn(async (key: string | string[] | null) => {
        if (typeof key === 'string') return { [key]: sessionData[key] };
        if (Array.isArray(key)) {
          return Object.fromEntries(
            key.map((item) => [item, sessionData[item]]),
          );
        }
        return { ...sessionData };
      }),
      set: vi.fn(async (values: Record<string, unknown>) => {
        Object.assign(sessionData, values);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys])
          delete sessionData[key];
      }),
    } as unknown as typeof chrome.storage.session;
    vi.mocked(chrome.tabs.onRemoved.addListener).mockImplementation(
      (candidate) => {
        tabRemovedListener = candidate as (tabId: number) => void;
      },
    );
    captureNextWorkerListener();
  });

  function captureNextWorkerListener(): void {
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(
      (candidate) => {
        listener = candidate as RuntimeListener;
      },
    );
  }

  async function sendRuntime(
    message: unknown,
    source = sender(),
  ): Promise<Record<string, unknown>> {
    const sendResponse = vi.fn();
    expect(listener(message, source, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    return sendResponse.mock.calls[0]![0] as Record<string, unknown>;
  }

  function authorizeMessage(surfaceSessionId: string) {
    return {
      type: BACKGROUND_MESSAGE_TYPES.PRIVILEGED_UI_AUTHORIZE,
      payload: {
        action: PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
        surface: PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        surfaceSessionId,
      },
    };
  }

  function closeMessage(surfaceSessionId: string) {
    return {
      type: BACKGROUND_MESSAGE_TYPES.PRIVILEGED_UI_SURFACE_CLOSE,
      payload: {
        surface: PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        surfaceSessionId,
      },
    };
  }

  async function loadWorker() {
    captureNextWorkerListener();
    const authorization =
      await import('@/entrypoints/background/privileged-ui-authorization');
    authorization.initPrivilegedUiAuthorization();
    return authorization;
  }

  it('hydrates the active session after worker restart and preserves close/document boundaries', async () => {
    const firstWorker = await loadWorker();
    const firstSessionId = await firstWorker.startPrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      17,
    );
    expect(await sendRuntime(authorizeMessage(firstSessionId))).toMatchObject({
      success: true,
    });

    vi.resetModules();
    const restartedWorker = await loadWorker();
    expect(
      await sendRuntime(authorizeMessage(firstSessionId), sender('document-b')),
    ).toEqual({
      success: false,
      error: 'Privileged action authorization denied',
    });
    expect(await sendRuntime(authorizeMessage(firstSessionId))).toMatchObject({
      success: true,
    });

    const rotatedSessionId =
      await restartedWorker.startPrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        17,
      );
    expect(await sendRuntime(authorizeMessage(firstSessionId))).toEqual({
      success: false,
      error: 'Privileged action authorization denied',
    });
    expect(await sendRuntime(authorizeMessage(rotatedSessionId))).toMatchObject(
      { success: true },
    );
    expect(
      await sendRuntime(closeMessage(rotatedSessionId), sender('document-b')),
    ).toEqual({
      success: false,
    });
    expect(await sendRuntime(closeMessage(rotatedSessionId))).toEqual({
      success: true,
    });

    vi.resetModules();
    await loadWorker();
    expect(await sendRuntime(authorizeMessage(rotatedSessionId))).toEqual({
      success: false,
      error: 'Privileged action authorization denied',
    });
  });

  it('serializes initial hydration before activation so stale reads cannot overwrite a new session', async () => {
    const staleSessionId = 'aa'.repeat(32);
    let resolveHydration!: (value: Record<string, unknown>) => void;
    vi.mocked(chrome.storage.session.get).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHydration = resolve;
        }),
    );
    const worker = await loadWorker();
    const activation = worker.startPrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      17,
    );
    await vi.waitFor(() =>
      expect(chrome.storage.session.get).toHaveBeenCalled(),
    );
    resolveHydration({
      [STORAGE_KEY]: {
        version: 1,
        sessions: [
          {
            surface: PRIVILEGED_UI_SURFACES.WEB_EDITOR,
            surfaceSessionId: staleSessionId,
            tabId: 17,
            documentId: 'document-a',
          },
        ],
      },
    });
    const newSessionId = await activation;

    const persisted = sessionData[STORAGE_KEY] as {
      sessions: Array<{ surfaceSessionId: string }>;
    };
    expect(persisted.sessions).toEqual([
      expect.objectContaining({ surfaceSessionId: newSessionId }),
    ]);
    expect(await sendRuntime(authorizeMessage(staleSessionId))).toEqual({
      success: false,
      error: 'Privileged action authorization denied',
    });
    expect(await sendRuntime(authorizeMessage(newSessionId))).toMatchObject({
      success: true,
    });
  });

  it('persists only the first document binding during repeated surface validation', async () => {
    const worker = await loadWorker();
    const sessionId = await worker.startPrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      17,
    );
    vi.mocked(chrome.storage.session.set).mockClear();

    await expect(
      worker.validatePrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        sessionId,
        sender(),
      ),
    ).resolves.toBe(true);
    expect(chrome.storage.session.set).toHaveBeenCalledTimes(1);

    await expect(
      worker.validatePrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        sessionId,
        sender(),
      ),
    ).resolves.toBe(true);
    expect(chrome.storage.session.set).toHaveBeenCalledTimes(1);
  });

  it('does not let stale cleanup delete a rotated surface session', async () => {
    const worker = await loadWorker();
    const staleSessionId = await worker.startPrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      17,
    );
    const currentSessionId = await worker.startPrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      17,
    );

    await expect(
      worker.stopPrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        17,
        staleSessionId,
      ),
    ).resolves.toBe(false);
    await expect(
      worker.validatePrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        currentSessionId,
        sender(),
      ),
    ).resolves.toBe(true);
  });

  it('rolls back activation, first binding, and stop when persistence fails', async () => {
    const worker = await loadWorker();
    const sessionId = await worker.startPrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      17,
    );

    vi.mocked(chrome.storage.session.set).mockRejectedValueOnce(
      new Error('activation persistence failed'),
    );
    await expect(
      worker.startPrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        17,
      ),
    ).rejects.toThrow('activation persistence failed');
    await expect(
      worker.validatePrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        sessionId,
        sender(),
      ),
    ).resolves.toBe(true);

    const unboundSessionId = await worker.startPrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      17,
    );
    vi.mocked(chrome.storage.session.set).mockRejectedValueOnce(
      new Error('binding persistence failed'),
    );
    await expect(
      worker.validatePrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        unboundSessionId,
        sender('document-a'),
      ),
    ).rejects.toThrow('binding persistence failed');
    await expect(
      worker.validatePrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        unboundSessionId,
        sender('document-b'),
      ),
    ).resolves.toBe(true);

    vi.mocked(chrome.storage.session.set).mockRejectedValueOnce(
      new Error('stop persistence failed'),
    );
    await expect(
      worker.stopPrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        17,
        unboundSessionId,
      ),
    ).rejects.toThrow('stop persistence failed');
    await expect(
      worker.validatePrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        unboundSessionId,
        sender('document-b'),
      ),
    ).resolves.toBe(true);
  });

  it('persists tab-removal revocation across a worker restart', async () => {
    const firstWorker = await loadWorker();
    const sessionId = await firstWorker.startPrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      17,
    );
    await firstWorker.validatePrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      sessionId,
      sender(),
    );
    vi.mocked(chrome.storage.session.set).mockClear();

    tabRemovedListener(17);
    await vi.waitFor(() => expect(chrome.storage.session.set).toHaveBeenCalled());
    expect(sessionData[STORAGE_KEY]).toEqual({ version: 1, sessions: [] });

    vi.resetModules();
    const restartedWorker = await loadWorker();
    await expect(
      restartedWorker.validatePrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        sessionId,
        sender(),
      ),
    ).resolves.toBe(false);
  });
});
