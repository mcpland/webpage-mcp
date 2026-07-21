import assert from "node:assert/strict";
import { test } from "node:test";

import { findMcpBundleAdvisories } from "./audit-mcp-bundle.mjs";

function report(version) {
  return {
    metadata: { vulnerabilities: { high: 1 } },
    advisories: {
      1: {
        module_name: "zod",
        severity: "high",
        title: "synthetic advisory",
        findings: [{ version }],
      },
    },
  };
}

test("bundle advisory filtering matches the exact distributed version", () => {
  const components = new Map([["zod", "3.25.76"]]);
  assert.deepEqual(findMcpBundleAdvisories(report("3.25.76"), components), [
    {
      name: "zod",
      version: "3.25.76",
      severity: "high",
      title: "synthetic advisory",
    },
  ]);
  assert.deepEqual(findMcpBundleAdvisories(report("4.0.0"), components), []);
});

test("bundle advisory filtering rejects malformed audit output", () => {
  assert.throws(
    () => findMcpBundleAdvisories({ error: "registry unavailable" }, new Map()),
    /unsupported report/,
  );
});
