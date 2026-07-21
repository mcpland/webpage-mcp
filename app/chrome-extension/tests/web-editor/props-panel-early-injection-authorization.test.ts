import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_MESSAGE_TYPES,
  PRIVILEGED_UI_ACTIONS,
} from "@/common/message-types";
import type { PropsBridge } from "@/entrypoints/web-editor/core/props-bridge";
import { createPropsPanel } from "@/entrypoints/web-editor/ui/property-panel/props-panel";

const authorizationMocks = vi.hoisted(() => ({
  authorizePrivilegedUiAction: vi.fn(),
  getPrivilegedUiSurfaceSessionId: vi.fn(() => "42".repeat(32)),
  isTrustedPrivilegedUiEvent: vi.fn(),
}));

vi.mock("@/utils/privileged-ui-authorization", () => authorizationMocks);

function propsBridge(): PropsBridge {
  return {
    probe: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        hookStatus: "HOOK_MISSING",
        needsRefresh: true,
        capabilities: { canRead: false, canWrite: false, canWriteHooks: false },
      },
    }),
    read: vi.fn(),
    write: vi.fn(),
    reset: vi.fn(),
    cleanup: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn(() => false),
  } as PropsBridge;
}

async function mountedPanel() {
  const container = document.createElement("div");
  const target = document.createElement("button");
  target.id = "target";
  document.body.append(container, target);
  const panel = createPropsPanel({ container, propsBridge: propsBridge() });
  panel.setVisible(true);
  panel.setTarget(target);
  const refreshButton = container.querySelector<HTMLButtonElement>(
    '[aria-label="Refresh props"]',
  );
  if (!refreshButton) throw new Error("Refresh button was not rendered");
  await vi.waitFor(() => {
    expect(refreshButton.disabled).toBe(false);
    expect(refreshButton.dataset.tip).toBe("Enable & Reload");
  });
  return { panel, refreshButton };
}

describe("Props panel early-injection authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.replaceChildren();
    authorizationMocks.authorizePrivilegedUiAction.mockResolvedValue(
      "registration-token",
    );
    authorizationMocks.isTrustedPrivilegedUiEvent.mockReturnValue(false);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true });
  });

  it("ignores a synthetic page event before prompting or authorizing", async () => {
    const { panel, refreshButton } = await mountedPanel();

    refreshButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(window.confirm).not.toHaveBeenCalled();
    expect(
      authorizationMocks.authorizePrivilegedUiAction,
    ).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("uses a dedicated one-time capability for a trusted confirmed click", async () => {
    authorizationMocks.isTrustedPrivilegedUiEvent.mockReturnValue(true);
    const { panel, refreshButton } = await mountedPanel();

    refreshButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() =>
      expect(
        authorizationMocks.authorizePrivilegedUiAction,
      ).toHaveBeenCalledWith(
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_REGISTER_PROPS_INJECTION,
      ),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_REGISTER_EARLY_INJECTION,
      surfaceSessionId: "42".repeat(32),
      authorizationToken: "registration-token",
    });
    panel.dispose();
  });
});
