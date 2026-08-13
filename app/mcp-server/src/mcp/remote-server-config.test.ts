import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REMOTE_MCP_HOST,
  DEFAULT_REMOTE_MCP_PORT,
  REMOTE_MCP_TOKEN_ENV,
  resolveRemoteMcpServerOptions,
} from './remote-server-config';

const TOKEN = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webpage-mcp-remote-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('remote MCP server configuration', () => {
  it('defaults to an unauthenticated loopback-only listener', () => {
    const options = resolveRemoteMcpServerOptions({}, {});

    expect(options).toMatchObject({
      host: DEFAULT_REMOTE_MCP_HOST,
      port: DEFAULT_REMOTE_MCP_PORT,
      instanceId: 'default',
      token: undefined,
      allowInsecureHttp: false,
    });
    expect(options.allowedHosts).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost', '::1']));
    expect(options.allowedOrigins).toEqual([]);
  });

  it('uses a separate remote token instead of the extension UI token', () => {
    expect(() =>
      resolveRemoteMcpServerOptions(
        {
          host: '192.0.2.10',
          allowedHost: ['agent.example.test'],
          allowInsecureHttp: true,
        },
        { WEBPAGE_MCP_AUTH_TOKEN: TOKEN },
      ),
    ).toThrow(REMOTE_MCP_TOKEN_ENV);

    const options = resolveRemoteMcpServerOptions(
      {
        host: '192.0.2.10',
        allowedHost: ['agent.example.test'],
        allowInsecureHttp: true,
      },
      { [REMOTE_MCP_TOKEN_ENV]: TOKEN },
    );
    expect(options.token).toBe(TOKEN);
  });

  it('requires explicit authentication and transport acknowledgement off loopback', () => {
    expect(() =>
      resolveRemoteMcpServerOptions({ host: '0.0.0.0', allowedHost: ['mcp.example.test'] }, {}),
    ).toThrow(REMOTE_MCP_TOKEN_ENV);

    expect(() =>
      resolveRemoteMcpServerOptions(
        { host: '0.0.0.0', allowedHost: ['mcp.example.test'] },
        { [REMOTE_MCP_TOKEN_ENV]: TOKEN },
      ),
    ).toThrow('--allow-insecure-http');

    expect(
      resolveRemoteMcpServerOptions(
        {
          host: '0.0.0.0',
          allowedHost: ['mcp.example.test'],
          allowInsecureHttp: true,
        },
        { [REMOTE_MCP_TOKEN_ENV]: TOKEN },
      ),
    ).toMatchObject({
      host: '0.0.0.0',
      token: TOKEN,
      allowedHosts: ['mcp.example.test'],
    });
  });

  it('requires an explicit Host allowlist for wildcard listeners', () => {
    expect(() =>
      resolveRemoteMcpServerOptions(
        { host: '0.0.0.0', allowInsecureHttp: true },
        { [REMOTE_MCP_TOKEN_ENV]: TOKEN },
      ),
    ).toThrow('--allowed-host');
  });

  it('normalizes exact browser origins and rejects malformed authority values', () => {
    const options = resolveRemoteMcpServerOptions(
      {
        allowedHost: ['MCP.EXAMPLE.TEST.'],
        allowedOrigin: ['https://Agent.Example.Test:443'],
      },
      {},
    );
    expect(options.allowedHosts).toContain('mcp.example.test');
    expect(options.allowedOrigins).toEqual(['https://agent.example.test']);

    expect(() =>
      resolveRemoteMcpServerOptions({ allowedOrigin: ['https://agent.example.test/path'] }, {}),
    ).toThrow('Invalid allowed origin');
    expect(() =>
      resolveRemoteMcpServerOptions({ allowedHost: ['agent.example.test:8443'] }, {}),
    ).toThrow('Invalid allowed host');
    expect(() => resolveRemoteMcpServerOptions({ port: '0' }, {})).toThrow(
      'Invalid remote MCP port',
    );
    expect(resolveRemoteMcpServerOptions({ port: 0 }, {}, { allowEphemeralPort: true }).port).toBe(
      0,
    );
  });

  it('reads bearer credentials only from bounded private regular files', () => {
    const directory = createTemporaryDirectory();
    const tokenFile = path.join(directory, 'token');
    fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });

    const options = resolveRemoteMcpServerOptions({ tokenFile }, {});
    expect(options.token).toBe(TOKEN);

    const symlink = path.join(directory, 'token-link');
    fs.symlinkSync(tokenFile, symlink);
    expect(() => resolveRemoteMcpServerOptions({ tokenFile: symlink }, {})).toThrow(
      'must not be a symbolic link',
    );

    if (process.platform !== 'win32') {
      fs.chmodSync(tokenFile, 0o644);
      expect(() => resolveRemoteMcpServerOptions({ tokenFile }, {})).toThrow(
        'permissions must not grant group or other access',
      );
    }
  });

  it('rejects weak bearer credentials and incomplete TLS configuration', () => {
    expect(() =>
      resolveRemoteMcpServerOptions({}, { [REMOTE_MCP_TOKEN_ENV]: 'too-short' }),
    ).toThrow('32-16384');
    expect(() =>
      resolveRemoteMcpServerOptions({}, { [REMOTE_MCP_TOKEN_ENV]: `${TOKEN} with-space` }),
    ).toThrow('Bearer token characters');
    expect(() => resolveRemoteMcpServerOptions({ tlsCert: '/tmp/cert.pem' }, {})).toThrow(
      'requires both',
    );
  });
});
