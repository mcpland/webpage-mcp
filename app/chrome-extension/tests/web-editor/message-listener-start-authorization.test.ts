import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WEB_EDITOR_ACTIONS,
  type WebEditorApi,
} from '@/common/web-editor-types';
import { installMessageListener } from '@/entrypoints/web-editor/core/message-listener';

const surfaceMocks = vi.hoisted(() => ({
  clearPrivilegedUiSurfaceSession: vi.fn(),
  closePrivilegedUiSurfaceSession: vi.fn().mockResolvedValue(true),
  configurePrivilegedUiSurfaceSession: vi.fn(
    (_surface: unknown, _surfaceSessionId: string) => true,
  ),
  matchesPrivilegedUiSurfaceSession: vi.fn(
    (_surface: unknown, _surfaceSessionId: string) => false,
  ),
}));

vi.mock('@/utils/privileged-ui-authorization', () => surfaceMocks);

type RuntimeListener = (
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

describe('Web Editor start authorization lifecycle', () => {
  let listener: RuntimeListener;
  let active: boolean;
  let stopping: boolean;
  let activeSurfaceSessionId: string | null;
  let api: WebEditorApi;
  let removeListener: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    active = false;
    stopping = false;
    activeSurfaceSessionId = null;
    surfaceMocks.configurePrivilegedUiSurfaceSession.mockImplementation(
      (_surface, surfaceSessionId) => {
        activeSurfaceSessionId = surfaceSessionId;
        return true;
      },
    );
    surfaceMocks.matchesPrivilegedUiSurfaceSession.mockImplementation(
      (_surface, surfaceSessionId) =>
        activeSurfaceSessionId === surfaceSessionId,
    );
    surfaceMocks.clearPrivilegedUiSurfaceSession.mockImplementation(() => {
      activeSurfaceSessionId = null;
    });
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(
      (candidate) => {
        listener = candidate as RuntimeListener;
      },
    );
    api = {
      start: vi.fn(),
      stop: vi.fn(async () => {
        active = false;
        await surfaceMocks.closePrivilegedUiSurfaceSession();
      }),
      toggle: vi.fn(() => active),
      getState: vi.fn(() => ({ active, stopping, version: 1 })),
      revertElement: vi.fn(),
      clearSelection: vi.fn(),
    } as WebEditorApi;
    removeListener = installMessageListener(api);
  });

  function startRequest(surfaceSessionId = '22'.repeat(32)) {
    return {
      action: WEB_EDITOR_ACTIONS.START,
      privilegedSurfaceSessionId: surfaceSessionId,
    };
  }

  it('reports inactive and closes the background surface when editor initialization fails', () => {
    const sendResponse = vi.fn();

    expect(listener(startRequest(), {}, sendResponse)).toBe(false);

    expect(api.start).toHaveBeenCalledWith('22'.repeat(32));
    expect(sendResponse).toHaveBeenCalledWith({ active: false });
    expect(surfaceMocks.closePrivilegedUiSurfaceSession).toHaveBeenCalledOnce();
    removeListener();
  });

  it('reports active only after the editor state confirms successful initialization', () => {
    vi.mocked(api.start).mockImplementation(() => {
      active = true;
    });
    const sendResponse = vi.fn();

    expect(listener(startRequest(), {}, sendResponse)).toBe(false);

    expect(sendResponse).toHaveBeenCalledWith({ active: true });
    expect(surfaceMocks.closePrivilegedUiSurfaceSession).not.toHaveBeenCalled();
    removeListener();
  });

  it('closes a configured background surface even when STOP finds the editor inactive', async () => {
    const sendResponse = vi.fn();

    expect(
      listener({ action: WEB_EDITOR_ACTIONS.STOP }, {}, sendResponse),
    ).toBe(true);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({ active: false });
    expect(surfaceMocks.closePrivilegedUiSurfaceSession).toHaveBeenCalledOnce();
    removeListener();
  });

  it('treats START for the already active session as idempotent', () => {
    const sessionId = '11'.repeat(32);
    active = true;
    activeSurfaceSessionId = sessionId;
    const sendResponse = vi.fn();

    expect(listener(startRequest(sessionId), {}, sendResponse)).toBe(false);

    expect(sendResponse).toHaveBeenCalledWith({ active: true });
    expect(surfaceMocks.configurePrivilegedUiSurfaceSession).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    removeListener();
  });

  it('rejects START from a different session without overwriting the active one', () => {
    const activeSessionId = '11'.repeat(32);
    const replacementSessionId = '33'.repeat(32);
    active = true;
    activeSurfaceSessionId = activeSessionId;
    const sendResponse = vi.fn();

    expect(listener(startRequest(replacementSessionId), {}, sendResponse)).toBe(false);

    expect(sendResponse).toHaveBeenCalledWith({
      active: false,
      error: 'A different Web Editor session is already active',
    });
    expect(surfaceMocks.clearPrivilegedUiSurfaceSession).not.toHaveBeenCalled();
    expect(surfaceMocks.configurePrivilegedUiSurfaceSession).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(activeSurfaceSessionId).toBe(activeSessionId);
    removeListener();
  });

  it('rejects START and TOGGLE while stop cleanup is in flight', () => {
    stopping = true;
    activeSurfaceSessionId = '11'.repeat(32);
    const startResponse = vi.fn();
    const toggleResponse = vi.fn();

    expect(listener(startRequest('33'.repeat(32)), {}, startResponse)).toBe(false);
    expect(
      listener(
        {
          action: WEB_EDITOR_ACTIONS.TOGGLE,
          privilegedSurfaceSessionId: '33'.repeat(32),
        },
        {},
        toggleResponse,
      ),
    ).toBe(false);

    expect(startResponse).toHaveBeenCalledWith({
      active: false,
      error: 'Web Editor is still stopping',
    });
    expect(toggleResponse).toHaveBeenCalledWith({
      active: false,
      error: 'Web Editor is still stopping',
    });
    expect(surfaceMocks.clearPrivilegedUiSurfaceSession).not.toHaveBeenCalled();
    expect(surfaceMocks.configurePrivilegedUiSurfaceSession).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    removeListener();
  });

  it('reports stopping as active so the background cannot inject a second editor', () => {
    stopping = true;
    const sendResponse = vi.fn();

    expect(
      listener({ action: WEB_EDITOR_ACTIONS.PING }, {}, sendResponse),
    ).toBe(false);

    expect(sendResponse).toHaveBeenCalledWith({
      status: 'pong',
      active: true,
      version: 1,
    });
    removeListener();
  });
});
