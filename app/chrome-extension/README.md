# WXT + React

This extension uses WXT with React-based entrypoints.

The native bridge is local, but Agent providers, model downloads, and browser
network tools can create external data flows. Review the repository
[privacy and data-flow boundaries](../../README.md#privacy-and-data-flows)
before enabling the extension on sensitive pages.

## Stable extension identity

Chrome's manifest `key` field accepts a public key only. Never provide a PEM
private key. For an unpacked development build that must use the Chrome Web
Store identity, copy `.env.example` to the gitignored `.env.local` file and set
`CHROME_EXTENSION_PUBLIC_KEY` to the single-line base64 DER SubjectPublicKeyInfo
body from the Chrome Web Store **View public key** dialog.

The key is optional for ordinary local development; without it, Chrome assigns
an unpacked-build ID that is not the official stable ID. Formal GitHub releases
set `WEBPAGE_MCP_REQUIRE_EXTENSION_PUBLIC_KEY=true` and fail unless the Actions
repository variable `CHROME_EXTENSION_PUBLIC_KEY` is present, valid, and matches
the key embedded in the release ZIP. The release also verifies that the public
key derives the official extension ID configured as
`CHROME_EXTENSION_EXPECTED_ID`. The public key is safe to expose, but a private
key must never be stored in an environment file, repository variable, build
output, or release artifact.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/)
- TypeScript and ESLint extensions
