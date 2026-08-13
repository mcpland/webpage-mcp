# Remote MCP Access (Optional)

Webpage MCP can expose this computer's browser tools to an MCP client on another computer through an opt-in [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) gateway.

The default local setup has not changed. If `webpage-mcp-server` is not running, no TCP port is opened and MCP clients continue to use `webpage-mcp-stdio`:

```text
Default local path
MCP client ── stdio ──> webpage-mcp-stdio
                              │
                              └── authenticated local IPC ──> Chrome Native Messaging host ──> Connector

Optional remote path
Remote MCP client ── Streamable HTTP ──> webpage-mcp-server
                                                 │
                                                 └── authenticated local IPC ──> the same native host ──> Connector
```

The HTTP process is a gateway, not a replacement for Chrome Native Messaging. Chrome still launches the registered native host, and the Connector must be enabled and connected. Both stdio and HTTP gateways use the same authenticated local socket or Windows pipe behind the scenes.

## Local-Only Quick Start

The main CLI accepts the `webpage-mcp-server` subcommand requested by `npx` users:

```bash
npx -y webpage-mcp@latest webpage-mcp-server
```

The equivalent standalone bin is:

```bash
npx -y -p webpage-mcp@latest webpage-mcp-server
```

Both commands listen on `127.0.0.1:12306` by default. Configure a local Streamable HTTP client with:

```text
http://127.0.0.1:12306/mcp
```

No bearer token is required for the default loopback-only listener. Starting this command also performs the same Native Messaging registration/bootstrap check as the stdio entry. It does not make Chrome launch the native host; keep Chrome open and connect the extension.

## Private-Network Setup

Binding outside loopback deliberately requires all of the following:

- A dedicated remote bearer token.
- An explicit allowed `Host` hostname or IP when listening on `0.0.0.0` or `::`.
- TLS, or the explicit `--allow-insecure-http` acknowledgement.

Create a private token file on macOS or Linux:

```bash
install -d -m 700 "$HOME/.config/webpage-mcp"
(umask 077 && openssl rand -base64 32 > "$HOME/.config/webpage-mcp/remote-token")
```

The preferred direct-listener setup uses TLS:

```bash
npx -y webpage-mcp@latest webpage-mcp-server \
  --host 0.0.0.0 \
  --port 12306 \
  --allowed-host mcp-host.example.internal \
  --token-file "$HOME/.config/webpage-mcp/remote-token" \
  --tls-cert /path/to/fullchain.pem \
  --tls-key /path/to/private-key.pem
```

The TLS key and token file must be owned by the current user and inaccessible to group/other users on Unix. Token files may not be symlinks. A token must contain 32–16,384 UTF-8 bytes and use HTTP Bearer token characters.

If a trusted private reverse proxy terminates TLS, or a private VPN/tunnel protects the client-to-host path, bind the gateway to loopback behind that component and allow the hostname that reaches the gateway:

```bash
npx -y webpage-mcp@latest webpage-mcp-server \
  --host 127.0.0.1 \
  --allowed-host mcp-host.example.internal \
  --token-file "$HOME/.config/webpage-mcp/remote-token"
```

Keep proxy-to-gateway traffic on the same trusted host and preserve (or deliberately set) the allowed Host header. If plaintext transport across a private network is unavoidable, it must be acknowledged explicitly:

```bash
WEBPAGE_MCP_REMOTE_TOKEN='replace-with-at-least-32-random-characters' \
  npx -y webpage-mcp@latest webpage-mcp-server \
    --host 0.0.0.0 \
    --allowed-host 192.168.1.50 \
    --allow-insecure-http
```

Plain HTTP exposes the bearer token and browser data to anyone able to observe that network path. Do not publish this listener directly to the internet. Prefer a private VPN/tunnel, TLS, host firewall rules, and a narrowly scoped network allowlist.

## Configure the Remote MCP Client

The client must use the complete endpoint URL, including `/mcp`, and send the token as an HTTP header:

```text
URL: https://mcp-host.example.internal:12306/mcp
Authorization: Bearer <the remote token>
```

Do not put the token in the URL or a query parameter. Query-string tokens are not accepted.

### Codex

Codex supports Streamable HTTP servers and bearer tokens through `config.toml`. Put the token in the environment of the computer running Codex, then configure:

```toml
[mcp_servers.webpage_mcp_remote]
url = "https://mcp-host.example.internal:12306/mcp"
bearer_token_env_var = "WEBPAGE_MCP_REMOTE_TOKEN"
tool_timeout_sec = 120
```

The ChatGPT desktop app, Codex CLI, and Codex IDE extension share this MCP configuration on the same Codex host. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp) for current client-side options.

For other clients, choose their **Streamable HTTP** transport and configure an `Authorization: Bearer ...` header. Client configuration keys are not standardized, so use that client's documentation rather than copying the Codex TOML keys.

## Health and Readiness

The listener exposes three routes:

| Route      | Purpose                                                               | Authentication                                    |
| ---------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `/mcp`     | Stateful MCP Streamable HTTP (`POST`, `GET`, and `DELETE`)            | Bearer token when configured                      |
| `/healthz` | Process/listener liveness; does not touch Chrome or the native bridge | Public, but still protected by Host/Origin checks |
| `/readyz`  | Pings the local native bridge for the configured `instanceId`         | Bearer token when configured                      |

Examples:

```bash
curl --fail https://mcp-host.example.internal:12306/healthz
curl --fail \
  -H "Authorization: Bearer $WEBPAGE_MCP_REMOTE_TOKEN" \
  https://mcp-host.example.internal:12306/readyz
```

`/healthz` returning `200` only proves that the HTTP listener is alive. Use `/readyz` before connecting a remote agent; `503` means the extension/native host path is unavailable.

## Host and Origin Rules

`--allowed-host` values are hostnames or IP addresses without a scheme or port. The hostname in the client's URL must appear in the allowlist. This protects wildcard listeners against DNS rebinding and unexpected reverse-proxy aliases.

Requests without an `Origin` header are supported for normal server-to-server MCP clients. If a client sends `Origin`, add each exact HTTP(S) origin with `--allowed-origin`; all other origins are rejected. This option does not enable CORS, and the gateway is not intended to be called directly by arbitrary web pages.

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
| `--token-file <file>`         | `WEBPAGE_MCP_REMOTE_TOKEN_FILE`      | Read the dedicated bearer token from a private file       |
| —                             | `WEBPAGE_MCP_REMOTE_TOKEN`           | Dedicated bearer token value                              |
| repeatable `--allowed-host`   | `WEBPAGE_MCP_REMOTE_ALLOWED_HOSTS`   | Accepted Host names; env list is comma/whitespace split   |
| repeatable `--allowed-origin` | `WEBPAGE_MCP_REMOTE_ALLOWED_ORIGINS` | Exact browser origins; env list is comma/whitespace split |
| `--tls-cert <file>`           | `WEBPAGE_MCP_REMOTE_TLS_CERT`        | PEM certificate                                           |
| `--tls-key <file>`            | `WEBPAGE_MCP_REMOTE_TLS_KEY`         | Private PEM key                                           |
| `--allow-insecure-http`       | —                                    | Acknowledge plaintext use outside loopback                |

There is intentionally no `--token` argument, which keeps credentials out of shell history and process listings. A token file takes precedence over `WEBPAGE_MCP_REMOTE_TOKEN`.

`WEBPAGE_MCP_REMOTE_TOKEN` is separate from the legacy `WEBPAGE_MCP_AUTH_TOKEN`. The latter is exposed to the extension UI and is not an authorization check for MCP calls; it does not satisfy the remote listener's token requirement.

## Runtime Boundaries

- Each initialized remote client receives an isolated MCP/native-bridge session ID.
- Up to 64 remote sessions and 128 active HTTP requests are accepted by default.
- Idle sessions are removed after 30 minutes.
- Request bodies are limited to 1 MiB; local IPC responses retain their existing 16 MiB bound.
- Successful workflow mutations broadcast `tools/list_changed` to connected remote sessions.
- `SIGINT` and `SIGTERM` stop accepting traffic and close active sessions.
- Authentication is static bearer-token authentication. This gateway does not implement OAuth or per-user authorization.

Treat every authorized remote MCP client as a privileged browser operator. It can receive page content and screenshots and invoke tools with real browser or network side effects.

## Troubleshooting

### `403 Forbidden Host`

The hostname or IP in the client URL is not allowed. Add that hostname without its port using `--allowed-host`. With a wildcard listen address, at least one explicit allowed host is mandatory.

### `403 Forbidden Origin`

The client sent an `Origin` header that was not explicitly allowed. Add its exact scheme, hostname, and port using `--allowed-origin`, or use a normal server-side MCP client that does not synthesize a browser Origin.

### `401 Unauthorized`

Verify that the client sends `Authorization: Bearer <token>`, that both machines use the same remote token, and that the token was not placed in the URL. `WEBPAGE_MCP_AUTH_TOKEN` is not the remote token.

### `/healthz` works but `/readyz` returns `503`

The HTTP process is running but cannot ping the Native Messaging bridge. Open Chrome, enable/connect the Webpage MCP Connector, run `npx -y webpage-mcp@latest doctor`, and verify that the native host and gateway use the same `WEBPAGE_MCP_NATIVE_SOCKET` when it is customized.

### TLS or startup validation fails

Provide both certificate and key files. On Unix, remove group/other access from the key and token file with `chmod 600 <file>`. A non-loopback listener also requires a remote token even when TLS is enabled.
