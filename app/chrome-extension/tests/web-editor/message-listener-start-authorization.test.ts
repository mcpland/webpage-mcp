import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  WEB_EDITOR_ACTIONS,
  type WebEditorApi,
} from "@/common/web-editor-types";
import { handleWebEditorCommand } from "@/entrypoints/web-editor/core/message-listener";

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

vi.mock("@/utils/privileged-ui-authorization", () => surfaceMocks);

describe("Web Editor start authorization lifecycle", () => {
  let active: boolean;
  let stopping: boolean;
  let activeSurfaceSessionId: string | null;
  let api: WebEditorApi;

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
  });

  function startRequest(surfaceSessionId = "22".repeat(32)) {
    return {
      action: WEB_EDITOR_ACTIONS.START,
      privilegedSurfaceSessionId: surfaceSessionId,
    };
  }

  it("reports inactive and closes the background surface when editor initialization fails", async () => {
    await expect(handleWebEditorCommand(api, startRequest())).resolves.toEqual({
      active: false,
    });

    expect(api.start).toHaveBeenCalledWith("22".repeat(32));
    expect(surfaceMocks.closePrivilegedUiSurfaceSession).toHaveBeenCalledOnce();
  });

  it("reports active only after the editor state confirms successful initialization", async () => {
    vi.mocked(api.start).mockImplementation(() => {
      active = true;
    });
    await expect(handleWebEditorCommand(api, startRequest())).resolves.toEqual({
      active: true,
    });
    expect(surfaceMocks.closePrivilegedUiSurfaceSession).not.toHaveBeenCalled();
  });

  it("closes a configured background surface even when STOP finds the editor inactive", async () => {
    await expect(
      handleWebEditorCommand(api, { action: WEB_EDITOR_ACTIONS.STOP }),
    ).resolves.toEqual({ active: false });
    expect(surfaceMocks.closePrivilegedUiSurfaceSession).toHaveBeenCalledOnce();
  });

  it("treats START for the already active session as idempotent", async () => {
    const sessionId = "11".repeat(32);
    active = true;
    activeSurfaceSessionId = sessionId;
    await expect(
      handleWebEditorCommand(api, startRequest(sessionId)),
    ).resolves.toEqual({
      active: true,
    });
    expect(
      surfaceMocks.configurePrivilegedUiSurfaceSession,
    ).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it("rejects START from a different session without overwriting the active one", async () => {
    const activeSessionId = "11".repeat(32);
    const replacementSessionId = "33".repeat(32);
    active = true;
    activeSurfaceSessionId = activeSessionId;
    await expect(
      handleWebEditorCommand(api, startRequest(replacementSessionId)),
    ).resolves.toEqual({
      active: false,
      error: "A different Web Editor session is already active",
    });
    expect(surfaceMocks.clearPrivilegedUiSurfaceSession).not.toHaveBeenCalled();
    expect(
      surfaceMocks.configurePrivilegedUiSurfaceSession,
    ).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(activeSurfaceSessionId).toBe(activeSessionId);
  });

  it("rejects START and TOGGLE while stop cleanup is in flight", async () => {
    stopping = true;
    activeSurfaceSessionId = "11".repeat(32);
    await expect(
      handleWebEditorCommand(api, startRequest("33".repeat(32))),
    ).resolves.toEqual({
      active: false,
      error: "Web Editor is still stopping",
    });
    await expect(
      handleWebEditorCommand(api, {
        action: WEB_EDITOR_ACTIONS.TOGGLE,
        privilegedSurfaceSessionId: "33".repeat(32),
      }),
    ).resolves.toEqual({
      active: false,
      error: "Web Editor is still stopping",
    });
    expect(surfaceMocks.clearPrivilegedUiSurfaceSession).not.toHaveBeenCalled();
    expect(
      surfaceMocks.configurePrivilegedUiSurfaceSession,
    ).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
  });

  it("reports stopping as active so the background cannot inject a second editor", async () => {
    stopping = true;
    await expect(
      handleWebEditorCommand(api, { action: WEB_EDITOR_ACTIONS.PING }),
    ).resolves.toEqual({
      status: "pong",
      active: true,
      version: 1,
    });
  });
});
