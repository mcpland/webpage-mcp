import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PRIVILEGED_UI_SURFACES,
  BACKGROUND_MESSAGE_TYPES,
} from "@/common/message-types";

const authorizationMocks = vi.hoisted(() => ({
  validatePrivilegedUiSurfaceSession: vi.fn(),
}));

vi.mock(
  "@/entrypoints/background/privileged-ui-authorization",
  () => authorizationMocks,
);

import {
  executeWebEditorPropsRpc,
  normalizeWebEditorPropsRequest,
  WEB_EDITOR_PROPS_RPC_LIMITS,
} from "@/entrypoints/background/web-editor/props-rpc";
import { executePropsOperationInMain } from "@/entrypoints/background/web-editor/props-main-runner";

const SURFACE_SESSION_ID = "a".repeat(64);

function sender(
  overrides: Partial<chrome.runtime.MessageSender> = {},
): chrome.runtime.MessageSender {
  return {
    id: chrome.runtime.id,
    tab: {
      id: 7,
      windowId: 2,
      url: "https://example.com/editor",
    } as chrome.tabs.Tab,
    frameId: 0,
    documentId: "document-a",
    documentLifecycle: "active",
    url: "https://example.com/editor",
    origin: "https://example.com",
    ...overrides,
  };
}

function probeRequest(requestId = "request-1") {
  return { v: 1, requestId, op: "probe" } as const;
}

function writeRequest(requestId = "write-1", stateBudgetBytes = 1024) {
  return {
    v: 1,
    requestId,
    op: "write",
    locator: { selectors: ["#target"], fingerprint: "", path: [] },
    payload: {
      propPath: ["count"],
      propValue: 2,
      captureOriginal: true,
      stateBudgetBytes,
    },
  } as const;
}

function rpcMessage(request: unknown = probeRequest()) {
  return {
    type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_EXECUTE,
    surfaceSessionId: SURFACE_SESSION_ID,
    request,
  };
}

function successfulInjection(options: any, data: Record<string, unknown> = {}) {
  const request = options.args[0] as { requestId: string };
  return [
    {
      frameId: 0,
      documentId: options.target.documentIds[0],
      result: {
        response: {
          v: 1,
          requestId: request.requestId,
          success: true,
          data,
        },
      },
    },
  ];
}

describe("Web Editor background props RPC", () => {
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    authorizationMocks.validatePrivilegedUiSurfaceSession.mockResolvedValue(
      true,
    );
    executeScript = vi
      .fn()
      .mockImplementation(async (options) => successfulInjection(options));
    (
      chrome as unknown as {
        scripting: { executeScript: typeof executeScript };
      }
    ).scripting = { executeScript };
  });

  it("targets exactly the authenticated top-frame document in MAIN", async () => {
    const trustedSender = sender();
    const response = await executeWebEditorPropsRpc(
      rpcMessage(),
      trustedSender,
    );

    expect(response).toMatchObject({
      success: true,
      execution: {
        response: { v: 1, requestId: "request-1", success: true },
      },
    });
    expect(
      authorizationMocks.validatePrivilegedUiSurfaceSession,
    ).toHaveBeenCalledWith(
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      SURFACE_SESSION_ID,
      trustedSender,
    );
    expect(executeScript).toHaveBeenCalledOnce();
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, documentIds: ["document-a"] },
      world: "MAIN",
      func: executePropsOperationInMain,
      args: [probeRequest()],
    });
  });

  it.each([
    ["another extension", { id: "another-extension" }],
    ["a subframe", { frameId: 2 }],
    ["no document", { documentId: undefined }],
    ["an empty document ID", { documentId: "" }],
    ["an oversized document ID", { documentId: "x".repeat(513) }],
    ["a prerendered document", { documentLifecycle: "prerender" }],
  ])("rejects %s before surface validation", async (_label, overrides) => {
    const response = await executeWebEditorPropsRpc(
      rpcMessage(),
      sender(overrides as Partial<chrome.runtime.MessageSender>),
    );

    expect(response).toMatchObject({ success: false });
    expect(
      authorizationMocks.validatePrivilegedUiSurfaceSession,
    ).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("fails closed when the surface session is invalid or validation fails", async () => {
    authorizationMocks.validatePrivilegedUiSurfaceSession
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      executeWebEditorPropsRpc(rpcMessage(), sender()),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/session/),
    });
    await expect(
      executeWebEditorPropsRpc(rpcMessage(), sender()),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/session/),
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("strictly normalizes requests, including null prop values", async () => {
    const write = {
      v: 1,
      requestId: "write-1",
      op: "write",
      locator: {
        selectors: [" #root "],
        fingerprint: "fingerprint",
        path: [0, 2],
      },
      payload: {
        propPath: [" disabled "],
        propValue: null,
        captureOriginal: false,
        expectedTargetGuard: "fiber-v1:0000000000000000",
        stateBudgetBytes: 0,
      },
    };
    expect(normalizeWebEditorPropsRequest(write)).toEqual({
      ...write,
      locator: { ...write.locator, selectors: ["#root"] },
      payload: { ...write.payload, propPath: ["disabled"] },
    });

    const getter = vi.fn(() => "probe");
    const accessorRequest = { v: 1, requestId: "accessor-1" } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorRequest, "op", {
      enumerable: true,
      get: getter,
    });
    expect(normalizeWebEditorPropsRequest(accessorRequest)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("validates and preserves a correlated private write original", async () => {
    executeScript.mockImplementationOnce(async (options) => {
      const request = options.args[0];
      return [
        {
          frameId: 0,
          documentId: options.target.documentIds[0],
          result: {
            response: {
              v: 1,
              requestId: request.requestId,
              success: true,
            },
            targetGuard: "Button",
            stateDelta: {
              kind: "write_original",
              path: ["count"],
              encodedValue: 1,
              existed: true,
              componentGuard: "Button",
            },
          },
        },
      ];
    });

    await expect(
      executeWebEditorPropsRpc(rpcMessage(writeRequest()), sender()),
    ).resolves.toMatchObject({
      success: true,
      execution: {
        response: { success: true },
        stateDelta: {
          kind: "write_original",
          path: ["count"],
          encodedValue: 1,
        },
      },
    });
  });

  it.each([
    ["a mismatched path", { path: ["other"] }],
    ["an oversized original", { encodedValue: "x".repeat(2048) }],
  ])("rejects %s in a private write delta", async (_label, deltaOverride) => {
    executeScript.mockImplementationOnce(async (options) => {
      const request = options.args[0];
      return [
        {
          frameId: 0,
          documentId: options.target.documentIds[0],
          result: {
            response: {
              v: 1,
              requestId: request.requestId,
              success: true,
            },
            targetGuard: "Button",
            stateDelta: {
              kind: "write_original",
              path: ["count"],
              encodedValue: 1,
              existed: true,
              componentGuard: "Button",
              ...deltaOverride,
            },
          },
        },
      ];
    });

    await expect(
      executeWebEditorPropsRpc(rpcMessage(writeRequest()), sender()),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/Invalid props execution response/),
    });
  });

  it("requires recovery state for every successful capturing write", async () => {
    executeScript.mockImplementationOnce(async (options) =>
      successfulInjection(options),
    );

    await expect(
      executeWebEditorPropsRpc(rpcMessage(writeRequest()), sender()),
    ).resolves.toMatchObject({ success: false });
  });

  it("rejects reset indexes that conflict with a guard mismatch", async () => {
    const reset = {
      v: 1,
      requestId: "reset-1",
      op: "reset",
      locator: { selectors: ["#target"], fingerprint: "", path: [] },
      payload: {
        originals: [
          {
            index: 0,
            path: ["count"],
            encodedValue: 1,
            existed: true,
            componentGuard: "Button",
          },
        ],
      },
    };
    executeScript.mockImplementationOnce(async (options) => [
      {
        frameId: 0,
        documentId: options.target.documentIds[0],
        result: {
          response: { v: 1, requestId: "reset-1", success: false },
          targetGuard: "Button",
          stateDelta: {
            kind: "reset_result",
            appliedIndexes: [0],
            guardMismatch: true,
          },
        },
      },
    ]);

    await expect(
      executeWebEditorPropsRpc(rpcMessage(reset), sender()),
    ).resolves.toMatchObject({ success: false });
  });

  it("rejects requests whose normalized wire value exceeds 64 KiB", async () => {
    const oversized = {
      v: 1,
      requestId: "oversized-1",
      op: "probe",
      locator: {
        selectors: Array.from({ length: 16 }, () => "x".repeat(4096)),
        shadowHostChain: Array.from({ length: 16 }, () => "y".repeat(4096)),
        frameChain: Array.from({ length: 16 }, () => "z".repeat(4096)),
        fingerprint: "fingerprint",
        path: [],
      },
    };
    const response = await executeWebEditorPropsRpc(
      rpcMessage(oversized),
      sender(),
    );

    expect(response).toMatchObject({
      success: false,
      error: expect.stringMatching(/Invalid/),
    });
    expect(
      authorizationMocks.validatePrivilegedUiSurfaceSession,
    ).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("rejects ambiguous, navigated, or malformed injection results", async () => {
    executeScript
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async (options) => [
        ...successfulInjection(options),
        ...successfulInjection(options),
      ])
      .mockImplementationOnce(async (options) => [
        {
          ...successfulInjection(options)[0],
          documentId: "document-after-navigation",
        },
      ])
      .mockImplementationOnce(async (options) => [
        {
          ...successfulInjection(options)[0],
          result: {
            response: {
              v: 1,
              requestId: "another-request",
              success: true,
            },
          },
        },
      ]);

    for (let index = 0; index < 4; index += 1) {
      await expect(
        executeWebEditorPropsRpc(
          rpcMessage(probeRequest(`request-${index}`)),
          sender(),
        ),
      ).resolves.toMatchObject({ success: false });
    }
  });

  it("rejects execution responses above 256 KiB", async () => {
    executeScript.mockImplementationOnce(async (options) =>
      successfulInjection(options, {
        oversized: "x".repeat(WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseBytes + 1),
      }),
    );

    await expect(
      executeWebEditorPropsRpc(rpcMessage(), sender()),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/Invalid props execution response/),
    });
  });

  it("applies quota before asynchronous surface validation", async () => {
    const validationResolvers: Array<(value: boolean) => void> = [];
    authorizationMocks.validatePrivilegedUiSurfaceSession.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          validationResolvers.push(resolve);
        }),
    );
    const firstEight = Array.from({ length: 8 }, (_, index) =>
      executeWebEditorPropsRpc(
        rpcMessage(probeRequest(`validation-${index}`)),
        sender(),
      ),
    );
    await vi.waitFor(() =>
      expect(authorizationMocks.validatePrivilegedUiSurfaceSession).toHaveBeenCalledTimes(8),
    );

    await expect(
      executeWebEditorPropsRpc(rpcMessage(probeRequest("validation-denied")), sender()),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/Too many pending/),
    });
    expect(authorizationMocks.validatePrivilegedUiSurfaceSession).toHaveBeenCalledTimes(8);
    for (const resolve of validationResolvers) resolve(false);
    await Promise.all(firstEight);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("caps one document/session at eight concurrent operations and releases the quota", async () => {
    const pending: Array<{ options: any; resolve: (value: unknown) => void }> =
      [];
    executeScript.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          pending.push({ options, resolve });
        }),
    );
    const firstEight = Array.from({ length: 8 }, (_, index) =>
      executeWebEditorPropsRpc(
        rpcMessage(probeRequest(`request-${index}`)),
        sender(),
      ),
    );
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(8));

    await expect(
      executeWebEditorPropsRpc(
        rpcMessage(probeRequest("request-denied")),
        sender(),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/Too many pending/),
    });
    expect(executeScript).toHaveBeenCalledTimes(8);

    for (const entry of pending) {
      entry.resolve(successfulInjection(entry.options));
    }
    await expect(Promise.all(firstEight)).resolves.toHaveLength(8);

    executeScript.mockImplementation(async (options) =>
      successfulInjection(options),
    );
    await expect(
      executeWebEditorPropsRpc(
        rpcMessage(probeRequest("request-after-release")),
        sender(),
      ),
    ).resolves.toMatchObject({ success: true });
  });

  it("caps global concurrency at 64 operations", async () => {
    const pending: Array<{ options: any; resolve: (value: unknown) => void }> =
      [];
    executeScript.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          pending.push({ options, resolve });
        }),
    );
    const firstSixtyFour = Array.from({ length: 64 }, (_, index) =>
      executeWebEditorPropsRpc(
        rpcMessage(probeRequest(`global-${index}`)),
        sender({ documentId: `document-${index}` }),
      ),
    );
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(64));

    await expect(
      executeWebEditorPropsRpc(
        rpcMessage(probeRequest("global-denied")),
        sender({ documentId: "document-65" }),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/Too many pending/),
    });
    expect(executeScript).toHaveBeenCalledTimes(64);

    for (const entry of pending) {
      entry.resolve(successfulInjection(entry.options));
    }
    await expect(Promise.all(firstSixtyFour)).resolves.toHaveLength(64);
  });

  it("keeps timed-out operations reserved until executeScript really settles", async () => {
    vi.useFakeTimers();
    const pending: Array<{ options: any; resolve: (value: unknown) => void }> =
      [];
    executeScript.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          pending.push({ options, resolve });
        }),
    );
    const stuck = Array.from({ length: 8 }, (_, index) =>
      executeWebEditorPropsRpc(
        rpcMessage(probeRequest(`timeout-${index}`)),
        sender(),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(executeScript).toHaveBeenCalledTimes(8);

    await vi.advanceTimersByTimeAsync(
      WEB_EDITOR_PROPS_RPC_LIMITS.maxExecutionMs,
    );
    await expect(Promise.all(stuck)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          success: false,
          error: expect.stringMatching(/Unable to execute/),
        }),
      ]),
    );

    await expect(
      executeWebEditorPropsRpc(
        rpcMessage(probeRequest("request-after-timeout")),
        sender(),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/Too many pending/),
    });

    const released = pending.shift()!;
    released.resolve(successfulInjection(released.options));
    await vi.advanceTimersByTimeAsync(0);
    executeScript.mockImplementationOnce(async (options) =>
      successfulInjection(options),
    );
    await expect(
      executeWebEditorPropsRpc(
        rpcMessage(probeRequest("request-after-settlement")),
        sender(),
      ),
    ).resolves.toMatchObject({ success: true });
    for (const entry of pending) entry.resolve(successfulInjection(entry.options));
    vi.useRealTimers();
  });
});
