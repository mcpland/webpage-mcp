import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableAgentRequestOwner } from "@/entrypoints/background/agent-request-lifecycle";

const STORAGE_KEY = "agent-request-owners-v1";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function owner(
  requestId: string,
  overrides: Partial<DurableAgentRequestOwner> = {},
): DurableAgentRequestOwner {
  return {
    version: 1,
    surface: "web-editor",
    requestId,
    sessionId: "session-1",
    tabId: 7,
    frameId: 0,
    documentId: "document-a",
    createdAt: 1_000,
    deadlineAt: 2_000,
    phase: "reserved",
    status: "starting",
    ...overrides,
  };
}

describe("durable Agent request lifecycle", () => {
  let storageState: Record<string, unknown>;
  let order: string[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storageState = {};
    order = [];

    chrome.storage.session = {
      get: vi.fn(async () => structuredClone(storageState)),
      set: vi.fn(async (items: Record<string, unknown>) => {
        order.push("storage:set");
        Object.assign(storageState, structuredClone(items));
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        order.push("storage:remove");
        for (const key of Array.isArray(keys) ? keys : [keys])
          delete storageState[key];
      }),
    } as unknown as typeof chrome.storage.session;
    vi.mocked(chrome.alarms.create).mockImplementation(async () => {
      order.push("alarm:create");
    });
    vi.mocked(chrome.alarms.clear).mockImplementation(async () => {
      order.push("alarm:clear");
    });
  });

  it("creates the deadline before storage and restores the owner after a module restart", async () => {
    const lifecycle =
      await import("@/entrypoints/background/agent-request-lifecycle");
    await lifecycle.reserveDurableAgentRequestOwner(owner("request-1"));

    expect(order).toEqual(["alarm:create", "storage:set"]);
    expect(storageState[STORAGE_KEY]).toMatchObject({
      "web-editor:request-1": { requestId: "request-1", phase: "reserved" },
    });

    vi.resetModules();
    const restarted =
      await import("@/entrypoints/background/agent-request-lifecycle");
    await expect(
      restarted.getDurableAgentRequestOwner("web-editor", "request-1"),
    ).resolves.toMatchObject({
      requestId: "request-1",
      documentId: "document-a",
    });
  });

  it("clears an alarm if the durable reservation write fails", async () => {
    vi.mocked(chrome.storage.session.set).mockImplementationOnce(async () => {
      order.push("storage:set");
      throw new Error("session storage unavailable");
    });
    const lifecycle =
      await import("@/entrypoints/background/agent-request-lifecycle");

    await expect(
      lifecycle.reserveDurableAgentRequestOwner(owner("request-1")),
    ).rejects.toThrow(/session storage unavailable/);
    expect(order).toEqual(["alarm:create", "storage:set", "alarm:clear"]);
    await expect(
      lifecycle.getDurableAgentRequestOwner("web-editor", "request-1"),
    ).resolves.toBeUndefined();
  });

  it("serializes owner deletion and alarm clearing before a same-key reservation", async () => {
    const lifecycle =
      await import("@/entrypoints/background/agent-request-lifecycle");
    await lifecycle.reserveDurableAgentRequestOwner(owner("request-1"));
    order = [];

    const alarmClear = deferred<void>();
    vi.mocked(chrome.alarms.clear).mockImplementationOnce(async () => {
      order.push("alarm:clear");
      return alarmClear.promise;
    });

    const removing = lifecycle.removeDurableAgentRequestOwner(
      "web-editor",
      "request-1",
    );
    await vi.waitFor(() =>
      expect(order).toEqual(["storage:remove", "alarm:clear"]),
    );
    const reserving = lifecycle.reserveDurableAgentRequestOwner(
      owner("request-1", { createdAt: 3_000, deadlineAt: 4_000 }),
    );
    await Promise.resolve();
    expect(order).toEqual(["storage:remove", "alarm:clear"]);

    alarmClear.resolve();
    await Promise.all([removing, reserving]);
    expect(order).toEqual([
      "storage:remove",
      "alarm:clear",
      "alarm:create",
      "storage:set",
    ]);
    await expect(
      lifecycle.getDurableAgentRequestOwner("web-editor", "request-1"),
    ).resolves.toMatchObject({ createdAt: 3_000, deadlineAt: 4_000 });
  });

  it("never recreates a removed owner through a stale transition or rearm", async () => {
    const lifecycle =
      await import("@/entrypoints/background/agent-request-lifecycle");
    const original = owner("request-1");
    await lifecycle.reserveDurableAgentRequestOwner(original);
    await lifecycle.removeDurableAgentRequestOwner("web-editor", "request-1");
    const alarmCreates = vi.mocked(chrome.alarms.create).mock.calls.length;

    await expect(
      lifecycle.transitionDurableAgentRequestOwner({
        ...original,
        phase: "sent",
        status: "running",
      }),
    ).rejects.toThrow(/no longer exists/);
    await expect(
      lifecycle.rearmDurableAgentRequestDeadline(original),
    ).rejects.toThrow(/no longer exists/);
    expect(vi.mocked(chrome.alarms.create)).toHaveBeenCalledTimes(alarmCreates);
    expect(storageState[STORAGE_KEY]).toBeUndefined();
  });

  it("enforces monotonic phases and keeps a terminal owner sticky", async () => {
    const lifecycle =
      await import("@/entrypoints/background/agent-request-lifecycle");
    const original = owner("request-1");
    await lifecycle.reserveDurableAgentRequestOwner(original);
    const sent = { ...original, phase: "sent" as const, status: "running" };
    await lifecycle.transitionDurableAgentRequestOwner(sent);
    await expect(
      lifecycle.transitionDurableAgentRequestOwner(original),
    ).rejects.toThrow(/cannot move backwards/);
    const terminal = {
      ...sent,
      phase: "terminal" as const,
      status: "completed",
    };
    await lifecycle.transitionDurableAgentRequestOwner(terminal);
    await lifecycle.transitionDurableAgentRequestOwner({
      ...sent,
      phase: "cancel-pending",
      status: "interrupted",
    });

    await expect(
      lifecycle.getDurableAgentRequestOwner("web-editor", "request-1"),
    ).resolves.toMatchObject({ phase: "terminal", status: "completed" });
  });

  it("bounds the global ledger and prevents two Quick Panel owners for one document", async () => {
    const lifecycle =
      await import("@/entrypoints/background/agent-request-lifecycle");
    const quickOwner = owner("quick-1", { surface: "quick-panel" });
    await lifecycle.reserveDurableAgentRequestOwner(quickOwner);
    await expect(
      lifecycle.reserveDurableAgentRequestOwner(
        owner("quick-2", { surface: "quick-panel" }),
      ),
    ).rejects.toThrow(/already owns/);

    for (
      let index = 1;
      index < lifecycle.DURABLE_AGENT_REQUEST_MAX_ENTRIES;
      index += 1
    ) {
      await lifecycle.reserveDurableAgentRequestOwner(
        owner(`web-${index}`, {
          sessionId: `session-${index}`,
          tabId: 100 + index,
          documentId: `document-${index}`,
        }),
      );
    }
    await expect(
      lifecycle.reserveDurableAgentRequestOwner(
        owner("overflow", { tabId: 999 }),
      ),
    ).rejects.toThrow(/limit reached/);
  });

  it("allows only one live Web Editor request per Agent session", async () => {
    const lifecycle =
      await import("@/entrypoints/background/agent-request-lifecycle");
    const first = owner("web-1");
    await lifecycle.reserveDurableAgentRequestOwner(first);

    await expect(
      lifecycle.reserveDurableAgentRequestOwner(
        owner("web-2", { tabId: 8, documentId: "document-b" }),
      ),
    ).rejects.toThrow(/Web Editor session already owns/);

    await lifecycle.transitionDurableAgentRequestOwner({
      ...first,
      phase: "terminal",
      status: "completed",
    });
    await expect(
      lifecycle.reserveDurableAgentRequestOwner(
        owner("web-2", { tabId: 8, documentId: "document-b" }),
      ),
    ).resolves.toBeUndefined();
  });
});
