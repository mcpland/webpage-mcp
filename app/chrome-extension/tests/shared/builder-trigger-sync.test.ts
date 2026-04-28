import { describe, expect, it } from "vitest";

import {
  buildBuilderTriggerSpecs,
  isBuilderManagedTriggerForFlow,
} from "@/entrypoints/shared/utils/builder-trigger-sync";

describe("builder trigger sync", () => {
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
});
