import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  WEB_EDITOR_RUNTIME_ENABLEMENT_ERROR,
  WEB_EDITOR_RUNTIME_SCRIPT_PATH,
  WEB_EDITOR_RUNTIME_WORLD_ID,
} from "@/common/web-editor-runtime";
import { WEB_EDITOR_ACTIONS } from "@/common/web-editor-types";

function injectionResult(result: unknown, documentId = "document-a") {
  return [{ frameId: 0, documentId, result }];
}

describe("Web Editor dedicated runtime host", () => {
  let configureWorld: ReturnType<typeof vi.fn>;
  let execute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    configureWorld = vi.fn().mockResolvedValue(undefined);
    execute = vi.fn();
    Object.assign(chrome, {
      userScripts: { configureWorld, execute },
    });
    vi.mocked(chrome.tabs.sendMessage).mockClear();
  });

  it("injects and commands Web Editor only inside its dedicated user-script world", async () => {
    execute
      .mockResolvedValueOnce(injectionResult({ kind: "missing" }))
      .mockResolvedValueOnce(injectionResult(undefined))
      .mockResolvedValueOnce(
        injectionResult({
          kind: "response",
          value: { status: "pong", active: false, version: 1 },
        }),
      )
      .mockResolvedValueOnce(
        injectionResult({ kind: "response", value: { active: true } }),
      );
    const runtime =
      await import("@/entrypoints/background/web-editor/runtime-host");

    await expect(runtime.ensureWebEditorRuntime(7)).resolves.toEqual({
      documentId: "document-a",
      status: { status: "pong", active: false, version: 1 },
    });
    const sessionId = "ab".repeat(32);
    await expect(
      runtime.sendWebEditorRuntimeCommand(
        7,
        {
          action: WEB_EDITOR_ACTIONS.START,
          privilegedSurfaceSessionId: sessionId,
        },
        "document-a",
      ),
    ).resolves.toEqual({ active: true });

    expect(configureWorld).toHaveBeenCalledOnce();
    expect(configureWorld).toHaveBeenCalledWith({
      worldId: WEB_EDITOR_RUNTIME_WORLD_ID,
      messaging: true,
      csp: "script-src 'self'",
    });
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: { tabId: 7, frameIds: [0] },
        world: "USER_SCRIPT",
        worldId: WEB_EDITOR_RUNTIME_WORLD_ID,
        js: [{ file: WEB_EDITOR_RUNTIME_SCRIPT_PATH }],
      }),
    );
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { tabId: 7, documentIds: ["document-a"] },
        world: "USER_SCRIPT",
        worldId: WEB_EDITOR_RUNTIME_WORLD_ID,
        js: [{ code: expect.stringContaining(sessionId) }],
      }),
    );
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("reuses an existing runtime without reinjecting its packaged file", async () => {
    execute.mockResolvedValueOnce(
      injectionResult({
        kind: "response",
        value: { status: "pong", active: true, version: 1 },
      }),
    );
    const runtime =
      await import("@/entrypoints/background/web-editor/runtime-host");

    await expect(runtime.ensureWebEditorRuntime(7)).resolves.toMatchObject({
      status: { active: true },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]?.js?.[0]?.file).toBeUndefined();
  });

  it("fails closed with an actionable error when Chrome disables User Scripts", async () => {
    delete (chrome as unknown as { userScripts?: unknown }).userScripts;
    const runtime =
      await import("@/entrypoints/background/web-editor/runtime-host");

    await expect(runtime.ensureWebEditorRuntime(7)).rejects.toThrow(
      WEB_EDITOR_RUNTIME_ENABLEMENT_ERROR,
    );
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects ambiguous multi-frame command results", async () => {
    execute.mockResolvedValueOnce([
      { frameId: 0, documentId: "document-a", result: { kind: "missing" } },
      { frameId: 1, documentId: "document-b", result: { kind: "missing" } },
    ]);
    const runtime =
      await import("@/entrypoints/background/web-editor/runtime-host");

    await expect(runtime.ensureWebEditorRuntime(7)).rejects.toThrow(
      "invalid Web Editor runtime result",
    );
  });

  it("rejects oversized commands before Chrome executes them", async () => {
    const runtime =
      await import("@/entrypoints/background/web-editor/runtime-host");

    await expect(
      runtime.sendWebEditorRuntimeCommand(7, {
        value: "😀".repeat(140_000),
      }),
    ).rejects.toThrow("command exceeded the size limit");
    expect(execute).not.toHaveBeenCalled();
  });

  it("measures runtime response limits in UTF-8 bytes", async () => {
    execute.mockResolvedValueOnce(
      injectionResult({
        kind: "response",
        value: "😀".repeat(140_000),
      }),
    );
    const runtime =
      await import("@/entrypoints/background/web-editor/runtime-host");

    await expect(runtime.sendWebEditorRuntimeCommand(7, {})).rejects.toThrow(
      "response exceeded the size limit",
    );
  });

  it("rejects invalid tab identifiers without configuring a world", async () => {
    const runtime =
      await import("@/entrypoints/background/web-editor/runtime-host");

    await expect(runtime.sendWebEditorRuntimeCommand(-1, {})).rejects.toThrow(
      "requires a valid tab ID",
    );
    expect(configureWorld).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
