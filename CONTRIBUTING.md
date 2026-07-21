# Contributing

## Commit metadata

Use Conventional Commits. Keep independently verifiable changes in separate
commits and explain behavior-changing decisions in the commit body.

Changes to trust boundaries, authorization, secret handling, native messaging,
process execution, release publication, dependency integrity, or persistent
data safety must use the `security` scope, for example
`fix(security): reject unbound release tags`.

Every `security`-scoped commit body must contain non-empty fields with these
exact labels:

```text
Threat: What an attacker, hostile page, malformed input, or failed lifecycle can do.

Impact: Which users, data, privileges, artifacts, or availability are affected.

Completeness: Why the fix covers every equivalent entry point and cleanup path.

Verification: The regression tests and end-to-end checks that exercise the boundary.
```

The commit-msg hook enforces this locally. Pull-request CI validates the whole
PR commit range, so bypassing the local hook does not bypass the contract.

## Pull requests

Describe the user-visible outcome, list the verification commands actually
run, and complete the security section in the pull-request template. If a
change is intentionally not security-sensitive, say why; do not leave the
assessment implicit.
