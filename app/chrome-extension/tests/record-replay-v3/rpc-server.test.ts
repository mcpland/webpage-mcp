import { describe, expect, it, vi } from "vitest";

import { RpcServer } from "@/entrypoints/background/record-replay-v3/engine/transport/rpc-server";
import type { StoragePort } from "@/entrypoints/background/record-replay-v3/engine/storage/storage-port";
import type { EventsBus } from "@/entrypoints/background/record-replay-v3/engine/transport/events-bus";

function createMockStorage(): StoragePort {
  return {
    flows: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    runs: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      patch: vi.fn(async () => {}),
    },
    events: {
      append: vi.fn(async () => ({ runId: "run-1", type: "log", ts: Date.now(), seq: 1 } as any)),
      list: vi.fn(async () => []),
    },
    queue: {
      enqueue: vi.fn(async () => null as any),
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => {}),
      reclaimExpiredLeases: vi.fn(async () => []),
      markRunning: vi.fn(async () => {}),
      markPaused: vi.fn(async () => {}),
      markDone: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
    },
    persistentVars: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => ({ key: "", value: null, updatedAt: 0 })),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    },
    triggers: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
  } as unknown as StoragePort;
}

describe("RpcServer", () => {
  it("starts and stops without chrome.runtime.onConnect", () => {
    const subscribe = vi.fn(() => unsubscribe);
    const unsubscribe = vi.fn();
    const events = {
      subscribe,
      append: vi.fn(),
      list: vi.fn(),
    } as unknown as EventsBus;
    const originalOnConnect = chrome.runtime.onConnect;

    delete (chrome.runtime as { onConnect?: unknown }).onConnect;

    try {
      const server = new RpcServer({
        storage: createMockStorage(),
        events,
      });

      expect(() => server.start()).not.toThrow();
      expect(subscribe).toHaveBeenCalledTimes(1);

      expect(() => server.stop()).not.toThrow();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      if (originalOnConnect !== undefined) {
        (chrome.runtime as { onConnect?: typeof originalOnConnect }).onConnect = originalOnConnect;
      }
    }
  });
});
