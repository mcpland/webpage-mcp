import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Command } from 'commander';

export const DEFAULT_REMOTE_MCP_HOST = '127.0.0.1';
export const DEFAULT_REMOTE_MCP_PORT = 12306;
export const REMOTE_MCP_TOKEN_ENV = 'WEBPAGE_MCP_REMOTE_TOKEN';

const TOKEN_FILE_ENV = 'WEBPAGE_MCP_REMOTE_TOKEN_FILE';
const HOST_ENV = 'WEBPAGE_MCP_REMOTE_HOST';
const PORT_ENV = 'WEBPAGE_MCP_REMOTE_PORT';
const TLS_CERT_ENV = 'WEBPAGE_MCP_REMOTE_TLS_CERT';
const TLS_KEY_ENV = 'WEBPAGE_MCP_REMOTE_TLS_KEY';
const ALLOWED_HOSTS_ENV = 'WEBPAGE_MCP_REMOTE_ALLOWED_HOSTS';
const ALLOWED_ORIGINS_ENV = 'WEBPAGE_MCP_REMOTE_ALLOWED_ORIGINS';
const INSTANCE_ID_ENV = 'WEBPAGE_MCP_INSTANCE_ID';
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TOKEN_MIN_BYTES = 32;
const TOKEN_MAX_BYTES = 16 * 1024;
const TLS_FILE_MAX_BYTES = 1024 * 1024;

export interface RemoteMcpServerCliOptions {
  host?: string;
  port?: string | number;
  instanceId?: string;
  tokenFile?: string;
  allowedHost?: string[];
  allowedOrigin?: string[];
  tlsCert?: string;
  tlsKey?: string;
  allowInsecureHttp?: boolean;
}

export interface RemoteMcpTlsOptions {
  cert: Buffer;
  key: Buffer;
}

export interface RemoteMcpServerOptions {
  host: string;
  port: number;
  instanceId: string;
  token?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  tls?: RemoteMcpTlsOptions;
  allowInsecureHttp: boolean;
}

export interface ResolveRemoteMcpServerOptions {
  allowEphemeralPort?: boolean;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function configureRemoteMcpServerCommand(command: Command): Command {
  return command
    .description("Expose this host's Webpage MCP Connector over Streamable HTTP")
    .option('--host <host>', `Listen host (default: ${DEFAULT_REMOTE_MCP_HOST})`)
    .option('-p, --port <port>', `Listen port (default: ${DEFAULT_REMOTE_MCP_PORT})`)
    .option('--instance-id <id>', 'Route calls to one configured Webpage MCP instance')
    .option(
      '--token-file <file>',
      `Read the bearer token from a private file (${REMOTE_MCP_TOKEN_ENV} is also supported)`,
    )
    .option(
      '--allowed-host <hostname>',
      'Allow an HTTP Host hostname; repeat for aliases (required with 0.0.0.0 or ::)',
      collectOption,
      [],
    )
    .option(
      '--allowed-origin <origin>',
      'Allow an exact browser Origin; repeat as needed (requests without Origin remain supported)',
      collectOption,
      [],
    )
    .option('--tls-cert <file>', 'Serve HTTPS with this PEM certificate')
    .option('--tls-key <file>', 'Serve HTTPS with this private PEM key')
    .option(
      '--allow-insecure-http',
      'Acknowledge that a non-loopback listener is using plaintext HTTP',
    );
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePort(value: unknown, allowEphemeralPort: boolean): number {
  const raw = typeof value === 'number' ? value : Number(String(value ?? ''));
  if (!Number.isInteger(raw) || raw < (allowEphemeralPort ? 0 : 1) || raw > 65_535) {
    throw new Error(`Invalid remote MCP port: expected ${allowEphemeralPort ? '0-' : '1-'}65535`);
  }
  return raw;
}

export function normalizeRemoteHostname(value: string, label: string): string {
  const trimmed = value.trim();
  const unwrapped =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (!unwrapped || unwrapped.length > 255 || /[\s/?#@]/.test(unwrapped)) {
    throw new Error(`Invalid ${label}: expected a hostname or IP address without a port`);
  }
  if (net.isIP(unwrapped)) {
    return unwrapped.toLowerCase();
  }
  const normalized = unwrapped.replace(/\.$/, '').toLowerCase();
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(
      normalized,
    )
  ) {
    throw new Error(`Invalid ${label}: expected a hostname or IP address without a port`);
  }
  return normalized;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeRemoteHostname(host, 'listen host');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return net.isIPv4(normalized) && normalized.startsWith('127.');
}

function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid allowed origin: ${value}`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.origin === 'null'
  ) {
    throw new Error(`Invalid allowed origin: ${value}`);
  }
  return parsed.origin;
}

function assertPrivateFile(stats: fs.Stats, label: string): void {
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must not grant group or other access`);
  }
}

function readBoundedFile(
  filePath: string,
  label: string,
  maximumBytes: number,
  options: { privateFile?: boolean; rejectSymlink?: boolean } = {},
): Buffer {
  const resolved = path.resolve(filePath);
  const sourceStats = fs.lstatSync(resolved);
  if (options.rejectSymlink && sourceStats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  const target = fs.realpathSync(resolved);
  const stats = fs.lstatSync(target);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maximumBytes) {
    throw new Error(`${label} must be a non-empty regular file up to ${maximumBytes} bytes`);
  }
  if (options.privateFile) {
    assertPrivateFile(stats, label);
  }
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const openedStats = fs.fstatSync(descriptor);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== stats.dev ||
      openedStats.ino !== stats.ino ||
      openedStats.size !== stats.size
    ) {
      throw new Error(`${label} changed before it could be read safely`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveToken(raw: RemoteMcpServerCliOptions, env: NodeJS.ProcessEnv): string | undefined {
  const tokenFile = raw.tokenFile?.trim() || env[TOKEN_FILE_ENV]?.trim();
  const value = tokenFile
    ? readBoundedFile(tokenFile, 'Remote MCP token file', TOKEN_MAX_BYTES, {
        privateFile: true,
        rejectSymlink: true,
      }).toString('utf8')
    : env[REMOTE_MCP_TOKEN_ENV];
  if (value === undefined) return undefined;
  const token = value.trim();
  const byteLength = Buffer.byteLength(token, 'utf8');
  if (byteLength < TOKEN_MIN_BYTES || byteLength > TOKEN_MAX_BYTES) {
    throw new Error(
      `Remote MCP bearer token must be ${TOKEN_MIN_BYTES}-${TOKEN_MAX_BYTES} UTF-8 bytes`,
    );
  }
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
    throw new Error('Remote MCP bearer token must use HTTP Bearer token characters');
  }
  return token;
}

function resolveTls(
  raw: RemoteMcpServerCliOptions,
  env: NodeJS.ProcessEnv,
): RemoteMcpTlsOptions | undefined {
  const certPath = raw.tlsCert?.trim() || env[TLS_CERT_ENV]?.trim();
  const keyPath = raw.tlsKey?.trim() || env[TLS_KEY_ENV]?.trim();
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error('Remote MCP TLS requires both --tls-cert and --tls-key');
  }
  if (!certPath || !keyPath) return undefined;
  return {
    cert: readBoundedFile(certPath, 'Remote MCP TLS certificate', TLS_FILE_MAX_BYTES),
    key: readBoundedFile(keyPath, 'Remote MCP TLS private key', TLS_FILE_MAX_BYTES, {
      privateFile: true,
    }),
  };
}

function resolveInstanceId(value: unknown): string {
  const normalized = value === undefined ? 'default' : String(value).trim();
  if (!INSTANCE_ID_PATTERN.test(normalized)) {
    throw new Error(
      'Invalid instanceId: expected 1-64 letters, numbers, dots, underscores, or hyphens',
    );
  }
  return normalized;
}

export function resolveRemoteMcpServerOptions(
  raw: RemoteMcpServerCliOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveRemoteMcpServerOptions = {},
): RemoteMcpServerOptions {
  const host = normalizeRemoteHostname(
    raw.host?.trim() || env[HOST_ENV]?.trim() || DEFAULT_REMOTE_MCP_HOST,
    'listen host',
  );
  const port = parsePort(
    raw.port ?? env[PORT_ENV] ?? DEFAULT_REMOTE_MCP_PORT,
    Boolean(options.allowEphemeralPort),
  );
  const instanceId = resolveInstanceId(raw.instanceId ?? env[INSTANCE_ID_ENV]);
  const token = resolveToken(raw, env);
  const tls = resolveTls(raw, env);
  const allowInsecureHttp = raw.allowInsecureHttp === true;

  const configuredHosts = [...(raw.allowedHost || []), ...splitList(env[ALLOWED_HOSTS_ENV])].map(
    (entry) => normalizeRemoteHostname(entry, 'allowed host'),
  );
  if (isWildcardHost(host) && configuredHosts.length === 0) {
    throw new Error('A wildcard listen host requires at least one --allowed-host');
  }
  const allowedHosts = new Set(configuredHosts);
  if (!isWildcardHost(host)) {
    allowedHosts.add(host);
  }
  if (isLoopbackHost(host)) {
    allowedHosts.add('localhost');
    allowedHosts.add('127.0.0.1');
    allowedHosts.add('::1');
  }

  const allowedOrigins = new Set(
    [...(raw.allowedOrigin || []), ...splitList(env[ALLOWED_ORIGINS_ENV])].map(normalizeOrigin),
  );

  if (!isLoopbackHost(host) && !token) {
    throw new Error(
      `A non-loopback remote MCP listener requires ${REMOTE_MCP_TOKEN_ENV} or --token-file`,
    );
  }
  if (!isLoopbackHost(host) && !tls && !allowInsecureHttp) {
    throw new Error(
      'A non-loopback plaintext listener requires explicit --allow-insecure-http acknowledgement',
    );
  }

  return {
    host,
    port,
    instanceId,
    token,
    allowedHosts: [...allowedHosts].sort(),
    allowedOrigins: [...allowedOrigins].sort(),
    tls,
    allowInsecureHttp,
  };
}
