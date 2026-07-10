import { beforeEach, describe, expect, it } from "vitest";

import {
  RUN_RESOURCE_LIMITS,
  RUN_SCHEMA_VERSION,
  closeRrV3Db,
  deleteRrV3Db,
  jsonUtf8ByteLength,
  type RunRecordV3,
} from "@/entrypoints/background/record-replay-v3";
import { createEventsStore } from "@/entrypoints/background/record-replay-v3/storage/events";
import { createRunsStore } from "@/entrypoints/background/record-replay-v3/storage/runs";
import { createQueueStore } from "@/entrypoints/background/record-replay-v3/storage/queue";
import { createIndexedDbArtifactStore } from "@/entrypoints/background/record-replay-v3/storage/artifacts";

function createRun(
  id: string,
  createdAt: number,
  overrides: Partial<RunRecordV3> = {},
): RunRecordV3 {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    id,
    flowId: "flow-1",
    status: "succeeded",
    createdAt,
    updatedAt: createdAt,
    finishedAt: createdAt,
    attempt: 1,
    maxAttempts: 1,
    nextSeq: 0,
    ...overrides,
  };
}

describe("V3 run storage bounds", () => {
  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();
  });

  it("rejects oversized records on save and patch", async () => {
    const runs = createRunsStore();
    const oversized = "x".repeat(RUN_RESOURCE_LIMITS.maxStringUtf8Bytes + 1);
    const run = createRun("run-1", 1);

    await expect(runs.save({ ...run, outputs: { oversized } })).rejects.toThrow(
      `${RUN_RESOURCE_LIMITS.maxStringUtf8Bytes}-byte string limit`,
    );
    await runs.save(run);
    await expect(
      runs.patch(run.id, { outputs: { oversized } }),
    ).rejects.toThrow(
      `${RUN_RESOURCE_LIMITS.maxStringUtf8Bytes}-byte string limit`,
    );
    await expect(
      runs.save(
        createRun("too-many-attempts", 2, {
          maxAttempts: RUN_RESOURCE_LIMITS.maxAttempts + 1,
        }),
      ),
    ).rejects.toThrow(`${RUN_RESOURCE_LIMITS.maxAttempts}`);
  });

  it("lists newest runs in bounded filtered pages", async () => {
    const runs = createRunsStore({}, () => 10);
    await runs.save(createRun("old", 1));
    await runs.save(createRun("middle", 2, { status: "failed" }));
    await runs.save(createRun("new", 3));

    await expect(runs.list({ limit: 2 })).resolves.toMatchObject([
      { id: "new" },
      { id: "middle" },
    ]);
    await expect(runs.list({ offset: 1, limit: 1 })).resolves.toMatchObject([
      { id: "middle" },
    ]);
    await expect(runs.list({ status: "failed" })).resolves.toMatchObject([
      { id: "middle" },
    ]);
    const newest = await runs.get("new");
    const oneRunBudget = jsonUtf8ByteLength(newest) + 2;
    await expect(
      runs.list({ limit: 3, maxBytes: oneRunBudget }),
    ).resolves.toMatchObject([{ id: "new" }]);
    await expect(
      runs.list({ limit: RUN_RESOURCE_LIMITS.maxListLimit + 1 }),
    ).rejects.toThrow(`${RUN_RESOURCE_LIMITS.maxListLimit}`);
  });

  it("prunes the oldest terminal run and cascades related records", async () => {
    const now = 1_000_000;
    const runs = createRunsStore(
      { maxStoredRuns: 2, maxRunsPerFlow: 2, maxPruneRunsPerWrite: 2 },
      () => now,
    );
    const events = createEventsStore();
    const queue = createQueueStore();
    const artifacts = createIndexedDbArtifactStore({}, () => now);

    const oldest = createRun("run-old", now - 3);
    await runs.save(oldest);
    await events.append({ runId: oldest.id, type: "run.resumed" });
    await queue.enqueue({ id: oldest.id, flowId: oldest.flowId });
    await artifacts.saveScreenshot({
      runId: oldest.id,
      nodeId: "node-1",
      base64: "aGVsbG8=",
    });
    await runs.save(createRun("run-middle", now - 2));

    await runs.save(
      createRun("run-new", now - 1, {
        status: "queued",
        finishedAt: undefined,
      }),
    );

    await expect(runs.get(oldest.id)).resolves.toBeNull();
    await expect(events.list(oldest.id)).resolves.toEqual([]);
    await expect(queue.get(oldest.id)).resolves.toBeNull();
    await expect(artifacts.listByRun(oldest.id)).resolves.toEqual([]);
    await expect(runs.list({ limit: 10 })).resolves.toHaveLength(2);
  });

  it("applies backpressure instead of deleting active runs", async () => {
    const runs = createRunsStore({ maxStoredRuns: 2, maxRunsPerFlow: 2 });
    await runs.save(
      createRun("run-1", 1, { status: "queued", finishedAt: undefined }),
    );
    await runs.save(
      createRun("run-2", 2, { status: "running", finishedAt: undefined }),
    );

    await expect(
      runs.save(
        createRun("run-3", 3, { status: "queued", finishedAt: undefined }),
      ),
    ).rejects.toThrow('Cannot store more than 2 runs for flow "flow-1"');
    await expect(runs.get("run-1")).resolves.not.toBeNull();
    await expect(runs.get("run-2")).resolves.not.toBeNull();
  });
});
