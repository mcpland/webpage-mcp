import { describe, expect, it } from "vitest";

import { RR_ERROR_CODES } from "@/entrypoints/background/record-replay-v3/domain/errors";
import {
  applyDefaultStabilityPolicy,
  flowDefaultRetryTouchesSideEffects,
  isRetryableStabilityErrorCode,
  safeRetryNodesMissingPolicy,
} from "@/entrypoints/background/tools/flow-retry-policy";

describe("workflow retry policy", () => {
  it("moves global retry onto safe nodes without retrying side effects", () => {
    const flow = {
      nodes: [
        { id: "wait", kind: "wait", config: { ms: 100 } },
        { id: "click", kind: "click", config: { selector: "#submit" } },
      ],
      policy: {
        defaultNodePolicy: {
          retry: { retries: 3, intervalMs: 10 },
        },
      },
    } as any;

    expect(flowDefaultRetryTouchesSideEffects(flow)).toBe(true);
    expect(safeRetryNodesMissingPolicy(flow).map((node) => node.id)).toEqual([
      "wait",
    ]);

    const changes = applyDefaultStabilityPolicy(flow);

    expect(changes.map((change) => change.code)).toEqual(
      expect.arrayContaining([
        "default_timeout_added",
        "global_retry_scoped_to_safe_nodes",
        "default_retry_added",
        "failure_screenshot_added",
      ]),
    );
    expect(flow.policy.defaultNodePolicy.retry).toBeUndefined();
    expect(flow.nodes[0].policy.retry).toMatchObject({ retries: 3 });
    expect(flow.nodes[1].policy).toBeUndefined();
  });

  it("keeps the retryable stability error set explicit", () => {
    expect(isRetryableStabilityErrorCode(RR_ERROR_CODES.TARGET_NOT_FOUND)).toBe(
      true,
    );
    expect(
      isRetryableStabilityErrorCode(RR_ERROR_CODES.PERMISSION_DENIED),
    ).toBe(false);
  });
});
