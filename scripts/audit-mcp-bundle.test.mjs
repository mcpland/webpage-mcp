import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findEmbeddedComponentAdvisories,
  findMcpBundleAdvisories,
} from "./audit-mcp-bundle.mjs";

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
      githubAdvisoryId: undefined,
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

test("embedded component audit maps exact npm bulk advisories", () => {
  const components = new Map([["sharp", "0.34.5"]]);
  assert.deepEqual(
    findEmbeddedComponentAdvisories(
      {
        sharp: [
          {
            title: "reviewed Sharp advisory",
            severity: "high",
            url: "https://github.com/advisories/GHSA-f88m-g3jw-g9cj",
          },
        ],
      },
      components,
    ),
    [
      {
        name: "sharp",
        version: "0.34.5",
        severity: "high",
        title: "reviewed Sharp advisory",
        githubAdvisoryId: "GHSA-f88m-g3jw-g9cj",
      },
    ],
  );
});

test("embedded component audit fails closed on unknown components", () => {
  assert.throws(
    () =>
      findEmbeddedComponentAdvisories(
        { unexpected: [] },
        new Map([["sharp", "0.34.5"]]),
      ),
    /unsupported report/,
  );
});
