import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import {
  assertSameMcpNpmClosure,
  parseMcpNpmShrinkwrap,
} from "./mcp-npm-shrinkwrap.mjs";

const INTEGRITY = `sha512-${Buffer.alloc(64, 9).toString("base64")}`;

function sourcePackage(overrides = {}) {
  return {
    name: "webpage-mcp",
    version: "1.2.3",
    license: "MIT",
    engines: { node: ">=22.0.0" },
    dependencies: { chalk: "5.4.1" },
    overrides: { chalk: "5.4.1" },
    ...overrides,
  };
}

function shrinkwrap(overrides = {}) {
  const raw = {
    name: "webpage-mcp",
    version: "1.2.3",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "webpage-mcp",
        version: "1.2.3",
        license: "MIT",
        hasInstallScript: true,
        engines: { node: ">=22.0.0" },
        dependencies: { chalk: "5.4.1" },
      },
      "node_modules/chalk": {
        version: "5.4.1",
        resolved: "https://registry.npmjs.org/chalk/-/chalk-5.4.1.tgz",
        integrity: INTEGRITY,
        license: "MIT",
      },
    },
    ...overrides,
  };
  return Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
}

test("MCP shrinkwrap binds an exact source manifest to an integrity-pinned closure", () => {
  const parsed = parseMcpNpmShrinkwrap(shrinkwrap(), {
    sourcePackage: sourcePackage(),
  });
  assert.deepEqual(
    [...parsed.components],
    [
      [
        "chalk@5.4.1",
        {
          name: "chalk",
          version: "5.4.1",
          resolved: "https://registry.npmjs.org/chalk/-/chalk-5.4.1.tgz",
          integrity: INTEGRITY,
          paths: new Set(),
          lockPaths: new Set(["node_modules/chalk"]),
        },
      ],
    ],
  );
});

test("MCP shrinkwrap rejects ranged source dependencies", () => {
  assert.throws(
    () =>
      parseMcpNpmShrinkwrap(shrinkwrap(), {
        sourcePackage: sourcePackage({ dependencies: { chalk: "^5.4.1" } }),
      }),
    /must pin chalk to an exact stable version/,
  );
});

test("MCP shrinkwrap rejects a root dependency locked to another version", () => {
  const raw = JSON.parse(shrinkwrap());
  raw.packages["node_modules/chalk"].version = "5.4.0";
  assert.throws(
    () =>
      parseMcpNpmShrinkwrap(Buffer.from(`${JSON.stringify(raw, null, 2)}\n`), {
        sourcePackage: sourcePackage(),
      }),
    /root dependency chalk is not locked to its declared version/,
  );
});

test("MCP shrinkwrap rejects unreachable or non-registry packages", () => {
  const unreachable = JSON.parse(shrinkwrap());
  unreachable.packages["node_modules/stale"] = {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/stale/-/stale-1.0.0.tgz",
    integrity: INTEGRITY,
  };
  assert.throws(
    () =>
      parseMcpNpmShrinkwrap(
        Buffer.from(`${JSON.stringify(unreachable, null, 2)}\n`),
        { sourcePackage: sourcePackage() },
      ),
    /contains unreachable packages/,
  );

  const external = JSON.parse(shrinkwrap());
  external.packages["node_modules/chalk"].resolved =
    "https://example.test/chalk.tgz";
  assert.throws(
    () =>
      parseMcpNpmShrinkwrap(
        Buffer.from(`${JSON.stringify(external, null, 2)}\n`),
        { sourcePackage: sourcePackage() },
      ),
    /canonical npm registry/,
  );
});

test("MCP shrinkwrap detects drift in the freshly resolved closure", () => {
  const committed = parseMcpNpmShrinkwrap(shrinkwrap(), {
    sourcePackage: sourcePackage(),
  });
  const driftedRaw = JSON.parse(shrinkwrap());
  driftedRaw.packages["node_modules/chalk"].integrity =
    `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
  const drifted = parseMcpNpmShrinkwrap(
    Buffer.from(`${JSON.stringify(driftedRaw, null, 2)}\n`),
    { sourcePackage: sourcePackage() },
  );

  assert.doesNotThrow(() => assertSameMcpNpmClosure(committed, committed));
  assert.throws(
    () => assertSameMcpNpmClosure(committed, drifted),
    /fresh npm resolution drifted/,
  );
});
