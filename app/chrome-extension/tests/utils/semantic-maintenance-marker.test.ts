import { beforeEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "@/common/constants";
import {
  SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION,
  SemanticMaintenanceMarkerValidationError,
  armSemanticMaintenance,
  completeSemanticMaintenance,
  parseSemanticMaintenanceMarker,
  readSemanticMaintenanceMarker,
  type RequiredSemanticMaintenanceMarker,
} from "@/utils/semantic-maintenance-marker";

const MARKER_KEY = STORAGE_KEYS.SEMANTIC_CLEANUP_REQUIRED;

function installStorage(initial: Record<string, unknown> = {}) {
  const state = { ...initial };
  chrome.storage.local.get = vi.fn(async (keys?: unknown) => {
    const names = Array.isArray(keys)
      ? keys
      : typeof keys === "string"
        ? [keys]
        : Object.keys((keys as Record<string, unknown>) ?? state);
    return Object.fromEntries(
      names
        .filter((name): name is string => typeof name === "string")
        .filter((name) => Object.prototype.hasOwnProperty.call(state, name))
        .map((name) => [name, state[name]]),
    );
  }) as typeof chrome.storage.local.get;
  chrome.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(state, items);
  });
  chrome.storage.local.remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
  });
  return state;
}

function requiredMarker(
  attemptId = "required-attempt",
): RequiredSemanticMaintenanceMarker {
  return {
    schemaVersion: SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION,
    state: "required",
    attemptId,
    kind: "data-cleanup",
    startedAt: 100,
  };
}

describe("semantic maintenance marker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installStorage();
  });

  it("treats an absent marker and a strictly valid clear marker as clear", async () => {
    await expect(readSemanticMaintenanceMarker()).resolves.toEqual({
      state: "clear",
      marker: null,
    });

    const clear = {
      schemaVersion: SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION,
      state: "clear" as const,
      attemptId: "completed-attempt",
      completedAt: 200,
    };
    installStorage({ [MARKER_KEY]: clear });
    await expect(readSemanticMaintenanceMarker()).resolves.toEqual({
      state: "clear",
      marker: clear,
    });
  });

  it("returns a strictly valid required marker", async () => {
    const marker = requiredMarker();
    installStorage({ [MARKER_KEY]: marker });

    await expect(readSemanticMaintenanceMarker()).resolves.toEqual({
      state: "required",
      marker,
    });
  });

  it.each([
    null,
    { schemaVersion: 99, state: "required" },
    {
      ...requiredMarker(),
      injected: true,
    },
    {
      ...requiredMarker(),
      kind: "unknown",
    },
    {
      schemaVersion: 1,
      state: "clear",
      attemptId: "attempt",
      completedAt: -1,
    },
  ])("rejects malformed or future marker payloads", (value) => {
    expect(() => parseSemanticMaintenanceMarker(value)).toThrow(
      SemanticMaintenanceMarkerValidationError,
    );
  });

  it("propagates storage read failures instead of treating them as absent", async () => {
    chrome.storage.local.get = vi
      .fn()
      .mockRejectedValue(new Error("marker read failed"));

    await expect(readSemanticMaintenanceMarker()).rejects.toThrow(
      "marker read failed",
    );
  });

  it("arms and verifies a required marker before returning", async () => {
    const state = installStorage();

    const marker = await armSemanticMaintenance("index-recovery");

    expect(marker).toMatchObject({
      schemaVersion: 1,
      state: "required",
      kind: "index-recovery",
      attemptId: expect.any(String),
      startedAt: expect.any(Number),
    });
    expect(state[MARKER_KEY]).toEqual(marker);
    expect(chrome.storage.local.set).toHaveBeenCalledOnce();
    expect(chrome.storage.local.get).toHaveBeenCalledOnce();
  });

  it("rejects an arm write failure without replacing an existing requirement", async () => {
    const existing = requiredMarker("existing");
    const state = installStorage({ [MARKER_KEY]: existing });
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(
      new Error("marker write failed"),
    );

    await expect(armSemanticMaintenance("data-cleanup")).rejects.toThrow(
      "marker write failed",
    );
    expect(state[MARKER_KEY]).toEqual(existing);
  });

  it("completes only the marker owned by the caller", async () => {
    const newer = requiredMarker("newer-attempt");
    const state = installStorage({ [MARKER_KEY]: newer });

    await expect(
      completeSemanticMaintenance(requiredMarker("older-attempt")),
    ).rejects.toThrow("no longer owned");
    expect(state[MARKER_KEY]).toEqual(newer);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("writes and verifies a logical clear record without removing the key", async () => {
    const required = requiredMarker();
    const state = installStorage({ [MARKER_KEY]: required });

    const clear = await completeSemanticMaintenance(required);

    expect(clear).toMatchObject({
      schemaVersion: 1,
      state: "clear",
      attemptId: required.attemptId,
      completedAt: expect.any(Number),
    });
    expect(state[MARKER_KEY]).toEqual(clear);
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it("leaves the required marker in place when the clear write fails", async () => {
    const required = requiredMarker();
    const state = installStorage({ [MARKER_KEY]: required });
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(
      new Error("clear write failed"),
    );

    await expect(completeSemanticMaintenance(required)).rejects.toThrow(
      "clear write failed",
    );
    expect(state[MARKER_KEY]).toEqual(required);
  });

  it("restores the required marker when a clear write cannot be read back", async () => {
    const required = requiredMarker();
    const state = installStorage({ [MARKER_KEY]: required });
    vi.mocked(chrome.storage.local.set).mockImplementationOnce(async () => {
      delete state[MARKER_KEY];
    });

    await expect(completeSemanticMaintenance(required)).rejects.toThrow(
      "readback mismatched",
    );
    expect(state[MARKER_KEY]).toEqual(required);
  });

  it("never overwrites a newer clear attempt while handling an old readback failure", async () => {
    const required = requiredMarker("old-attempt");
    const newerClear = {
      schemaVersion: SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION,
      state: "clear" as const,
      attemptId: "new-attempt",
      completedAt: 300,
    };
    const state = installStorage({ [MARKER_KEY]: required });
    vi.mocked(chrome.storage.local.set).mockImplementationOnce(async () => {
      state[MARKER_KEY] = newerClear;
    });

    await expect(completeSemanticMaintenance(required)).rejects.toThrow(
      "readback mismatched",
    );
    expect(state[MARKER_KEY]).toEqual(newerClear);
    expect(chrome.storage.local.set).toHaveBeenCalledOnce();
  });
});
