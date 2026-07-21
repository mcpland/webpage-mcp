import { beforeEach, describe, expect, it, vi } from "vitest";

import { PRIVILEGED_UI_SURFACES } from "@/common/message-types";

const authorizationMocks = vi.hoisted(() => ({
  startPrivilegedUiSurfaceSession: vi.fn(),
  stopPrivilegedUiSurfaceSession: vi.fn(),
}));

vi.mock(
  "@/entrypoints/background/privileged-ui-authorization",
  () => authorizationMocks,
);

describe("Quick Panel command surface queue", () => {
  let commandListener: (command: string) => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: "https://example.com/" } as chrome.tabs.Tab,
    ]);
    chrome.tabs.get = vi.fn(
      async () =>
        ({
          id: 7,
          url: "https://example.com/",
        }) as chrome.tabs.Tab,
    );
    chrome.tabs.sendMessage = vi.fn();
    vi.mocked(chrome.commands.onCommand.addListener).mockImplementation(
      (candidate) => {
        commandListener = candidate as (command: string) => Promise<void>;
      },
    );

    const { initQuickPanelCommands } =
      await import("@/entrypoints/background/quick-panel/commands");
    initQuickPanelCommands();
  });

  it("serializes same-tab toggles and cleans up only the session each attempt created", async () => {
    const firstSessionId = "a".repeat(64);
    const secondSessionId = "b".repeat(64);
    authorizationMocks.startPrivilegedUiSurfaceSession
      .mockResolvedValueOnce(firstSessionId)
      .mockResolvedValueOnce(secondSessionId);
    authorizationMocks.stopPrivilegedUiSurfaceSession.mockResolvedValue(true);
    let resolveFirstToggle!: (value: unknown) => void;
    const firstToggleResponse = new Promise((resolve) => {
      resolveFirstToggle = resolve;
    });
    vi.mocked(chrome.tabs.sendMessage)
      .mockReturnValueOnce(firstToggleResponse)
      .mockResolvedValueOnce({ success: true, visible: false });

    const first = commandListener("toggle_quick_panel");
    const second = commandListener("toggle_quick_panel");
    await vi.waitFor(() =>
      expect(chrome.tabs.sendMessage).toHaveBeenCalledOnce(),
    );
    expect(
      authorizationMocks.startPrivilegedUiSurfaceSession,
    ).toHaveBeenCalledOnce();

    resolveFirstToggle({ success: true, visible: true });
    await Promise.all([first, second]);

    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(
      1,
      7,
      {
        action: "toggle_quick_panel",
        privilegedSurfaceSessionId: firstSessionId,
      },
      { frameId: 0 },
    );
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(
      2,
      7,
      {
        action: "toggle_quick_panel",
        privilegedSurfaceSessionId: secondSessionId,
      },
      { frameId: 0 },
    );
    expect(
      authorizationMocks.stopPrivilegedUiSurfaceSession,
    ).toHaveBeenCalledWith(
      PRIVILEGED_UI_SURFACES.QUICK_PANEL,
      7,
      secondSessionId,
    );
    expect(
      authorizationMocks.stopPrivilegedUiSurfaceSession,
    ).not.toHaveBeenCalledWith(
      PRIVILEGED_UI_SURFACES.QUICK_PANEL,
      7,
      firstSessionId,
    );
  });
});
