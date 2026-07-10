import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PickerApi = {
  startSession: (payload: unknown) => boolean;
  stopSession: (payload: unknown) => boolean;
  setActiveRequest: (payload: unknown) => boolean;
};

type RuntimeListener = (
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

function loadHelper(): PickerApi {
  delete (window as any).__MCP_ELEMENT_PICKER_INITIALIZED__;
  delete (window as any).__mcpElementPicker;
  delete (window as any).__claudeElementMap;
  delete (window as any).__claudeElementRefs;
  delete (window as any).__claudeRefOrder;
  delete (window as any).__claudeRefCounter;
  vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
  vi.mocked(chrome.runtime.sendMessage).mockClear();

  const source = readFileSync(
    join(process.cwd(), "inject-scripts", "element-picker.js"),
    "utf8",
  );
  window.eval(source);
  const api = (window as any).__mcpElementPicker;
  if (!api) throw new Error("Element picker helper did not expose its API");
  return api as PickerApi;
}

function getRuntimeListener(): RuntimeListener {
  const listener = vi
    .mocked(chrome.runtime.onMessage.addListener)
    .mock.calls.at(-1)?.[0];
  if (!listener)
    throw new Error("Element picker helper did not register a listener");
  return listener as RuntimeListener;
}

function dispatch(listener: RuntimeListener, request: unknown): Promise<any> {
  return new Promise((resolve) => {
    listener(request, {} as chrome.runtime.MessageSender, resolve);
  });
}

function click(element: Element): void {
  element.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: 5,
      clientY: 5,
    }),
  );
}

function selectedMessages(): any[] {
  return vi
    .mocked(chrome.runtime.sendMessage)
    .mock.calls.map(([message]) => message)
    .filter((message: any) => message?.type === "element_picker_frame_event");
}

describe("element-picker helper resource boundaries", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = "<head></head><body></body>";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: 1,
          y: 2,
          width: 20,
          height: 10,
          top: 2,
          right: 21,
          bottom: 12,
          left: 1,
          toJSON: () => ({}),
        }) as DOMRect,
    );
  });

  afterEach(() => {
    try {
      (window as any).__mcpElementPicker?.stopSession({});
    } catch {
      // Best effort cleanup for a partially loaded helper.
    }
    document.documentElement.innerHTML = "<head></head><body></body>";
    delete (window as any).__MCP_ELEMENT_PICKER_INITIALIZED__;
    delete (window as any).__mcpElementPicker;
    vi.restoreAllMocks();
  });

  it("selects without page-sized selector snapshots or subtree textContent", () => {
    const button = document.createElement("button");
    button.id = "bounded-target";
    button.append(document.createTextNode("Bounded label"));
    Object.defineProperty(button, "textContent", {
      configurable: true,
      get: () => {
        throw new Error("textContent must not be materialized");
      },
    });
    document.body.append(button);
    const documentQueryAll = vi.spyOn(document, "querySelectorAll");
    const shadowQueryAll = vi.spyOn(ShadowRoot.prototype, "querySelectorAll");
    const api = loadHelper();

    expect(
      api.startSession({ sessionId: "session", activeRequestId: "request" }),
    ).toBe(true);
    click(button);

    const selected = selectedMessages().at(-1);
    expect(selected).toMatchObject({
      sessionId: "session",
      requestId: "request",
      element: {
        selector: "#bounded-target",
        text: "Bounded label",
        ref: expect.stringMatching(/^ref_\d+$/),
      },
    });
    expect(documentQueryAll).not.toHaveBeenCalled();
    expect(shadowQueryAll).not.toHaveBeenCalled();
  });

  it("builds a bounded fallback path without materializing sibling collections", () => {
    const parent = document.createElement("div");
    const fragment = document.createDocumentFragment();
    let target: HTMLSpanElement | null = null;
    for (let index = 0; index < 180; index += 1) {
      const sibling = document.createElement("span");
      sibling.append(document.createTextNode(`item ${index}`));
      fragment.append(sibling);
      target = sibling;
    }
    parent.append(fragment);
    document.body.append(parent);
    Object.defineProperty(parent, "children", {
      configurable: true,
      get: () => {
        throw new Error("children collection must not be materialized");
      },
    });
    const api = loadHelper();

    expect(
      api.startSession({ sessionId: "session", activeRequestId: "request" }),
    ).toBe(true);
    click(target!);

    const selector = selectedMessages().at(-1)?.element?.selector;
    expect(typeof selector).toBe("string");
    expect(new TextEncoder().encode(selector).byteLength).toBeLessThanOrEqual(
      4 * 1024,
    );
  });

  it("shares one bounded selector scan across all candidate selectors", () => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 12_100; index += 1) {
      fragment.append(document.createElement("div"));
    }
    const target = document.createElement("button");
    target.id = "late-target";
    target.append(document.createTextNode("Late"));
    fragment.append(target);
    document.body.append(fragment);
    const matches = vi.spyOn(Element.prototype, "matches");
    const api = loadHelper();

    expect(
      api.startSession({ sessionId: "session", activeRequestId: "request" }),
    ).toBe(true);
    click(target);

    expect(matches.mock.calls.length).toBeLessThanOrEqual(12_000);
    expect(selectedMessages().at(-1)?.element?.selector).toBeTruthy();
  });

  it("keeps element refs stable through an O(1) reverse lookup", () => {
    const button = document.createElement("button");
    button.id = "stable-ref";
    document.body.append(button);
    const api = loadHelper();
    expect(
      api.startSession({ sessionId: "session", activeRequestId: "request" }),
    ).toBe(true);

    click(button);
    click(button);

    const messages = selectedMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].element.ref).toBe(messages[1].element.ref);
    expect(Object.keys((window as any).__claudeElementMap)).toHaveLength(1);
  });

  it("rejects oversized session and request identifiers", async () => {
    loadHelper();
    const listener = getRuntimeListener();

    await expect(
      dispatch(listener, {
        action: "elementPickerStart",
        sessionId: "s".repeat(129),
        activeRequestId: "request",
      }),
    ).resolves.toEqual({ success: false });
    await expect(
      dispatch(listener, {
        action: "elementPickerStart",
        sessionId: "session",
        activeRequestId: "😀".repeat(40),
      }),
    ).resolves.toEqual({ success: false });
  });

  it("bounds attacker-controlled text and non-finite geometry in frame messages", () => {
    const button = document.createElement("button");
    button.id = "bounded-output";
    button.setAttribute("aria-label", "😀".repeat(10_000));
    document.body.append(button);
    vi.mocked(button.getBoundingClientRect).mockReturnValue({
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: Number.NaN,
      height: Number.NEGATIVE_INFINITY,
      top: Number.NaN,
      right: Number.NaN,
      bottom: Number.NaN,
      left: Number.NaN,
      toJSON: () => ({}),
    });
    const api = loadHelper();

    expect(
      api.startSession({ sessionId: "session", activeRequestId: "request" }),
    ).toBe(true);
    click(button);

    const element = selectedMessages().at(-1)?.element;
    expect(
      new TextEncoder().encode(element.text).byteLength,
    ).toBeLessThanOrEqual(2 * 1024);
    expect(element.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(element.center).toEqual({ x: 0, y: 0 });
  });
});
