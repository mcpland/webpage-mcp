import { afterEach, describe, expect, it, vi } from "vitest";

import { javascriptTool } from "@/entrypoints/background/tools/browser/javascript";
import { cdpSessionManager } from "@/utils/cdp-session-manager";
import {
  JAVASCRIPT_TOOL_LIMITS,
  TOOL_NAMES,
  TOOL_SCHEMAS,
} from "webpage-mcp-shared";

function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 7,
    index: 0,
    windowId: 2,
    title: "Example",
    url: "https://example.com/",
    status: "complete",
    active: true,
    ...overrides,
  } as chrome.tabs.Tab;
}

function payloadOf(result: Awaited<ReturnType<typeof javascriptTool.execute>>) {
  return JSON.parse(
    String((result.content[0] as { text?: string })?.text || "{}"),
  ) as Record<string, any>;
}

function mockCdpCommands(envelope: unknown) {
  vi.spyOn(cdpSessionManager, "withSession").mockImplementation(
    async (_tabId, _owner, operation) => operation(),
  );
  return vi
    .spyOn(cdpSessionManager, "sendCommand")
    .mockImplementation(async (_tabId, method) => {
      if (method === "Runtime.evaluate") {
        return { result: { type: "object", objectId: "remote-holder-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { type: "object", value: envelope } };
      }
      return {};
    });
}

describe("javascriptTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects file URL tabs before executing JavaScript", async () => {
    const tryGetTab = vi
      .spyOn(javascriptTool as any, "tryGetTab")
      .mockResolvedValue(makeTab({ url: "file:///tmp/secret.txt" }));
    const getActiveTabOrThrow = vi
      .spyOn(javascriptTool as any, "getActiveTabOrThrow")
      .mockResolvedValue(makeTab({ url: "file:///tmp/secret.txt" }));

    const result = await javascriptTool.execute({
      tabId: 7,
      code: "return document.body?.innerText;",
    });

    expect(result.isError).toBe(true);
    expect(
      String((result.content[0] as { text?: string })?.text || ""),
    ).toContain(
      "Only http:// and https:// pages are supported by chrome_javascript",
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(getActiveTabOrThrow).not.toHaveBeenCalled();
  });

  it("publishes hard limits for code, timeout, and output bytes", () => {
    const schema = TOOL_SCHEMAS.find(
      (tool) => tool.name === TOOL_NAMES.BROWSER.JAVASCRIPT,
    );
    const properties = schema?.inputSchema.properties as Record<string, any>;

    expect(schema?.inputSchema.additionalProperties).toBe(false);
    expect(properties.code.maxLength).toBe(
      JAVASCRIPT_TOOL_LIMITS.MAX_CODE_BYTES,
    );
    expect(properties.timeoutMs).toMatchObject({
      minimum: JAVASCRIPT_TOOL_LIMITS.MIN_TIMEOUT_MS,
      maximum: JAVASCRIPT_TOOL_LIMITS.MAX_TIMEOUT_MS,
      default: JAVASCRIPT_TOOL_LIMITS.DEFAULT_TIMEOUT_MS,
    });
    expect(properties.maxOutputBytes).toMatchObject({
      minimum: JAVASCRIPT_TOOL_LIMITS.MIN_OUTPUT_BYTES,
      maximum: JAVASCRIPT_TOOL_LIMITS.MAX_OUTPUT_BYTES,
      default: JAVASCRIPT_TOOL_LIMITS.DEFAULT_MAX_OUTPUT_BYTES,
    });
  });

  it.each([
    [
      "code",
      {
        code: "x".repeat(JAVASCRIPT_TOOL_LIMITS.MAX_CODE_BYTES + 1),
      },
    ],
    [
      "timeoutMs",
      {
        code: "return 1;",
        timeoutMs: JAVASCRIPT_TOOL_LIMITS.MAX_TIMEOUT_MS + 1,
      },
    ],
    [
      "maxOutputBytes",
      {
        code: "return 1;",
        maxOutputBytes: JAVASCRIPT_TOOL_LIMITS.MAX_OUTPUT_BYTES + 1,
      },
    ],
  ])(
    "rejects an out-of-range %s before resolving a tab",
    async (_name, args) => {
      const tryGetTab = vi.spyOn(javascriptTool as any, "tryGetTab");

      const result = await javascriptTool.execute({ tabId: 7, ...args });

      expect(result.isError).toBe(true);
      expect(tryGetTab).not.toHaveBeenCalled();
    },
  );

  it("retains the raw result remotely, serializes it in-page, and releases the object group", async () => {
    vi.spyOn(javascriptTool as any, "tryGetTab").mockResolvedValue(makeTab());
    const sendCommand = mockCdpCommands({
      version: 1,
      status: "success",
      text: '{"answer":42}',
      truncated: false,
      redacted: false,
    });

    const result = await javascriptTool.execute({
      tabId: 7,
      code: "return { answer: 42 };",
      maxOutputBytes: 2048,
    });
    const payload = payloadOf(result);

    expect(result.isError).toBe(false);
    expect(payload.result).toBe('{"answer":42}');
    const evaluateCall = sendCommand.mock.calls.find(
      ([, method]) => method === "Runtime.evaluate",
    );
    const serializeCall = sendCommand.mock.calls.find(
      ([, method]) => method === "Runtime.callFunctionOn",
    );
    const releaseCall = sendCommand.mock.calls.find(
      ([, method]) => method === "Runtime.releaseObjectGroup",
    );
    expect(evaluateCall?.[2]).toMatchObject({
      returnByValue: false,
      generatePreview: false,
      awaitPromise: true,
      objectGroup: expect.stringMatching(/^webpage-mcp-javascript-7-/),
    });
    expect(String((evaluateCall?.[2] as any)?.expression)).toContain(
      "__webpageMcpValue",
    );
    expect(serializeCall?.[2]).toMatchObject({
      objectId: "remote-holder-1",
      returnByValue: true,
      generatePreview: false,
      arguments: [{ value: 2048 }],
      functionDeclaration: expect.stringContaining(
        "serializeJavaScriptEvaluation",
      ),
    });
    expect(releaseCall?.[2]).toEqual({
      objectGroup: (evaluateCall?.[2] as any)?.objectGroup,
    });
  });

  it("returns a sanitized page-side runtime error and still releases its holder", async () => {
    vi.spyOn(javascriptTool as any, "tryGetTab").mockResolvedValue(makeTab());
    const sendCommand = mockCdpCommands({
      version: 1,
      status: "error",
      errorKind: "runtime_error",
      message: "Bearer <redacted>",
    });

    const result = await javascriptTool.execute({
      tabId: 7,
      code: 'throw new Error("secret");',
    });
    const payload = payloadOf(result);

    expect(result.isError).toBe(true);
    expect(payload.error).toEqual({
      kind: "runtime_error",
      message: "Bearer <redacted>",
    });
    expect(
      sendCommand.mock.calls.some(
        ([, method]) => method === "Runtime.releaseObjectGroup",
      ),
    ).toBe(true);
  });

  it("fails closed when the page serializer exceeds its promised byte budget", async () => {
    vi.spyOn(javascriptTool as any, "tryGetTab").mockResolvedValue(makeTab());
    mockCdpCommands({
      version: 1,
      status: "success",
      text: "x".repeat(65),
      truncated: false,
      redacted: false,
    });

    const result = await javascriptTool.execute({
      tabId: 7,
      code: 'return "x";',
      maxOutputBytes: 64,
    });
    const payload = payloadOf(result);

    expect(result.isError).toBe(true);
    expect(payload.error.kind).toBe("cdp_error");
    expect(payload.error.message).toContain("exceeded");
  });

  it("releases the remote holder when page serialization throws", async () => {
    vi.spyOn(javascriptTool as any, "tryGetTab").mockResolvedValue(makeTab());
    vi.spyOn(cdpSessionManager, "withSession").mockImplementation(
      async (_tabId, _owner, operation) => operation(),
    );
    const sendCommand = vi
      .spyOn(cdpSessionManager, "sendCommand")
      .mockImplementation(async (_tabId, method) => {
        if (method === "Runtime.evaluate") {
          return { result: { type: "object", objectId: "remote-holder-2" } };
        }
        if (method === "Runtime.callFunctionOn") {
          throw new Error("serializer failed");
        }
        return {};
      });

    const result = await javascriptTool.execute({
      tabId: 7,
      code: "return 1;",
    });

    expect(result.isError).toBe(true);
    expect(
      sendCommand.mock.calls.some(
        ([, method]) => method === "Runtime.releaseObjectGroup",
      ),
    ).toBe(true);
  });
});
