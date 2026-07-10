import { beforeEach, describe, expect, it } from "vitest";

import {
  PERSISTENT_VAR_RESOURCE_LIMITS,
  closeRrV3Db,
  deleteRrV3Db,
  type PersistentVariableName,
} from "@/entrypoints/background/record-replay-v3";
import { createPersistentVarsStore } from "@/entrypoints/background/record-replay-v3/storage/persistent-vars";

function persistentName(value: string): PersistentVariableName {
  return value as PersistentVariableName;
}

describe("V3 persistent variable storage bounds", () => {
  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();
  });

  it("persists versioned values and lists by prefix", async () => {
    const store = createPersistentVarsStore();

    await store.set("$profile.name", "Ada");
    await store.set("$profile.role", "admin");
    const updated = await store.set("$profile.name", "Grace");
    await store.set("$other", true);

    expect(updated.version).toBe(2);
    await expect(store.get("$profile.name")).resolves.toMatchObject({
      value: "Grace",
      version: 2,
    });
    await expect(store.list("$profile")).resolves.toEqual([
      expect.objectContaining({ key: "$profile.name" }),
      expect.objectContaining({ key: "$profile.role" }),
    ]);
  });

  it("rejects invalid keys and oversized values before writing", async () => {
    const store = createPersistentVarsStore();
    const invalidKey = persistentName("profile");
    const oversizedKey = persistentName(
      `$${"k".repeat(PERSISTENT_VAR_RESOURCE_LIMITS.maxKeyUtf8Bytes)}`,
    );
    const oversizedValue = "v".repeat(
      PERSISTENT_VAR_RESOURCE_LIMITS.maxStringUtf8Bytes + 1,
    );

    await expect(store.set(invalidKey, "value")).rejects.toThrow(
      "persistent variable key must be a string starting with $",
    );
    await expect(store.set(oversizedKey, "value")).rejects.toThrow(
      `${PERSISTENT_VAR_RESOURCE_LIMITS.maxKeyUtf8Bytes}-byte string limit`,
    );
    await expect(store.set("$oversized", oversizedValue)).rejects.toThrow(
      `${PERSISTENT_VAR_RESOURCE_LIMITS.maxStringUtf8Bytes}-byte string limit`,
    );
    await expect(store.get("$oversized")).resolves.toBeUndefined();
  });

  it("caps the number of entries while still allowing existing keys to update", async () => {
    const store = createPersistentVarsStore();
    for (
      let index = 0;
      index < PERSISTENT_VAR_RESOURCE_LIMITS.maxEntries;
      index += 1
    ) {
      await store.set(persistentName(`$entry-${index}`), index);
    }

    await expect(store.set("$overflow", true)).rejects.toThrow(
      `maximum ${PERSISTENT_VAR_RESOURCE_LIMITS.maxEntries}`,
    );
    await expect(store.set("$entry-0", "updated")).resolves.toMatchObject({
      value: "updated",
      version: 2,
    });
    await expect(store.list()).resolves.toHaveLength(
      PERSISTENT_VAR_RESOURCE_LIMITS.maxEntries,
    );
  });
});
