import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildBuilderTriggerSpecs,
  isBuilderManagedTriggerForFlow,
  syncBuilderManagedTriggers,
} from "@/entrypoints/shared/utils/builder-trigger-sync";
import { getNodeSpec } from "../../../../packages/shared/src/node-spec-registry";
import { registerBuiltinSpecs } from "../../../../packages/shared/src/node-specs-builtin";
import { STEP_TYPES } from "../../../../packages/shared/src/step-types";

describe("builder trigger sync", () => {
  beforeAll(() => {
    registerBuiltinSpecs();
  });

  it("turns a builder trigger node into a manual trigger by default", () => {
    const triggers = buildBuilderTriggerSpecs({
      id: "flow-1",
      name: "Test Flow",
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          config: { enabled: true },
        },
      ],
    });

    expect(triggers).toEqual([
      expect.objectContaining({
        id: "builder_trg_flow-1_trigger-1_manual",
        kind: "manual",
        enabled: true,
        flowId: "flow-1",
      }),
    ]);
  });

  it("builds enabled V3 trigger specs for configured trigger modes", () => {
    const triggers = buildBuilderTriggerSpecs(
      {
        id: "draft",
        name: "Saved Flow",
        nodes: [
          {
            id: "trigger-1",
            type: "trigger",
            config: {
              enabled: true,
              modes: {
                manual: false,
                url: true,
                contextMenu: true,
                dom: true,
                schedule: true,
              },
              url: {
                rules: [{ kind: "domain", value: "example.com" }],
              },
              contextMenu: { title: "Run saved flow" },
              dom: { selector: ".ready", debounceMs: "250" },
              schedules: [
                {
                  id: "every-five",
                  type: "interval",
                  periodMinutes: "5",
                },
              ],
            },
          },
        ],
      },
      "saved-flow",
      "Saved Flow",
    );

    expect(triggers.map((trigger) => trigger.kind)).toEqual([
      "url",
      "contextMenu",
      "dom",
      "interval",
    ]);
    expect(triggers[0]).toEqual(
      expect.objectContaining({
        id: "builder_trg_saved-flow_trigger-1_url",
        match: [{ kind: "domain", value: "example.com" }],
      }),
    );
    expect(triggers[2]).toEqual(
      expect.objectContaining({
        selector: ".ready",
        debounceMs: 250,
      }),
    );
    expect(triggers[3]).toEqual(
      expect.objectContaining({
        periodMinutes: 5,
      }),
    );
  });

  it("uses nested section enabled flags to opt into optional trigger modes", () => {
    const triggers = buildBuilderTriggerSpecs({
      id: "flow-1",
      name: "Test Flow",
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          config: {
            enabled: true,
            modes: { manual: false },
            contextMenu: { enabled: true, title: "Run from menu" },
            command: { enabled: true, commandKey: "run-test-flow" },
            dom: { enabled: true, selector: ".ready" },
          },
        },
      ],
    });

    expect(triggers.map((trigger) => trigger.kind)).toEqual([
      "contextMenu",
      "command",
      "dom",
    ]);
  });

  it("lets nested section enabled flags suppress enabled trigger modes", () => {
    const triggers = buildBuilderTriggerSpecs({
      id: "flow-1",
      name: "Test Flow",
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          config: {
            enabled: true,
            modes: {
              manual: false,
              contextMenu: true,
              command: true,
              dom: true,
            },
            contextMenu: { enabled: false, title: "Run from menu" },
            command: { enabled: false, commandKey: "run-test-flow" },
            dom: { enabled: false, selector: ".ready" },
          },
        },
      ],
    });

    expect(triggers).toEqual([]);
  });

  it("rejects URL trigger mode without a concrete URL rule", () => {
    expect(() =>
      buildBuilderTriggerSpecs({
        id: "flow-1",
        name: "Test Flow",
        nodes: [
          {
            id: "trigger-1",
            type: "trigger",
            config: {
              modes: { manual: false, url: true },
              url: { rules: [] },
            },
          },
        ],
      }),
    ).toThrow(/URL mode needs at least one URL rule/);
  });

  it("only exposes schedule types supported by builder trigger sync", () => {
    const triggerSpec = getNodeSpec(STEP_TYPES.TRIGGER);
    const schedulesField = triggerSpec?.schema.find(
      (field) => field.key === "schedules",
    ) as any;
    const typeField = schedulesField?.item?.fields.find(
      (field: any) => field.key === "type",
    );

    expect(typeField?.options.map((option: any) => option.value)).toEqual([
      "once",
      "interval",
    ]);
  });

  it("recognizes only builder-managed triggers for the same flow", () => {
    expect(
      isBuilderManagedTriggerForFlow(
        {
          id: "builder_trg_flow-1_trigger-1_manual",
          flowId: "flow-1",
        },
        "flow-1",
      ),
    ).toBe(true);
    expect(
      isBuilderManagedTriggerForFlow(
        {
          id: "builder_trg_flow-1_trigger-1_manual",
          flowId: "flow-2",
        },
        "flow-1",
      ),
    ).toBe(false);
    expect(
      isBuilderManagedTriggerForFlow(
        {
          id: "manual_trigger",
          flowId: "flow-1",
        },
        "flow-1",
      ),
    ).toBe(false);
  });

  it("syncs desired builder triggers before deleting stale builder-managed triggers", async () => {
    const existingDesired = {
      id: "builder_trg_flow-1_trigger-1_manual",
      kind: "manual",
      enabled: true,
      flowId: "flow-1",
    };
    const staleBuilderTrigger = {
      id: "builder_trg_flow-1_trigger-1_url",
      kind: "url",
      enabled: true,
      flowId: "flow-1",
      match: [{ kind: "domain", value: "old.example" }],
    };
    const externalTrigger = {
      id: "manual-user-trigger",
      kind: "manual",
      enabled: true,
      flowId: "flow-1",
    };
    const newDesired = {
      id: "builder_trg_flow-1_trigger-1_context_menu",
      kind: "contextMenu",
      enabled: true,
      flowId: "flow-1",
      title: "Run flow",
    };
    const request = vi.fn(async (method: string) => {
      if (method === "rr_v3.listTriggers") {
        return [existingDesired, staleBuilderTrigger, externalTrigger];
      }
      return {};
    });

    await syncBuilderManagedTriggers({ request } as any, "flow-1" as any, [
      existingDesired as any,
      newDesired as any,
    ]);

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "rr_v3.listTriggers",
      "rr_v3.updateTrigger",
      "rr_v3.createTrigger",
      "rr_v3.deleteTrigger",
    ]);
    expect(request).toHaveBeenLastCalledWith("rr_v3.deleteTrigger", {
      triggerId: staleBuilderTrigger.id,
    });
  });

  it("does not delete stale builder triggers when desired trigger sync fails", async () => {
    const staleBuilderTrigger = {
      id: "builder_trg_flow-1_trigger-1_url",
      kind: "url",
      enabled: true,
      flowId: "flow-1",
      match: [{ kind: "domain", value: "old.example" }],
    };
    const desired = {
      id: "builder_trg_flow-1_trigger-1_manual",
      kind: "manual",
      enabled: true,
      flowId: "flow-1",
    };
    const request = vi.fn(async (method: string) => {
      if (method === "rr_v3.listTriggers") {
        return [staleBuilderTrigger];
      }
      if (method === "rr_v3.createTrigger") {
        throw new Error("storage unavailable");
      }
      return {};
    });

    await expect(
      syncBuilderManagedTriggers({ request } as any, "flow-1" as any, [
        desired as any,
      ]),
    ).rejects.toThrow("storage unavailable");

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "rr_v3.listTriggers",
      "rr_v3.createTrigger",
    ]);
  });
});
