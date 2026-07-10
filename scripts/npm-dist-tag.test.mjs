import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveNpmDistTag } from "./npm-dist-tag.mjs";

test("stable versions publish to latest", () => {
  assert.equal(resolveNpmDistTag("1.2.3"), "latest");
  assert.equal(resolveNpmDistTag("1.2.3+build.7"), "latest");
});

test("prerelease versions publish to their channel", () => {
  assert.equal(resolveNpmDistTag("1.2.3-beta.4"), "beta");
  assert.equal(resolveNpmDistTag("1.2.3-RC.1"), "rc");
  assert.equal(resolveNpmDistTag("1.2.3-canary-build.9"), "canary-build");
});

test("unsafe prerelease channel names fall back to next", () => {
  assert.equal(resolveNpmDistTag("1.2.3-0"), "next");
  assert.equal(resolveNpmDistTag("1.2.3-latest.1"), "next");
});

test("invalid versions fail closed", () => {
  assert.throws(() => resolveNpmDistTag("v1.2.3"), /Invalid semantic version/);
  assert.throws(() => resolveNpmDistTag("1.2"), /Invalid semantic version/);
});
