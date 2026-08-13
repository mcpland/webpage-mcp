import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const config = require("../commitlint.config.cjs");
const rule = config.plugins[0].rules["security-audit-body"];
const legacyIgnore = config.ignores[0];

const LEGACY_SECURITY_MESSAGE =
  "fix(deps): resolve audited vulnerabilities\n\n" +
  "Upgrade Vitest, Drizzle ORM, and UUID to patched supported lines and " +
  "constrain vulnerable transitive packages to compatible secure " +
  "versions.\\n\\nReduce pnpm audit from 90 advisories (48 production, 45 " +
  "development) to zero across full, production, and development scans.";

test("non-security commits do not need the security audit body", () => {
  assert.deepEqual(rule({ scope: "extension", body: null }), [true]);
});

test("security commits identify every missing audit field", () => {
  const [valid, message] = rule({
    scope: "security",
    body: "Threat: malicious page input\n\nImpact: extension service worker",
  });

  assert.equal(valid, false);
  assert.match(message, /Completeness, Verification/);
});

test("security commits record threat, impact, completeness, and verification", () => {
  assert.deepEqual(
    rule({
      scope: "security",
      body: [
        "Threat: A page can forge a MAIN-world response.",
        "Impact: Tool output consumed by the MCP client.",
        "Completeness: The trusted wrapper labels every MAIN response.",
        "Verification: Forgery regression test and extension typecheck.",
      ].join("\n\n"),
    }),
    [true, ""],
  );
});

test("only exact published legacy messages bypass current commit rules", () => {
  assert.equal(legacyIgnore(LEGACY_SECURITY_MESSAGE), true);
  assert.equal(legacyIgnore(`${LEGACY_SECURITY_MESSAGE}\n`), true);
  assert.equal(legacyIgnore(`${LEGACY_SECURITY_MESSAGE}\n\n`), true);
  assert.equal(legacyIgnore("Move pnpm overrides into workspace config"), true);
  assert.equal(legacyIgnore(`${LEGACY_SECURITY_MESSAGE} changed`), false);
  assert.equal(
    legacyIgnore("Move pnpm overrides into workspace config."),
    false,
  );
  assert.equal(legacyIgnore("future nonconventional message"), false);
});
