import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getActiveCurrentWindowTab,
  getActiveCurrentWindowTabId,
} from "@/entrypoints/shared/utils";

function asMock<T>(value: T): ReturnType<typeof vi.fn> {
  return value as unknown as ReturnType<typeof vi.fn>;
}

describe("getActiveCurrentWindowTabId", () => {
  beforeEach(() => {
    asMock(chrome.tabs.query).mockReset();
  });

  it("returns the current active tab id when present", async () => {
    asMock(chrome.tabs.query).mockResolvedValue([
      { id: 42, active: true, currentWindow: true },
    ]);

    await expect(getActiveCurrentWindowTabId()).resolves.toBe(42);
    expect(chrome.tabs.query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
  });

  it("returns the current active tab when present", async () => {
    const activeTab = {
      id: 42,
      active: true,
      currentWindow: true,
      url: "https://example.com/app",
    };
    asMock(chrome.tabs.query).mockResolvedValue([activeTab]);

    await expect(getActiveCurrentWindowTab()).resolves.toBe(activeTab);
  });

  it("returns undefined when there is no active tab", async () => {
    asMock(chrome.tabs.query).mockResolvedValue([]);

    await expect(getActiveCurrentWindowTabId()).resolves.toBeUndefined();
  });

  it("returns undefined when chrome.tabs.query throws", async () => {
    asMock(chrome.tabs.query).mockRejectedValue(new Error("tabs unavailable"));

    await expect(getActiveCurrentWindowTabId()).resolves.toBeUndefined();
  });
});
