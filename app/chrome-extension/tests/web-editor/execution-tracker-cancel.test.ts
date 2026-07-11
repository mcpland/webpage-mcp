import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_MESSAGE_TYPES,
  PRIVILEGED_UI_ACTIONS,
} from "@/common/message-types";

const authorizationMocks = vi.hoisted(() => ({
  authorizePrivilegedUiAction: vi.fn(),
  getPrivilegedUiSurfaceSessionId: vi.fn(() => "42".repeat(32)),
}));

vi.mock("@/utils/privileged-ui-authorization", () => authorizationMocks);

describe("ExecutionTracker cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizationMocks.authorizePrivilegedUiAction.mockResolvedValue(
      "cancel-token",
    );
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true });
  });

  it("mints a document-bound capability before requesting cancellation", async () => {
    const { ExecutionTracker } =
      await import("@/entrypoints/web-editor/core/execution-tracker");
    const tracker = new ExecutionTracker();
    tracker.track("request-1", "session-1");

    await tracker.cancel("request-1");

    expect(authorizationMocks.authorizePrivilegedUiAction).toHaveBeenCalledWith(
      PRIVILEGED_UI_ACTIONS.WEB_EDITOR_CANCEL,
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CANCEL_EXECUTION,
      surfaceSessionId: "42".repeat(32),
      authorizationToken: "cancel-token",
      payload: { sessionId: "session-1", requestId: "request-1" },
    });

    tracker.dispose();
  });
});
