import { describe, expect, it } from "vitest";

import {
  getStabilizeSafetyBoundary,
  isAllowedPublicStartUrl,
  normalizeBoundaryStrings,
  validateUrlAgainstStabilizeBoundary,
} from "@/entrypoints/background/tools/flow-safety-boundary";

describe("workflow stabilize safety boundaries", () => {
  it("normalizes declared boundary values without inventing entries", () => {
    expect(
      normalizeBoundaryStrings([" example.test ", "", 42, " /app/ "]),
    ).toEqual(["example.test", "/app/"]);
    expect(normalizeBoundaryStrings({ value: "example.test" })).toEqual([]);
  });

  it("only accepts HTTP(S) start URLs", () => {
    expect(isAllowedPublicStartUrl(" https://example.test/app ")).toBe(true);
    expect(isAllowedPublicStartUrl("http://example.test")).toBe(true);
    expect(isAllowedPublicStartUrl("file:///private/data")).toBe(false);
    expect(isAllowedPublicStartUrl("not a URL")).toBe(false);
  });

  it("requires host, origin, and path constraints to all match when declared", () => {
    const boundary = getStabilizeSafetyBoundary({
      safety: {
        allowedHosts: ["example.test"],
        testEnvironment: {
          origins: ["https://staging.example.test/"],
          pathPrefixes: ["/app/"],
        },
      },
    });

    expect(
      validateUrlAgainstStabilizeBoundary(
        "https://staging.example.test/app/orders",
        boundary,
        "/startUrl",
        "startUrl",
      ),
    ).toBeUndefined();
    expect(
      validateUrlAgainstStabilizeBoundary(
        "https://staging.example.test/application",
        boundary,
        "/startUrl",
        "startUrl",
      ),
    ).toMatchObject({ code: "START_URL_OUTSIDE_TEST_ENVIRONMENT" });
    expect(
      validateUrlAgainstStabilizeBoundary(
        "https://example.test/app/orders",
        boundary,
        "/tabId",
        "target tab URL",
      ),
    ).toMatchObject({ code: "REPLAY_URL_OUTSIDE_TEST_ENVIRONMENT" });
  });

  it("accepts exact hosts and subdomains but not suffix lookalikes", () => {
    const boundary = getStabilizeSafetyBoundary({
      safety: { allowedHosts: ["example.test"] },
    });

    expect(
      validateUrlAgainstStabilizeBoundary(
        "https://api.example.test/",
        boundary,
        "/startUrl",
        "startUrl",
      ),
    ).toBeUndefined();
    expect(
      validateUrlAgainstStabilizeBoundary(
        "https://notexample.test/",
        boundary,
        "/startUrl",
        "startUrl",
      ),
    ).toMatchObject({ code: "START_URL_OUTSIDE_TEST_ENVIRONMENT" });
  });
});
