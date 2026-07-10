import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isExtensionBackgroundSender,
  isExtensionPageSender,
  isExtensionRuntimeSender,
  isOffscreenDocumentSender,
} from "@/common/runtime-sender-auth";

describe("runtime sender authorization", () => {
  const originalGetUrl = chrome.runtime.getURL;

  beforeEach(() => {
    chrome.runtime.getURL = vi.fn(
      (path = "") =>
        `chrome-extension://${chrome.runtime.id}/${path.replace(/^\//, "")}`,
    );
  });

  afterEach(() => {
    chrome.runtime.getURL = originalGetUrl;
  });

  it("accepts extension pages but rejects content scripts and foreign origins", () => {
    const page: chrome.runtime.MessageSender = {
      id: chrome.runtime.id,
      url: `chrome-extension://${chrome.runtime.id}/sidepanel.html`,
      origin: `chrome-extension://${chrome.runtime.id}`,
    };
    expect(isExtensionPageSender(page)).toBe(true);
    expect(
      isExtensionPageSender({ ...page, tab: { id: 1 } as chrome.tabs.Tab }),
    ).toBe(false);
    expect(
      isExtensionPageSender({ ...page, url: "https://example.com/page" }),
    ).toBe(false);
    expect(isExtensionPageSender({ ...page, id: "other-extension" })).toBe(
      false,
    );
  });

  it("accepts only the exact offscreen document on the keepalive port", () => {
    const sender: chrome.runtime.MessageSender = {
      id: chrome.runtime.id,
      url: `chrome-extension://${chrome.runtime.id}/offscreen.html`,
      origin: `chrome-extension://${chrome.runtime.id}`,
    };
    expect(isOffscreenDocumentSender(sender)).toBe(true);
    expect(
      isOffscreenDocumentSender({
        ...sender,
        url: `${sender.origin}/sidepanel.html`,
      }),
    ).toBe(false);
  });

  it("accepts a same-extension worker sender without a tab", () => {
    expect(isExtensionRuntimeSender({ id: chrome.runtime.id })).toBe(true);
    expect(
      isExtensionRuntimeSender({
        id: chrome.runtime.id,
        tab: { id: 1 } as chrome.tabs.Tab,
      }),
    ).toBe(false);
  });

  it("distinguishes the background worker from extension documents", () => {
    expect(isExtensionBackgroundSender({ id: chrome.runtime.id })).toBe(true);
    expect(
      isExtensionBackgroundSender({
        id: chrome.runtime.id,
        url: `chrome-extension://${chrome.runtime.id}/popup.html`,
        origin: `chrome-extension://${chrome.runtime.id}`,
      }),
    ).toBe(false);
    expect(
      isExtensionBackgroundSender({
        id: chrome.runtime.id,
        documentId: "offscreen-document",
      }),
    ).toBe(false);
    expect(isExtensionBackgroundSender({ id: "other-extension" })).toBe(false);
  });
});
