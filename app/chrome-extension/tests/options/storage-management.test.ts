import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";
import OptionsApp from "@/entrypoints/options/App";

describe("options semantic index data management", () => {
  let root: Root | null = null;
  let sendMessage: ReturnType<typeof vi.fn>;
  let clearResponse: { success: boolean; error?: string };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    clearResponse = { success: true };
    sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === BACKGROUND_MESSAGE_TYPES.GET_STORAGE_STATS) {
        return {
          success: true,
          stats: {
            available: true,
            indexedPages: 2,
            totalDocuments: 5,
            totalTabs: 2,
            indexSize: 2048,
          },
        };
      }
      if (message.type === BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA)
        return clearResponse;
      if (message.type === "call_tool") {
        return {
          success: true,
          result: { content: [{ text: '{"items":[]}' }] },
        };
      }
      return { success: false, error: "unexpected message" };
    });

    vi.stubGlobal("chrome", {
      ...chrome,
      i18n: { getMessage: vi.fn((key: string) => key) },
      runtime: { ...chrome.runtime, sendMessage },
      storage: {
        ...chrome.storage,
        local: {
          ...chrome.storage.local,
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    vi.stubGlobal("confirm", vi.fn());
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  async function mount() {
    const container = document.getElementById("root");
    if (!container) throw new Error("missing test root");
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(OptionsApp));
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("semanticDataSectionTitle"),
    );
  }

  function clearButton(): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "semanticDataClearButton",
    );
    if (!(button instanceof HTMLButtonElement))
      throw new Error("missing clear button");
    return button;
  }

  it("renders loaded semantic index statistics", async () => {
    await mount();

    expect(
      Array.from(
        document.querySelectorAll(".storage-stats dd"),
        (node) => node.textContent,
      ),
    ).toEqual(["2", "5", "2", "2.0 KB"]);
  });

  it("cancels without sending a cleanup request when confirmation is declined", async () => {
    vi.mocked(globalThis.confirm).mockReturnValue(false);
    await mount();

    await act(async () => clearButton().click());

    expect(globalThis.confirm).toHaveBeenCalledWith("semanticDataConfirm");
    expect(sendMessage).not.toHaveBeenCalledWith({
      type: BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA,
    });
  });

  it("confirms cleanup and exposes a visible success status", async () => {
    vi.mocked(globalThis.confirm).mockReturnValue(true);
    await mount();

    await act(async () => clearButton().click());

    await vi.waitFor(() =>
      expect(
        document.getElementById("storage-management-status")?.textContent,
      ).toBe("semanticDataClearSuccess"),
    );
    expect(globalThis.confirm).toHaveBeenCalledWith("semanticDataConfirm");
    expect(sendMessage).toHaveBeenCalledWith({
      type: BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA,
    });
    expect(
      document
        .getElementById("storage-management-status")
        ?.getAttribute("role"),
    ).toBe("status");
  });

  it("exposes a visible failure status when cleanup is incomplete", async () => {
    clearResponse = { success: false, error: "IndexedDB deletion was blocked" };
    vi.mocked(globalThis.confirm).mockReturnValue(true);
    await mount();

    await act(async () => clearButton().click());

    await vi.waitFor(() =>
      expect(
        document.getElementById("storage-management-status")?.textContent,
      ).toContain("semanticDataClearFailure"),
    );
    expect(
      document.getElementById("storage-management-status")?.textContent,
    ).toContain("blocked");
    expect(
      document
        .getElementById("storage-management-status")
        ?.getAttribute("role"),
    ).toBe("alert");
  });

  it("shows unavailable instead of zero when persisted stats are not loaded", async () => {
    sendMessage.mockImplementation(async (message: { type?: string }) => {
      if (message.type === BACKGROUND_MESSAGE_TYPES.GET_STORAGE_STATS) {
        return {
          success: true,
          stats: {
            available: false,
            indexedPages: null,
            totalDocuments: null,
            totalTabs: null,
            indexSize: null,
          },
        };
      }
      if (message.type === "call_tool") {
        return {
          success: true,
          result: { content: [{ text: '{"items":[]}' }] },
        };
      }
      return clearResponse;
    });

    await mount();

    expect(
      Array.from(
        document.querySelectorAll(".storage-stats dd"),
        (node) => node.textContent,
      ),
    ).toEqual(Array(4).fill("semanticDataUnavailable"));
  });
});
