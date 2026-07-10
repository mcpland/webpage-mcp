import { describe, expect, it } from 'vitest';

import { BrowserType, detectInstalledBrowsers } from './browser-config';

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
});
