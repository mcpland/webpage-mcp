import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { BrowserType, detectInstalledBrowsers, getBrowserConfig } from './browser-config';

describe('browser detection commands', () => {
  it('passes Windows registry paths as single arguments without a shell', () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    const detected = detectInstalledBrowsers(
      (command, args) => {
        calls.push({ command, args });
      },
      'win32',
    );

    expect(detected).toEqual([BrowserType.CHROME, BrowserType.CHROMIUM]);
    expect(calls).toEqual([
      {
        command: 'reg',
        args: ['query', 'HKLM\\SOFTWARE\\Google\\Chrome'],
      },
      {
        command: 'reg',
        args: ['query', 'HKLM\\SOFTWARE\\Chromium'],
      },
    ]);
  });

  it('passes executable names to which as single arguments', () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    const detected = detectInstalledBrowsers(
      (command, args) => {
        calls.push({ command, args });
        if (args[0] === 'google-chrome-stable' || args[0] === 'chromium-browser') {
          return;
        }
        throw new Error('not found');
      },
      'linux',
    );

    expect(detected).toEqual([BrowserType.CHROME, BrowserType.CHROMIUM]);
    expect(calls).toEqual([
      { command: 'which', args: ['google-chrome'] },
      { command: 'which', args: ['google-chrome-stable'] },
      { command: 'which', args: ['chromium'] },
      { command: 'which', args: ['chromium-browser'] },
    ]);
  });

  it('keeps every macOS user manifest beneath the isolated home directory', () => {
    const homeDirectory = path.join(path.sep, 'private', 'tmp', 'isolated-native-home');
    const context = { platform: 'darwin' as const, homeDirectory };
    const chromeConfig = getBrowserConfig(BrowserType.CHROME, context);
    const chromiumConfig = getBrowserConfig(BrowserType.CHROMIUM, context);
    const expectedChromeChannels = [
      'Chrome',
      'Chrome for Testing',
      'Chrome Beta',
      'Chrome Canary',
    ];

    expect(chromeConfig.userManifestPaths).toEqual(
      expectedChromeChannels.map((channel) =>
        path.join(
          homeDirectory,
          'Library',
          'Application Support',
          'Google',
          channel,
          'NativeMessagingHosts',
          'com.webpagemcp.nativehost.json',
        ),
      ),
    );
    expect(chromiumConfig.userManifestPaths).toEqual([
      path.join(
        homeDirectory,
        'Library',
        'Application Support',
        'Chromium',
        'NativeMessagingHosts',
        'com.webpagemcp.nativehost.json',
      ),
    ]);

    for (const manifestPath of [
      ...chromeConfig.userManifestPaths,
      ...chromiumConfig.userManifestPaths,
    ]) {
      const relative = path.relative(homeDirectory, manifestPath);
      expect(relative).not.toBe('..');
      expect(relative.startsWith(`..${path.sep}`)).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
    }
  });
});
