# Streamable HTTP MCP Access (Optional)

Webpage MCP supports an opt-in
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)
gateway for either a local HTTP client or an authorized client on another machine.

The default local setup has not changed. If `webpage-mcp-server` is not running, no TCP port is
opened and MCP clients continue to use `webpage-mcp-stdio`:

```text
Default local path (recommended)
MCP client ── stdio ──> webpage-mcp-stdio
                              │
                              └── authenticated local IPC ──> Chrome Native Messaging host ──> Connector

Optional local HTTP path
Local MCP client ── HTTP on 127.0.0.1 ──> webpage-mcp-server
                                                   │
                                                   └── authenticated local IPC ──> the same host ──> Connector

Optional remote HTTP path
Remote MCP client ── HTTPS/private network ──> webpage-mcp-server
                                                     │
                                                     └── authenticated local IPC ──> the same host ──> Connector
```

The HTTP process is a gateway, not a replacement for Chrome Native Messaging. Chrome still launches
the registered native host, and the Connector must be enabled and connected. Both stdio and HTTP
gateways use the same authenticated local socket or Windows pipe behind the scenes.

## Choose a Transport

| Situation                                                     | Recommended transport         |
| ------------------------------------------------------------- | ----------------------------- |
| The MCP client runs on the same computer as Chrome            | `webpage-mcp-stdio`           |
| A local client specifically requires Streamable HTTP          | Loopback HTTP on `127.0.0.1`  |
| The MCP client runs on another trusted computer               | HTTPS or a private tunnel/VPN |
| The listener would be exposed directly to the public internet | Do not deploy it that way     |

The stdio and HTTP gateways can run at the same time for different clients. For one MCP client,
normally configure only one Webpage MCP transport so the same browser tools do not appear twice.

## Prerequisites

- Node.js 22 or newer (Node.js 24 LTS recommended).
- Google Chrome 135 or newer.
- The Webpage MCP Connector installed and enabled.
- Chrome open with the Connector showing that its Native connection is connected.

The published-package commands below run the current npm release. End users do not need to clone or
build this repository.

## Local Loopback HTTP with Codex

Use this flow when Chrome, the Connector, `webpage-mcp-server`, and Codex all run on the same
computer, but Codex should connect through Streamable HTTP instead of stdio.

### 1. Create a Persistent Bearer Token

Every HTTP listener requires a dedicated token, including a listener bound only to `127.0.0.1`.
Keep the token private and reuse the same value on the server and client sides.

macOS or Linux:

```bash
install -d -m 700 "$HOME/.config/webpage-mcp"
(umask 077 && openssl rand -base64 32 > "$HOME/.config/webpage-mcp/remote-token")
```

Windows PowerShell:

```powershell
$webpageMcpConfigDir = Join-Path $HOME ".config\webpage-mcp"
$webpageMcpTokenPath = Join-Path $webpageMcpConfigDir "remote-token"
New-Item -ItemType Directory -Force $webpageMcpConfigDir | Out-Null
$webpageMcpTokenBytes = New-Object byte[] 32
$webpageMcpRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $webpageMcpRng.GetBytes($webpageMcpTokenBytes)
} finally {
  $webpageMcpRng.Dispose()
}
[Convert]::ToBase64String($webpageMcpTokenBytes) |
  Set-Content -NoNewline -Encoding ascii -Path $webpageMcpTokenPath
```

Do not regenerate this file on every start. If the token changes, every configured client must receive
the new value.

### 2. Start the Published HTTP Gateway

Run this on the same computer as Chrome.

macOS or Linux:

```bash
npx -y -p webpage-mcp@latest webpage-mcp-server \
  --host 127.0.0.1 \
  --port 12306 \
  --token-file "$HOME/.config/webpage-mcp/remote-token"
```

Windows PowerShell:

```powershell
npx -y -p webpage-mcp@latest webpage-mcp-server `
  --host 127.0.0.1 `
  --port 12306 `
  --token-file "$HOME/.config/webpage-mcp/remote-token"
```

The equivalent main-CLI form is:

```bash
npx -y webpage-mcp@latest webpage-mcp-server \
  --host 127.0.0.1 \
  --port 12306 \
  --token-file "$HOME/.config/webpage-mcp/remote-token"
```

The gateway prints its MCP and readiness URLs when it starts. Keep this process running; `Ctrl+C`
stops the listener and disconnects HTTP MCP clients. A Codex `url` configuration connects to an
already-running server and does not launch this command for you.

The default endpoint is:

```text
http://127.0.0.1:12306/mcp
```

Loopback HTTP does not require `--allowed-host`, TLS, or `--allow-insecure-http`.

### 3. Verify the Listener and Chrome Bridge

In the terminal that will launch Codex, load the token without printing it.

macOS or Linux:

```bash
export WEBPAGE_MCP_REMOTE_TOKEN="$(
  tr -d '\r\n' < "$HOME/.config/webpage-mcp/remote-token"
)"

curl --fail http://127.0.0.1:12306/healthz
curl --fail \
  -H "Authorization: Bearer ${WEBPAGE_MCP_REMOTE_TOKEN}" \
  http://127.0.0.1:12306/readyz
```

Windows PowerShell:

```powershell
$webpageMcpTokenPath = Join-Path $HOME ".config\webpage-mcp\remote-token"
$env:WEBPAGE_MCP_REMOTE_TOKEN = (Get-Content -Raw $webpageMcpTokenPath).Trim()

Invoke-RestMethod -Uri http://127.0.0.1:12306/healthz
Invoke-RestMethod `
  -Uri http://127.0.0.1:12306/readyz `
  -Headers @{ Authorization = "Bearer $env:WEBPAGE_MCP_REMOTE_TOKEN" } `
  -Method Get
```

`/healthz` returning `200` proves only that the HTTP listener is alive. `/readyz` returning `200`
proves that the gateway can also reach the configured Connector instance through the native bridge.

### 4. Configure Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers."webpage-mcp-http"]
url = "http://127.0.0.1:12306/mcp"
bearer_token_env_var = "WEBPAGE_MCP_REMOTE_TOKEN"
tool_timeout_sec = 120
```

Or add the same entry with the Codex CLI:

```bash
codex mcp add webpage-mcp-http \
  --url http://127.0.0.1:12306/mcp \
  --bearer-token-env-var WEBPAGE_MCP_REMOTE_TOKEN
```

Start or restart Codex from an environment that contains `WEBPAGE_MCP_REMOTE_TOKEN`. The macOS/Linux
`export` or PowerShell assignment in the previous step applies to Codex started from that terminal.
The token value does not belong in `config.toml`, the URL, or a query parameter.

If the same Codex installation already has a `webpage-mcp-stdio` entry, either disable/remove that
entry while testing HTTP or deliberately use distinct server names. Do not put `command`/`args` and
`url` in the same MCP server table.

After restarting Codex, use `/mcp` to confirm that `webpage-mcp-http` is enabled.
See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp) for current
client-side configuration options.

### 5. Start It Again Later

For future sessions:

1. Open Chrome and ensure the Connector is connected.
2. Start `webpage-mcp-server` with the same token file and keep it running.
3. Load `WEBPAGE_MCP_REMOTE_TOKEN` into the Codex process environment.
4. Start Codex.

This repository does not currently install `webpage-mcp-server` as a launchd, systemd, or Windows
service. Operators who place it behind a service manager remain responsible for the process
environment, token-file permissions, restart policy, logs, and orderly shutdown.

## Local Loopback HTTP with Other MCP Clients

Choose the client's **Streamable HTTP** transport and configure:

```text
URL: http://127.0.0.1:12306/mcp
Authorization: Bearer <the value stored in remote-token>
```

Client configuration keys are not standardized. Use that client's documentation for its URL and
header/token settings. Do not use an stdio `command` entry unless the client lacks Streamable HTTP
support and you intentionally deploy a separate HTTP-to-stdio proxy.

## Local Repository Build (Developers)

Use this section only when testing an unpublished checkout. Published-package users should use the
`npx` commands above.

From the repository root:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build:mcp

node app/mcp-server/dist/mcp/mcp-server-http.js \
  --host 127.0.0.1 \
  --port 12306 \
  --token-file "$HOME/.config/webpage-mcp/remote-token"
```

The HTTP URL and client configuration are identical to the published-package loopback flow. Starting
the built server also runs the Native Messaging bootstrap against the built runtime.

## Private-Network or Remote Setup

Run `webpage-mcp-server` on the computer running Chrome and the Connector. The MCP client connects to
that gateway from another trusted computer.

Binding outside loopback deliberately requires all of the following:

- A dedicated remote bearer token.
- An explicit allowed `Host` hostname or IP when listening on `0.0.0.0` or `::`.
- TLS, or the explicit `--allow-insecure-http` acknowledgement.
- Host firewall and network rules that limit who can reach the listener.

### Direct TLS Listener

The preferred direct-listener setup uses TLS:

```bash
npx -y -p webpage-mcp@latest webpage-mcp-server \
  --host 0.0.0.0 \
  --port 12306 \
  --allowed-host mcp-host.example.internal \
  --token-file "$HOME/.config/webpage-mcp/remote-token" \
  --tls-cert /path/to/fullchain.pem \
  --tls-key /path/to/private-key.pem
```

The TLS key and token file must be owned by the current user and inaccessible to group/other users on
Unix. Token files may not be symlinks. A token must contain 32–16,384 UTF-8 bytes and use HTTP Bearer
token characters.

Configure Codex on the client computer with the externally reachable URL:

```toml
[mcp_servers."webpage-mcp-http"]
url = "https://mcp-host.example.internal:12306/mcp"
bearer_token_env_var = "WEBPAGE_MCP_REMOTE_TOKEN"
tool_timeout_sec = 120
```

Transfer the token to the client through a secure channel and set `WEBPAGE_MCP_REMOTE_TOKEN` in the
environment of the Codex process. Do not copy the server's token-file path into the client
configuration; the two computers do not share that file.

For another Streamable HTTP client, configure the same externally reachable URL and header:

```text
URL: https://mcp-host.example.internal:12306/mcp
Authorization: Bearer <the securely transferred token>
```

### TLS-Terminating Proxy or Private Tunnel

If a trusted private reverse proxy terminates TLS, or a private VPN/tunnel protects the
client-to-host path, keep the gateway loopback-bound behind that component and allow the hostname
that reaches the gateway:

```bash
npx -y -p webpage-mcp@latest webpage-mcp-server \
  --host 127.0.0.1 \
  --allowed-host mcp-host.example.internal \
  --token-file "$HOME/.config/webpage-mcp/remote-token"
```

Keep proxy-to-gateway traffic on the same trusted host and preserve, or deliberately set, the allowed
`Host` header.

If plaintext transport across a private network is unavoidable, it must be acknowledged explicitly:

```bash
npx -y -p webpage-mcp@latest webpage-mcp-server \
  --host 0.0.0.0 \
  --allowed-host 192.168.1.50 \
  --token-file "$HOME/.config/webpage-mcp/remote-token" \
  --allow-insecure-http
```

Plain HTTP exposes the bearer token and browser data to anyone able to observe that network path. Do
not publish this listener directly to the internet. Prefer a private VPN/tunnel, TLS, host firewall
rules, and a narrowly scoped network allowlist.

## Health and Readiness

The listener exposes three routes:

| Route      | Purpose                                                               | Authentication                                    |
| ---------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `/mcp`     | Stateful MCP Streamable HTTP (`POST`, `GET`, and `DELETE`)            | Bearer token required                             |
| `/healthz` | Process/listener liveness; does not touch Chrome or the native bridge | Public, but still protected by Host/Origin checks |
| `/readyz`  | Pings the local native bridge for the configured `instanceId`         | Bearer token required                             |

Remote example:

```bash
curl --fail https://mcp-host.example.internal:12306/healthz
curl --fail \
  -H "Authorization: Bearer ${WEBPAGE_MCP_REMOTE_TOKEN}" \
  https://mcp-host.example.internal:12306/readyz
```

Check `/readyz` before connecting an MCP client. A `503` response means the HTTP process is alive but
the extension/native-host path is unavailable.

## Host and Origin Rules

`--allowed-host` values are hostnames or IP addresses without a scheme or port. The hostname in the
client's URL must appear in the allowlist. This protects wildcard listeners against DNS rebinding and
unexpected reverse-proxy aliases.

Requests without an `Origin` header are supported for normal server-to-server MCP clients. If a
client sends `Origin`, add each exact HTTP(S) origin with `--allowed-origin`; all other origins are
rejected. This option does not enable CORS, and the gateway is not intended to be called directly by
arbitrary web pages.

Examples:

```bash
--allowed-host mcp-host.example.internal \
--allowed-host 192.168.1.50 \
--allowed-origin https://trusted-agent.example.internal
```

## Options and Environment Variables

| CLI option                    | Environment variable                 | Meaning                                                   |
| ----------------------------- | ------------------------------------ | --------------------------------------------------------- |
| `--host <host>`               | `WEBPAGE_MCP_REMOTE_HOST`            | Listen address; default `127.0.0.1`                       |
| `--port <port>`               | `WEBPAGE_MCP_REMOTE_PORT`            | Listen port; default `12306`                              |
| `--instance-id <id>`          | `WEBPAGE_MCP_INSTANCE_ID`            | Connector instance to route to; default `default`         |
| `--token-file <file>`         | `WEBPAGE_MCP_REMOTE_TOKEN_FILE`      | Read the required bearer token from a private file        |
| —                             | `WEBPAGE_MCP_REMOTE_TOKEN`           | Required dedicated bearer token value                     |
| repeatable `--allowed-host`   | `WEBPAGE_MCP_REMOTE_ALLOWED_HOSTS`   | Accepted Host names; env list is comma/whitespace split   |
| repeatable `--allowed-origin` | `WEBPAGE_MCP_REMOTE_ALLOWED_ORIGINS` | Exact browser origins; env list is comma/whitespace split |
| `--tls-cert <file>`           | `WEBPAGE_MCP_REMOTE_TLS_CERT`        | PEM certificate                                           |
| `--tls-key <file>`            | `WEBPAGE_MCP_REMOTE_TLS_KEY`         | Private PEM key                                           |
| `--allow-insecure-http`       | —                                    | Acknowledge plaintext use outside loopback                |

There is intentionally no `--token` argument, which keeps credentials out of process listings.
Every listener requires either a token file or `WEBPAGE_MCP_REMOTE_TOKEN`; a token file takes
precedence.

`WEBPAGE_MCP_REMOTE_TOKEN` is separate from the legacy `WEBPAGE_MCP_AUTH_TOKEN`. The latter is
exposed to the extension UI and is not an authorization check for MCP calls; it does not satisfy the
HTTP listener's token requirement.

## Runtime and Lifecycle Boundaries

- Each initialized HTTP client receives an isolated MCP/native-bridge session ID.
- Up to 64 HTTP sessions and 128 active HTTP requests are accepted by default.
- Idle sessions are removed after 30 minutes.
- Request bodies are limited to 1 MiB; local IPC responses retain their existing 16 MiB bound.
- Successful workflow mutations broadcast `tools/list_changed` to connected HTTP sessions.
- `SIGINT` and `SIGTERM` stop accepting traffic and close active sessions.
- Authentication is static bearer-token authentication. This gateway does not implement OAuth or
  per-user authorization.
- The listener exists only while `webpage-mcp-server` is running.
- Starting the gateway performs the same Native Messaging runtime/manifest bootstrap as the stdio
  entry, but it does not open Chrome or connect the extension for you.

Treat every authorized HTTP MCP client as a privileged browser operator. It can receive page content
and screenshots and invoke tools with real browser or network side effects.

## Upgrades and Version Compatibility

The Chrome extension and npm package are released from the same repository, but Chrome Web Store
review and rollout timing may cause their versions to differ temporarily. Nearby versions are
intended to remain compatible; matching versions provide the strongest compatibility guarantee.

`@latest` resolves the current npm package whenever the gateway command starts. Its startup bootstrap
refreshes the stable Native Messaging runtime on disk. An already-running Chrome Native Host process
does not hot-reload replaced JavaScript. After an npm upgrade, reconnect the Connector's Native
connection or fully restart Chrome if `/readyz` returns `503`, the IPC credential is missing, or tools
remain unavailable. MCP client configuration does not normally need to change while the published bin
name, endpoint, and authentication contract remain stable.

## Troubleshooting

### Connection refused or the MCP client cannot reach `/mcp`

Confirm that `webpage-mcp-server` is still running and that the client's URL includes the `/mcp`
path. A URL-based MCP configuration does not launch the server process.

### `401 Unauthorized`

Verify that the client sends `Authorization: Bearer <token>`, that both sides use the same token, and
that the token was not placed in the URL. `WEBPAGE_MCP_AUTH_TOKEN` is not the HTTP token.

### `403 Forbidden Host`

The hostname or IP in the client URL is not allowed. Add that hostname without its port using
`--allowed-host`. With a wildcard listen address, at least one explicit allowed host is mandatory.

### `403 Forbidden Origin`

The client sent an `Origin` header that was not explicitly allowed. Add its exact scheme, hostname,
and port using `--allowed-origin`, or use a normal server-side MCP client that does not synthesize a
browser Origin.

### `/healthz` works but `/readyz` returns `503`

The HTTP process is running but cannot ping the Native Messaging bridge:

1. Open Chrome and enable the Webpage MCP Connector.
2. Connect or reconnect Native Messaging from the extension.
3. After upgrading the npm package, fully restart Chrome so the Native Host loads the refreshed
   runtime.
4. Run `npx -y webpage-mcp@latest doctor --fix` if the bridge still does not connect.
5. If `WEBPAGE_MCP_NATIVE_SOCKET` is customized, ensure the Native Host and gateway use the same
   value.

### The same Webpage MCP tools appear twice

The client has both stdio and HTTP Webpage MCP entries enabled. Disable one entry, or keep both only
when the duplicate transport namespaces are intentional.

### TLS or startup validation fails

Provide both certificate and key files. On Unix, remove group/other access from the key and token file
with `chmod 600 <file>`. Every listener requires an HTTP token; non-loopback listeners require TLS
unless `--allow-insecure-http` is explicitly acknowledged.
