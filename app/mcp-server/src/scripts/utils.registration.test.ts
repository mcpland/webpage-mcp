import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXTENSION_ID } from './constant';
import {
  queryWindowsRegistryDefaultValue,
  resolveAllowedOrigins,
  setWindowsRegistryDefaultValue,
  type SyncFileCommandRunner,
} from './utils';

describe('Native Messaging registration security', () => {
  const originEnvironmentKeys = [
    'WEBPAGE_MCP_EXTENSION_ID',
    'WEBPAGE_MCP_EXTENSION_IDS',
    'WEBPAGE_MCP_ALLOWED_ORIGINS',
  ] as const;
  const originalEnvironment = new Map<string, string | undefined>();
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    for (const key of originEnvironmentKeys) {
      originalEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of originEnvironmentKeys) {
      const originalValue = originalEnvironment.get(key);
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
    originalEnvironment.clear();
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it('authorizes the published Chrome Web Store extension by default', () => {
    expect(EXTENSION_ID).toBe('iehgbogeakiedihodennfcnigojnncag');
    expect(resolveAllowedOrigins()).toContain(
      'chrome-extension://iehgbogeakiedihodennfcnigojnncag/',
    );
  });

  it('does not trust extension names or paths discovered in browser profiles', async () => {
    const spoofedExtensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const homeDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'webpage-mcp-registration-test-'),
    );
    temporaryDirectories.push(homeDirectory);
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    vi.spyOn(os, 'homedir').mockReturnValue(homeDirectory);

    const profileDirectory = path.join(
      homeDirectory,
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      'Default',
    );
    await fs.mkdir(profileDirectory, { recursive: true });
    await fs.writeFile(
      path.join(profileDirectory, 'Preferences'),
      JSON.stringify({
        extensions: {
          settings: {
            [spoofedExtensionId]: {
              path: '/tmp/webpage-mcp-spoof',
              manifest: { name: 'Webpage MCP Connector' },
            },
          },
        },
      }),
    );

    const resolveWithLegacyDiscoveryOption = resolveAllowedOrigins as (
      options?: { includeDetectedExtensionIds?: boolean },
    ) => string[];
    expect(
      resolveWithLegacyDiscoveryOption({ includeDetectedExtensionIds: true }),
    ).not.toContain(
      `chrome-extension://${spoofedExtensionId}/`,
    );
  });

  it('accepts only explicitly configured, well-formed extension origins', () => {
    const explicitExtensionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const explicitOriginId = 'cccccccccccccccccccccccccccccccc';
    process.env.WEBPAGE_MCP_EXTENSION_ID = explicitExtensionId;
    process.env.WEBPAGE_MCP_ALLOWED_ORIGINS = [
      `chrome-extension://${explicitOriginId}/`,
      `chrome-extension://${explicitOriginId}/popup.html`,
      'https://example.com/',
    ].join(',');

    const origins = resolveAllowedOrigins();

    expect(origins).toContain(`chrome-extension://${explicitExtensionId}/`);
    expect(origins).toContain(`chrome-extension://${explicitOriginId}/`);
    expect(origins).not.toContain(
      `chrome-extension://${explicitOriginId}/popup.html/`,
    );
    expect(origins).not.toContain('https://example.com/');
  });

  it('passes registry keys with shell metacharacters as one query argument', () => {
    const registryKey = 'HKCU\\Software\\Vendor name\\Host "quoted" & whoami';
    const calls: Array<{
      command: string;
      args: string[];
      options: { encoding?: BufferEncoding; stdio: 'pipe' };
    }> = [];
    const runner: SyncFileCommandRunner = (command, args, options) => {
      calls.push({ command, args, options });
      return Buffer.from('query output', 'utf8');
    };

    expect(queryWindowsRegistryDefaultValue(registryKey, runner)).toBe('query output');
    expect(calls).toEqual([
      {
        command: 'reg',
        args: ['query', registryKey, '/ve'],
        options: { encoding: 'utf8', stdio: 'pipe' },
      },
    ]);
  });

  it('passes quoted manifest paths with shell metacharacters as one add argument', () => {
    const registryKey = 'HKCU\\Software\\Vendor name\\Host "quoted" & whoami';
    const manifestPath = 'C:\\Users\\A B\\host "quoted" & calc.exe.json';
    const calls: Array<{
      command: string;
      args: string[];
      options: { encoding?: BufferEncoding; stdio: 'pipe' };
    }> = [];
    const runner: SyncFileCommandRunner = (command, args, options) => {
      calls.push({ command, args, options });
      return Buffer.alloc(0);
    };

    setWindowsRegistryDefaultValue(registryKey, manifestPath, runner);

    expect(calls).toEqual([
      {
        command: 'reg',
        args: [
          'add',
          registryKey,
          '/ve',
          '/t',
          'REG_SZ',
          '/d',
          manifestPath,
          '/f',
        ],
        options: { stdio: 'pipe' },
      },
    ]);
  });
});
