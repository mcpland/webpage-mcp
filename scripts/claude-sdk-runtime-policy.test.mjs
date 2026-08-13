import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadClaudeSdkRuntimePolicy,
  parseClaudeSdkRuntimePolicy,
  partitionMitigatedAdvisories,
} from "./claude-sdk-runtime-policy.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("Claude runtime policy pins the embedded Sharp and exact mitigation", () => {
  const policy = loadClaudeSdkRuntimePolicy(repositoryRoot);
  assert.equal(policy.raw.sdk.version, "0.3.231");
  assert.equal(policy.embeddedComponents.get("sharp"), "0.34.5");
  assert.deepEqual(
    policy.mitigations.get("GHSA-f88m-g3jw-g9cj")?.blockedFormats,
    ["GIF", "TIFF", "VIPS"],
  );
});

test("Claude runtime policy rejects advisory or component drift", () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, "scripts/claude-sdk-runtime-policy.json"),
    "utf8",
  );
  const raw = JSON.parse(source);
  raw.embeddedComponents.sharp = "0.35.0";
  assert.throws(
    () => parseClaudeSdkRuntimePolicy(`${JSON.stringify(raw, null, 2)}\n`),
    /does not match the reviewed boundary/,
  );
});

test("only the exact reviewed Sharp advisory is classified as mitigated", () => {
  const policy = loadClaudeSdkRuntimePolicy(repositoryRoot);
  const reviewed = {
    name: "sharp",
    version: "0.34.5",
    githubAdvisoryId: "GHSA-f88m-g3jw-g9cj",
  };
  const result = partitionMitigatedAdvisories(
    [
      reviewed,
      { ...reviewed, githubAdvisoryId: "GHSA-unreviewed" },
      { ...reviewed, version: "0.34.4" },
    ],
    policy.mitigations,
  );
  assert.deepEqual(result.mitigated, [reviewed]);
  assert.equal(result.active.length, 2);
});
