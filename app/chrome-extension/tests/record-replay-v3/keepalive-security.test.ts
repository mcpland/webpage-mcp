import { afterEach, describe, expect, it, vi } from "vitest";

import { RR_V3_KEEPALIVE_PORT_NAME } from "@/common/rr-v3-keepalive-protocol";
import { createOffscreenKeepaliveController } from "@/entrypoints/background/record-replay-v3/engine/keepalive/offscreen-keepalive";

function createPort(sender: chrome.runtime.MessageSender): chrome.runtime.Port {
  return {
    name: RR_V3_KEEPALIVE_PORT_NAME,
    sender,
    disconnect: vi.fn(),
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
  } as unknown as chrome.runtime.Port;
}

describe("RR-V3 keepalive sender authorization", () => {
  const originalGetUrl = chrome.runtime.getURL;

  afterEach(() => {
    chrome.runtime.getURL = originalGetUrl;
    vi.useRealTimers();
  });

  it("rejects a content-script keepalive port and accepts only offscreen.html", () => {
    chrome.runtime.getURL = vi.fn(
      (path = "") =>
        `chrome-extension://${chrome.runtime.id}/${path.replace(/^\//, "")}`,
    );
    const controller = createOffscreenKeepaliveController({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const handleConnect = (
      controller as unknown as {
        handleConnect(port: chrome.runtime.Port): void;
      }
    ).handleConnect;

    const contentPort = createPort({
      id: chrome.runtime.id,
      tab: { id: 1 } as chrome.tabs.Tab,
      url: "https://example.com",
    });
    handleConnect(contentPort);
    expect(contentPort.disconnect).toHaveBeenCalledOnce();
    expect(contentPort.onMessage.addListener).not.toHaveBeenCalled();

    const offscreenPort = createPort({
      id: chrome.runtime.id,
      url: `chrome-extension://${chrome.runtime.id}/offscreen.html`,
      origin: `chrome-extension://${chrome.runtime.id}`,
    });
    handleConnect(offscreenPort);
    expect(offscreenPort.disconnect).not.toHaveBeenCalled();
    expect(offscreenPort.onMessage.addListener).toHaveBeenCalledOnce();
  });

  it("rejects runtime start/stop controls from a tab sender", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    chrome.runtime.getURL = vi.fn(
      (path = "") =>
        `chrome-extension://${chrome.runtime.id}/${path.replace(/^\//, "")}`,
    );
    let listener:
      | ((
          message: unknown,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response: unknown) => void,
        ) => void)
      | undefined;
    const originalAddListener = chrome.runtime.onMessage.addListener;
    const originalConnect = chrome.runtime.connect;
    const runtimePort = createPort({ id: chrome.runtime.id });
    chrome.runtime.connect = vi.fn(() => runtimePort);
    chrome.runtime.onMessage.addListener = vi.fn((callback) => {
      listener = callback as typeof listener;
    });
    try {
      const keepalive = await import("@/entrypoints/offscreen/rr-keepalive");
      keepalive.initKeepalive();
      const respond = vi.fn();

      listener?.(
        { type: "rr_v3_keepalive.control", command: "start" },
        { id: chrome.runtime.id, tab: { id: 1 } as chrome.tabs.Tab },
        respond,
      );
      expect(keepalive.isKeepaliveActive()).toBe(false);
      expect(respond).not.toHaveBeenCalled();

      listener?.(
        { type: "rr_v3_keepalive.control", command: "start" },
        { id: chrome.runtime.id },
        respond,
      );
      expect(keepalive.isKeepaliveActive()).toBe(true);
      expect(respond).toHaveBeenCalledWith({ ok: true });

      listener?.(
        { type: "rr_v3_keepalive.control", command: "stop" },
        { id: chrome.runtime.id },
        respond,
      );
      expect(keepalive.isKeepaliveActive()).toBe(false);
    } finally {
      chrome.runtime.onMessage.addListener = originalAddListener;
      chrome.runtime.connect = originalConnect;
    }
  });
});
