---
type: runbook
title: Chrome Web Store Release and Privacy Checklist
description: Required human checks before uploading, submitting, or rolling out the Chrome extension.
owner: unadlib
status: proposed
risk_level: high
tags: [chrome-web-store, release, privacy, compliance]
---

# Chrome Web Store Release and Privacy Checklist

Complete this checklist for every Chrome Web Store upload, review submission,
and rollout. A green repository pipeline is necessary but is not approval to
publish.

The repository release workflow builds and verifies the extension ZIP, creates
GitHub release assets, and can publish the npm package. It does not read, update,
or validate the external Chrome Web Store Developer Dashboard, store listing,
privacy answers, review state, or rollout state. No Chrome Web Store API
validation is configured in this repository. The publisher must perform and
record the dashboard checks below.

## Release-blocking public-listing observation

On July 11, 2026, the public listing showed version `0.9.0` and stated: “The
developer has disclosed that it will not collect or use your data.” This is a
dated observation, not a permanent status flag. It does not match the
extension's handling of website content, screenshots, browsing activity,
network data, files, settings, workflow records, or local logs. Chrome's policy
defines handling broadly and requires disclosure even when data stays on the
user's device.

Before the next upload or rollout, the publisher must correct the Developer
Dashboard privacy declarations and confirm that the resulting public listing
matches the extension, [`PRIVACY.md`](../PRIVACY.md), and the prominent
pre-install disclosure. After any correction, determine status from a fresh
dashboard and public-listing check; do not infer that the dated statement above
is still live.

## Manual release gate

Record each item as `PASS`, `BLOCKED`, or `N/A` with a reason. Any unchecked or
`BLOCKED` item blocks upload, submission, and rollout.

### 1. Release identity and evidence

- [ ] Record the reviewer, UTC date, target item ID, commit, tag, and intended
      extension version.
- [ ] Record links or access-controlled screenshots for the Store Listing,
      Privacy, Package, Distribution, and review/rollout pages. Never commit
      credentials, tokens, private user data, or unredacted diagnostic logs.
- [ ] Confirm the target is the official item
      `iehgbogeakiedihodennfcnigojnncag`, not a test listing.

### 2. Single purpose, listing, and pre-install disclosure

- [ ] The dashboard single-purpose statement is narrow, understandable, and
      matches the shipped product: browser-native automation through the local
      Webpage MCP connector and its related user-facing workflows and Agent
      surfaces.
- [ ] The title, summary, description, category, support link, and every claimed
      capability match the uploaded ZIP. Remove stale, incomplete, or
      unsupported claims.
- [ ] At least one current screenshot is present, and all screenshots show the
      actual current UI and core experience. Replace screenshots that omit or
      misrepresent material onboarding, workflow, Agent, or permission behavior.
- [ ] Before installation, the listing prominently discloses the user-data
      categories handled and how they are used. A privacy-policy link or the
      post-install welcome page alone is not the pre-install disclosure.
- [ ] Confirm that the installation flow obtains the affirmative and informed
      consent required for the disclosed handling; do not treat a disclosure
      shown only after installation as that consent.
- [ ] The post-install welcome disclosure remains consistent with the listing
      and privacy policy, including automatic runs from workflows or triggers
      the user previously enabled.

### 3. Privacy declarations and data categories

- [ ] Review every current dashboard data category against actual extension
      behavior. “The developer does not receive it” and “it stays local” do not
      mean the extension does not handle it.
- [ ] Map the current dashboard choices to all applicable categories in
      [`PRIVACY.md`](../PRIVACY.md), including website and form content,
      screenshots/media, URLs and browsing history, bookmarks and tab state,
      network request/response data, files and downloads, Agent/MCP content,
      settings, workflow/trigger/run records, diagnostics, native logs, and
      engine-managed session records.
- [ ] Account for data sent to user-selected MCP clients, AI providers,
      websites, endpoints, artifact hosts, and support services. Dashboard
      answers, listing text, and the privacy policy must describe the same
      boundaries.
- [ ] The public listing no longer makes a “will not collect or use” claim when
      the current package handles user data. Verify the live result rather than
      relying on a saved screenshot or this document.
- [ ] The dashboard privacy-policy URL is public, works without authentication,
      and resolves to the policy for this product. [`PRIVACY.md`](../PRIVACY.md)
      has a real owner, has been reviewed for this release, and has
      `status: accepted` before submission.
- [ ] The privacy policy contains the Chrome Web Store Limited Use commitment,
      the project homepage links directly to that policy, and all collection,
      use, transfer, and human-access practices are necessary for the disclosed
      single purpose.

### 4. Permissions and remote code

- [ ] Inspect `manifest.json` from the exact ZIP. Every permission and host
      permission has an accurate dashboard justification tied to the single
      purpose; remove any unused permission before release.
- [ ] Give specific justification for broad or sensitive access, including
      `<all_urls>`, `nativeMessaging`, `tabs`, `scripting`, `userScripts`,
      `downloads`, `webRequest`, `webNavigation`, `debugger`, `history`, and
      `bookmarks`. Do not substitute a generic “required for functionality”
      statement.
- [ ] Re-evaluate the dashboard remote-code answer from the shipped ZIP. Confirm
      that executable logic is packaged with the extension or falls within a
      documented Manifest V3 exception; remote resources must not silently
      supply executable logic.
- [ ] If relying on the User Scripts API exception, explain that boundary
      accurately and verify that it applies only to code executed through that
      API. The rest of the package must still comply with the remote-code rule.
- [ ] Confirm the extension's remote endpoints and model-artifact behavior match
      the listing and privacy policy and remain compatible with Limited Use.

### 5. Version and ZIP

- [ ] The tag, `app/chrome-extension/package.json`,
      `app/mcp-server/package.json`, ZIP filename, and ZIP `manifest.json`
      version all match the intended stable `x.y.z` release.
- [ ] The release used `CHROME_EXTENSION_PUBLIC_KEY`, and the packaged manifest
      derives the official extension ID. Never upload a private key or a ZIP
      built for an unpacked/test ID.
- [ ] Run the repository release checks and build the ZIP from the reviewed
      commit:

      ```bash
      pnpm test:release
      pnpm --filter webpage-mcp-connector lint
      pnpm --filter webpage-mcp-connector compile
      pnpm --filter webpage-mcp-connector test
      pnpm --filter webpage-mcp-connector zip
      ```

- [ ] Record the exact ZIP path, byte size, and SHA-256 digest. Inspect the ZIP
      rather than a working directory and confirm it contains no secrets,
      private keys, unreviewed source maps, test fixtures, or unrelated files.
- [ ] On real Linux, Windows, and macOS installations, load the exact packaged
      extension, install and register the matching npm tarball, open the
      browser, and confirm the extension connects to the registered native host
      and completes a basic health/tool request. The release workflow exercises
      each built `run_host.sh` or `run_host.bat` with a native ping/pong frame,
      but it does not launch an installed browser or validate the browser
      profile, extension origin, and registered-manifest handshake. Record this
      manual evidence; a green platform matrix does not close that blind spot.
- [ ] Upload only that recorded ZIP. After upload, confirm the dashboard Package
      tab reports the expected version and permissions before submitting it for
      review.

### 6. Submission and rollout

- [ ] Re-open the current official policies on the submission day. In
      particular, account for the July 2026 updates whose enforcement begins on
      August 1, 2026: collection must be necessary for the single purpose, all
      collection must be prominently disclosed, and later data-practice changes
      require proactive disclosure.
- [ ] Use deferred publishing when appropriate. Do not proceed with rollout
      while a listing, privacy answer, permission explanation, policy URL, or
      package check is unresolved.
- [ ] After publication, verify the live version, listing, screenshots, privacy
      statement, privacy-policy link, and support link. Record the result and
      stop rollout if the public page differs from the approved evidence.

## Release evidence record

Copy this block into the release issue or another access-controlled review
record. Do not fill it with secrets or user data.

```text
Reviewer:
Checked at (UTC):
Item ID:
Commit/tag/version:
ZIP path / bytes / SHA-256:
Dashboard evidence:
Public listing evidence:
Privacy policy URL and accepted revision:
Result (PASS or BLOCKED):
Open blockers:
```

## Verification

- Repository artifact and version checks are implemented in
  [`scripts/release-preflight.mjs`](../scripts/release-preflight.mjs) and
  [`.github/workflows/release.yml`](../.github/workflows/release.yml).
- Extension permissions and host access are defined in
  [`app/chrome-extension/wxt.config.ts`](../app/chrome-extension/wxt.config.ts).
- Privacy behavior and human-review status are documented in
  [`PRIVACY.md`](../PRIVACY.md).
- Store listing, dashboard privacy answers, policy acceptance, review state, and
  rollout state remain human-verified external evidence. Repository CI does not
  validate them.

## Citations

- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Chrome Web Store 2026 policy updates](https://developer.chrome.com/blog/cws-policy-updates-2026)
- [Disclosure Requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements/)
- [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/)
- [Manifest V3 remote-code requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- [Chrome Web Store publishing guide](https://developer.chrome.com/docs/webstore/publish/)
- [Chrome Web Store listing guidance](https://developer.chrome.com/docs/webstore/best-listing)
- [Webpage MCP Connector public listing](https://chromewebstore.google.com/detail/webpage-mcp-connector/iehgbogeakiedihodennfcnigojnncag?hl=en)
