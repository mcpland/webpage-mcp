import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MessageListener = (
  request: Record<string, unknown>,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

class ControlledMutationObserver {
  static instances: ControlledMutationObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: MutationCallback) {
    ControlledMutationObserver.instances.push(this);
  }

  trigger(): void {
    this.callback([], this as unknown as MutationObserver);
  }
}

function makeVisible(element: Element): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    top: 20,
    right: 110,
    bottom: 60,
    left: 10,
    width: 100,
    height: 40,
    toJSON: () => ({}),
  } as DOMRect);
}

function loadWaitHelper(): MessageListener {
  let listener: MessageListener | undefined;
  const chromeMock = {
    runtime: {
      onMessage: {
        addListener: vi.fn((candidate: MessageListener) => {
          listener = candidate;
        }),
      },
    },
  };
  vi.stubGlobal("chrome", chromeMock);

  delete (window as any).__WAIT_HELPER_INITIALIZED__;
  delete (window as any).__claudeElementMap;
  delete (window as any).__claudeRefCounter;
  const scriptPath = join(process.cwd(), "inject-scripts/wait-helper.js");
  const source = readFileSync(scriptPath, "utf8");
  runInThisContext(source, { filename: scriptPath });

  if (!listener)
    throw new Error("wait helper did not register its message listener");
  return listener;
}

describe("wait-helper injected script", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    ControlledMutationObserver.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as any).__WAIT_HELPER_INITIALIZED__;
    delete (window as any).__claudeElementMap;
    delete (window as any).__claudeRefCounter;
  });

  it("responds successfully when a selector matches during the initial check", async () => {
    const target = document.createElement("button");
    target.id = "ready";
    makeVisible(target);
    document.body.appendChild(target);
    const listener = loadWaitHelper();
    const sendResponse = vi.fn();

    expect(
      listener(
        { action: "waitForSelector", selector: "#ready", timeout: 500 },
        {},
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledOnce());

    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      matched: {
        ref: "ref_1",
        center: { x: 60, y: 40 },
      },
      tookMs: expect.any(Number),
    });
  });

  it("responds successfully when text matches during the initial check", async () => {
    const target = document.createElement("button");
    target.textContent = "Loading complete";
    makeVisible(target);
    document.body.appendChild(target);
    const listener = loadWaitHelper();
    const sendResponse = vi.fn();

    listener(
      { action: "waitForText", text: "loading complete", timeout: 500 },
      {},
      sendResponse,
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledOnce());

    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        matched: expect.objectContaining({ ref: "ref_1" }),
      }),
    );
  });

  it("returns an error response when the async wait setup rejects", async () => {
    class ThrowingMutationObserver {
      constructor() {
        throw new Error("observer setup failed");
      }
    }
    vi.stubGlobal("MutationObserver", ThrowingMutationObserver);
    const listener = loadWaitHelper();
    const sendResponse = vi.fn();

    expect(
      listener(
        { action: "waitForSelector", selector: "#later", timeout: 500 },
        {},
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledOnce());

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: "observer setup failed",
    });
  });

  it("coalesces mutation bursts and cancels pending checks after matching", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MutationObserver", ControlledMutationObserver);
    const querySelector = vi.spyOn(document, "querySelector");
    const listener = loadWaitHelper();
    const sendResponse = vi.fn();

    listener(
      { action: "waitForSelector", selector: "#later", timeout: 500 },
      {},
      sendResponse,
    );
    const observer = ControlledMutationObserver.instances[0];
    expect(observer).toBeDefined();
    expect(querySelector).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 25; index += 1) observer.trigger();
    expect(querySelector).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(49);
    expect(querySelector).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(querySelector).toHaveBeenCalledTimes(2);

    const target = document.createElement("div");
    target.id = "later";
    makeVisible(target);
    document.body.appendChild(target);
    for (let index = 0; index < 25; index += 1) observer.trigger();
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    expect(sendResponse).toHaveBeenCalledOnce();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(observer.disconnect).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(sendResponse).toHaveBeenCalledOnce();
  });

  it("does not scan text elements beyond the per-check element budget", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MutationObserver", ControlledMutationObserver);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 5_100; index += 1) {
      const element = document.createElement("span");
      element.textContent =
        index === 5_099 ? "outside scan budget" : `item ${index}`;
      if (index === 5_099) makeVisible(element);
      fragment.appendChild(element);
    }
    document.body.appendChild(fragment);
    const listener = loadWaitHelper();
    const sendResponse = vi.fn();

    listener(
      { action: "waitForText", text: "outside scan budget", timeout: 1 },
      {},
      sendResponse,
    );
    expect(sendResponse).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, reason: "timeout" }),
    );
  });
});
