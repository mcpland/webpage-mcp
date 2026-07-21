const SECURITY_BODY_FIELDS = [
  "Threat",
  "Impact",
  "Completeness",
  "Verification",
];

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
  plugins: [{ rules: { "security-audit-body": securityAuditBody } }],
  rules: {
    "security-audit-body": [2, "always"],
  },
};
