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
        hookStatus: "READY",
        capabilities: { canRead: true, canWrite: true, canWriteHooks: true },
      },
    }),
    read: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        hookStatus: "READY",
        framework: "react",
        componentName: "Button",
        debugSource: { file: "src/Button.tsx", line: 12, column: 4 },
        props: { kind: "props", entries: [] },
      },
    }),
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
  const openButton = container.querySelector<HTMLButtonElement>(
    ".we-props-source-btn",
  );
  if (!openButton) throw new Error("Open source button was not rendered");
  await vi.waitFor(() => expect(openButton.disabled).toBe(false));
  return { container, target, panel, openButton };
}

describe("Props panel open-source authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.replaceChildren();
    authorizationMocks.authorizePrivilegedUiAction.mockResolvedValue(
      "open-source-token",
    );
    authorizationMocks.isTrustedPrivilegedUiEvent.mockReturnValue(false);
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true });
  });

  it("does not request a capability for a synthetic page event", async () => {
    const { panel, openButton } = await mountedPanel();

    openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(
      authorizationMocks.authorizePrivilegedUiAction,
    ).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_OPEN_SOURCE,
      }),
    );
    panel.dispose();
  });

  it("uses a dedicated one-time capability for a trusted click", async () => {
    authorizationMocks.isTrustedPrivilegedUiEvent.mockReturnValue(true);
    const { panel, openButton } = await mountedPanel();

    openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() =>
      expect(
        authorizationMocks.authorizePrivilegedUiAction,
      ).toHaveBeenCalledWith(PRIVILEGED_UI_ACTIONS.WEB_EDITOR_OPEN_SOURCE),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_OPEN_SOURCE,
      surfaceSessionId: "42".repeat(32),
      authorizationToken: "open-source-token",
      payload: {
        debugSource: { file: "src/Button.tsx", line: 12, column: 4 },
      },
    });
    panel.dispose();
  });
});
