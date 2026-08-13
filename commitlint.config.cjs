const SECURITY_BODY_FIELDS = [
  "Threat",
  "Impact",
  "Completeness",
  "Verification",
];

// These messages are already published between v0.9.0 and the current branch.
// Keep the baseline byte-exact rather than rewriting public history or relaxing
// rules for future commits. 39956b2 contains literal "\\n" text; a4d4de0 has
// no Conventional Commit prefix.
const LEGACY_PUBLISHED_MESSAGES = new Set([
  "fix(deps): resolve audited vulnerabilities\n\n" +
    "Upgrade Vitest, Drizzle ORM, and UUID to patched supported lines and " +
    "constrain vulnerable transitive packages to compatible secure " +
    "versions.\\n\\nReduce pnpm audit from 90 advisories (48 production, 45 " +
    "development) to zero across full, production, and development scans.",
  "Move pnpm overrides into workspace config",
]);

function isLegacyPublishedMessage(message) {
  const trailingNewlines = message.endsWith("\n\n")
    ? 2
    : message.endsWith("\n")
      ? 1
      : 0;
  const normalized = trailingNewlines
    ? message.slice(0, -trailingNewlines)
    : message;
  return LEGACY_PUBLISHED_MESSAGES.has(normalized);
}

function securityAuditBody(parsed) {
  if (parsed.scope !== "security") return [true];
  const body = parsed.body || "";
  const missing = SECURITY_BODY_FIELDS.filter(
    (field) => !new RegExp(`^${field}:\\s+\\S.*$`, "m").test(body),
  );
  return [
    missing.length === 0,
    missing.length === 0
      ? ""
      : `security commits require non-empty body fields: ${missing.join(", ")}`,
  ];
}

module.exports = {
  extends: ["@commitlint/config-conventional"],
  ignores: [isLegacyPublishedMessage],
  plugins: [{ rules: { "security-audit-body": securityAuditBody } }],
  rules: {
    "security-audit-body": [2, "always"],
  },
};
