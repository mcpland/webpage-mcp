---
type: domain-rule
title: Webpage MCP Privacy Policy
description: How Webpage MCP handles browser, Agent, diagnostic, and locally stored data.
owner: unadlib
status: proposed
risk_level: high
tags: [privacy, chrome-extension, mcp, agent]
---

# Webpage MCP Privacy Policy

Webpage MCP turns a user-controlled Chrome browser into a local automation and
Model Context Protocol (MCP) workspace. This policy describes the data handled
by the Webpage MCP Connector extension and the companion `webpage-mcp` native
host. It applies to the software distributed from this repository; separately
configured MCP clients, AI providers, websites, and other services apply their
own privacy terms.

## Core boundary

Webpage MCP does not operate a hosted relay for extension traffic. The extension
communicates with the companion process through Chrome Native Messaging, and
the companion communicates with an MCP client through local IPC and stdio.

Local transport does not mean that every operation is offline. Data leaves the
device when the user invokes a feature that sends it externally or when a
workflow or trigger the user previously enabled runs an action that sends data
to a connected MCP client, an optional AI provider, a requested website or
endpoint, or a model-artifact host. The user controls which clients, providers,
pages, actions, workflows, and triggers are placed inside that boundary.

## Data handled

Webpage MCP may handle the following data when it is necessary for a feature the
user invokes or for a workflow or trigger the user previously enabled that later
runs:

| Category                          | Examples                                                                                                                                             | When it is handled                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Website content and form data     | Page text, DOM and accessibility data, selected text, element metadata, form values, page titles, and URLs                                           | Reading, searching, editing, recording, replaying, or automating a page, including during an enabled trigger run |
| Images and media                  | Page or element screenshots, image attachments, generated GIF recordings, and workflow screenshot artifacts                                          | A screenshot, attachment, visual Agent, recording, or screenshot-enabled workflow runs                           |
| Browser activity and organization | Open tabs and windows, browsing history, bookmarks, navigation state, and download metadata                                                          | The corresponding browser tool runs or a previously enabled workflow or trigger accesses it                      |
| Network and developer data        | Request and response URLs, headers, bodies, timing, status, errors, console output, and performance traces                                           | Network capture, console, debugging, performance, or workflow HTTP actions run                                   |
| Files and workspace data          | User-selected uploads, downloads, attachment contents, file names, workspace paths, and code-editing context                                         | A file, download, Agent attachment, apply-to-code feature, or enabled workflow upload or download runs           |
| Agent and MCP content             | Prompts, tool inputs and results, project and session metadata, messages, model selections, and engine configuration                                 | The user connects an MCP client or starts a Claude or Codex Agent action                                         |
| Settings and diagnostics          | Extension preferences, workflow and trigger definitions, workflow run and event history, feature state, errors, bounded logs, and diagnostic reports | The product is configured, a workflow or trigger is saved or runs, or diagnostics are requested                  |

Some browser tools operate in the user's existing signed-in browser context.
Websites may therefore receive the cookies and credentials Chrome would
normally send for that navigation or request. Network captures, console output,
screenshots, page content, and tool results can also contain authentication
tokens, personal communications, or other sensitive data. Webpage MCP does not
create a separate cookie or password database, but users should treat captured
and returned data as potentially sensitive.

## Processing and destinations

### Local extension and native processing

Browser tools run in the extension and return results through the local native
bridge. Saved workflows and triggers, workflow run history and artifacts,
preferences, semantic indexes, model caches, and Agent state may be processed
and stored locally. The developer does not receive this local product data by
default.

### Connected MCP clients

Tool inputs and results are delivered to the MCP client that the user configured.
That client may send them to its own model provider or another service. Users
must review the client's configuration, privacy policy, retention, and security
controls before granting it access to sensitive pages.

### Optional AI providers

Quick Panel, Web Editor, and other Agent features can pass prompts, relevant
page context, screenshots or attachments, and tool results through the native
host to the user-selected Claude or Codex engine. Depending on the user's engine
configuration, this may transmit data to Anthropic, OpenAI, or a compatible
endpoint chosen by the user. Webpage MCP does not select that provider on the
user's behalf, and provider-side retention and training settings are controlled
by the provider and the user's account or endpoint configuration.

### Websites and requested endpoints

Navigation, form submission, browser fetch, upload, download, and workflow
actions send data to the website or endpoint named by the user or workflow.
These actions may run immediately when the user invokes them or later when a
workflow or trigger the user previously enabled fires. Those destinations
receive the same categories of information needed to perform the action and
apply their own privacy practices.

### Model artifacts

Semantic search performs embedding inference and vector indexing locally.
Tokenizer and configuration files and ONNX model binaries are downloaded from
Hugging Face at immutable commit revisions when needed. Downloaded ONNX binaries
are additionally checked against a checked-in expected size and SHA-256 digest
before being cached. Tokenizer and configuration files are revision-pinned but
do not have a separate Webpage MCP SHA-256 manifest. Page content is not sent to
Hugging Face for embedding inference. The artifact request necessarily exposes
ordinary connection metadata, such as the device IP address, to the artifact
host.

### Support and diagnostics

Diagnostic reports stay local unless the user chooses to copy, save, or share
them. The registered native-host wrapper automatically creates local wrapper
and stderr logs when Chrome launches the registered host. A diagnostic report
can list redacted log-file metadata, but it omits log contents by default; tail
or full log contents are included only when the user explicitly selects that
`--include-logs` mode. Reports redact common secrets and paths by default, but
automated redaction cannot guarantee removal of every sensitive value. Users
must review a report before sharing it. Information voluntarily submitted
through a public issue or support email is received and retained by the
corresponding GitHub or email service.

## Local storage and retention

- Extension storage within the Chrome profile may contain preferences, saved
  workflows and trigger definitions, workflow run and event history, recording
  data, screenshot artifacts, semantic indexes, search metadata, and cached
  model artifacts. It remains until the user clears it, clears the Chrome
  profile, or uninstalls the extension, subject to Chrome's own storage
  behavior.
- Agent projects, sessions, messages, attachments, and workspace state are kept
  locally under `~/.webpage-mcp-agent` by default, or at a path the user
  configures. They remain until the user deletes the corresponding data or the
  local files.
- The selected Agent engine may also retain its own session records outside
  Webpage MCP's data directory. The current Claude integration leaves Claude
  Agent SDK session persistence enabled, so Claude Code stores session
  transcripts under the `projects` area of its own configuration and data
  directory and may store other session state elsewhere in that directory. Its
  base directory defaults to `~/.claude` and can be changed with
  `CLAUDE_CONFIG_DIR`. The current Codex integration invokes the Codex CLI
  without ephemeral mode, so Codex can retain session rollout files in its own
  data area, whose base is `CODEX_HOME` and is commonly `~/.codex`. These
  engine-managed records follow the engine's retention and deletion controls.
  Deleting `~/.webpage-mcp-agent`, a Webpage MCP project, or a Webpage MCP
  session does not delete them.
- Normal registered native-host launches automatically create wrapper and
  stderr logs in the platform log directory. The files use restrictive
  permissions, per-file byte limits, and bounded per-family retention. They are
  not automatically redacted and can contain paths or other diagnostic data,
  but they are not uploaded automatically.
- Files downloaded, exported, or copied by a user-invoked action or a previously
  enabled workflow or trigger remain in the destination selected by Chrome, the
  user, or the workflow until removed there.
- Connected clients, providers, websites, artifact hosts, GitHub, and email
  services control their own retention. This project cannot delete data held by
  those independent services; users must use each service's controls.

The project does not maintain a hosted account database from which it can
retrieve or delete locally stored Webpage MCP data on a user's behalf.

## Sharing and disclosure

Webpage MCP shares or transmits data only as needed for the user-facing actions
described above, when the user chooses to send diagnostics or support material,
or when required by law. It does not sell or rent user data, use browser data
for advertising, build advertising profiles, or use data to determine
creditworthiness.

No employee or other human is given routine access to locally processed browser
or Agent data. A human may see data only when the user deliberately submits it
for support or when disclosure is legally required. Users must not include
secrets or unrelated personal data in public issue reports.

## Security

Webpage MCP limits the native bridge to local Native Messaging, local IPC, and
stdio; uses private permissions for product-owned native files; bounds native
logs and protocol payloads; pins remote semantic assets to immutable revisions;
verifies downloaded ONNX binaries; and validates release artifacts. These
controls reduce risk but cannot make browser automation risk-free. A connected
client or Agent can act with broad browser permissions, and a user-configured
provider or endpoint receives whatever the user sends to it.

Users should connect only trusted MCP clients and providers, keep Agent sandbox
and permission settings constrained, avoid sensitive pages when they are not
needed, review workflow actions and destinations before running them or enabling
their triggers, and keep Chrome and Webpage MCP up to date.

## User controls

Users can:

- disable or uninstall the extension, stop the MCP client, or disconnect the
  native bridge to stop further processing;
- revoke extension permissions and avoid enabling optional user-script, Agent,
  semantic-search, capture, or debugging features;
- disable or delete workflow triggers to stop their future automatic runs;
- choose the MCP client, Claude or Codex engine, compatible endpoint, model, and
  Agent permission or sandbox settings;
- use **Clear All Data** in the extension to remove semantic page indexes,
  vector data, and related search metadata while preserving model preferences;
- stop Webpage MCP and manually remove native Agent data, logs, exported files,
  or downloads from their documented local locations when those records are no
  longer needed;
- use Claude Code or Agent SDK controls and Codex CLI controls to manage
  engine-maintained session data separately from Webpage MCP data;
- keep log contents out of diagnostic reports with the default
  `--include-logs=none` mode and review or edit a report before sharing it; and
- use the controls offered by each connected provider or website for data that
  service retains.

## Chrome Web Store Limited Use commitment

The use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies),
including the Limited Use requirements. Webpage MCP uses that information only
to provide or improve its single-purpose, user-facing browser automation,
workflow, Agent, semantic-search, and diagnostic features. It does not use or
transfer Chrome user data for personalized advertising, retargeting, unrelated
profiling, credit decisions, or other prohibited purposes.

Any material change to these practices must be disclosed in this policy, in the
product interface when required, and in the Chrome Web Store privacy disclosures
before the changed handling begins.

## Contact

Privacy questions may be sent to `unadlib@gmail.com`. Product issues may also be
reported through [GitHub Issues](https://github.com/mcpland/webpage-mcp/issues),
but users should not post page content, credentials, private logs, or other
sensitive information in a public issue.

## Verification and human review

- The requested Chrome capabilities are defined in
  [`app/chrome-extension/wxt.config.ts`](app/chrome-extension/wxt.config.ts).
- Local Agent storage boundaries are defined in
  [`app/mcp-server/src/agent/storage.ts`](app/mcp-server/src/agent/storage.ts),
  native log capture is implemented in
  [`app/mcp-server/src/scripts/native-log-runner.ts`](app/mcp-server/src/scripts/native-log-runner.ts),
  and native log limits and retention are defined in
  [`app/mcp-server/src/scripts/native-log-policy.ts`](app/mcp-server/src/scripts/native-log-policy.ts).
- External engine session behavior follows the invocation options in
  [`app/mcp-server/src/agent/engines/claude.ts`](app/mcp-server/src/agent/engines/claude.ts)
  and
  [`app/mcp-server/src/agent/engines/codex.ts`](app/mcp-server/src/agent/engines/codex.ts).
- Automatic workflow trigger kinds and their enabled-state boundary are defined
  in
  [`app/chrome-extension/entrypoints/background/record-replay-v3/domain/triggers.ts`](app/chrome-extension/entrypoints/background/record-replay-v3/domain/triggers.ts)
  and
  [`app/chrome-extension/entrypoints/background/record-replay-v3/engine/triggers/trigger-manager.ts`](app/chrome-extension/entrypoints/background/record-replay-v3/engine/triggers/trigger-manager.ts).
- Semantic data deletion is implemented in
  [`app/chrome-extension/entrypoints/background/storage-manager.ts`](app/chrome-extension/entrypoints/background/storage-manager.ts).
- Semantic asset revision and ONNX integrity boundaries are defined in
  [`app/chrome-extension/utils/model-assets.ts`](app/chrome-extension/utils/model-assets.ts)
  and covered by
  [`app/chrome-extension/tests/security/model-asset-integrity.test.ts`](app/chrome-extension/tests/security/model-asset-integrity.test.ts).
- Diagnostic log-content defaults, disclosure, and redaction behavior are
  defined in
  [`app/mcp-server/src/scripts/report.ts`](app/mcp-server/src/scripts/report.ts)
  and covered by
  [`app/mcp-server/src/scripts/report-privacy.test.ts`](app/mcp-server/src/scripts/report-privacy.test.ts).
- Human review is required before changing the Chrome Web Store privacy fields
  or marking this policy `accepted`.

## Citations

- [Chrome Web Store policy updates for 2026](https://developer.chrome.com/blog/cws-policy-updates-2026)
- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Claude Code application data and cleanup controls](https://code.claude.com/docs/en/claude-directory)
- [Codex CLI command and persistence reference](https://developers.openai.com/codex/cli/reference)
