import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { HOST_NAME } from './constant';

export type BrowserDetectionCommandRunner = (command: string, args: string[]) => void;

const runBrowserDetectionCommand: BrowserDetectionCommandRunner = (command, args) => {
  execFileSync(command, args, { stdio: 'pipe' });
};

export enum BrowserType {
  CHROME = 'chrome',
  CHROMIUM = 'chromium',
}

export interface BrowserConfig {
  type: BrowserType;
  displayName: string;
  userManifestPath: string;
  systemManifestPath: string;
  userManifestPaths: string[];
  systemManifestPaths: string[];
  registryKey?: string; // Windows only
  systemRegistryKey?: string; // Windows only
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const item of paths) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function getAdditionalUserManifestPaths(browser: BrowserType): string[] {
  const platform = os.platform();
  const home = os.homedir();

  if (browser !== BrowserType.CHROME) {
    return [];
  }

  if (platform === 'darwin') {
    return [
      path.join(
        home,
        'Library',
        'Application Support',
        'Google',
        'Chrome for Testing',
        'NativeMessagingHosts',
        `${HOST_NAME}.json`,
      ),
      path.join(
        home,
        'Library',
        'Application Support',
        'Google',
        'Chrome Beta',
        'NativeMessagingHosts',
        `${HOST_NAME}.json`,
      ),
      path.join(
        home,
        'Library',
        'Application Support',
        'Google',
        'Chrome Canary',
        'NativeMessagingHosts',
        `${HOST_NAME}.json`,
      ),
    ];
  }

  if (platform === 'linux') {
    return [
      path.join(
        home,
        '.config',
        'google-chrome-beta',
        'NativeMessagingHosts',
        `${HOST_NAME}.json`,
      ),
      path.join(
        home,
        '.config',
        'google-chrome-unstable',
        'NativeMessagingHosts',
        `${HOST_NAME}.json`,
      ),
      path.join(
        home,
        '.config',
        'google-chrome-for-testing',
        'NativeMessagingHosts',
        `${HOST_NAME}.json`,
      ),
    ];
  }

  return [];
}

function getAdditionalSystemManifestPaths(browser: BrowserType): string[] {
  const platform = os.platform();

  if (browser !== BrowserType.CHROME) {
    return [];
  }

  if (platform === 'darwin') {
    return [
      path.join(
        '/Library',
        'Google',
        'Chrome for Testing',
        'NativeMessagingHosts',
        `${HOST_NAME}.json`,
      ),
      path.join(
        '/Library',
        'Google',
        'Chrome Beta',
        'NativeMessagingHosts',
        `${HOST_NAME}.json`,
      ),
      path.join(
        '/Library',
        'Google',
        'Chrome Canary',
        'NativeMessagingHosts',
        `${HOST_NAME}.json`,
      ),
    ];
  }

  if (platform === 'linux') {
    return [
      path.join('/etc', 'opt', 'chrome-beta', 'native-messaging-hosts', `${HOST_NAME}.json`),
      path.join('/etc', 'opt', 'chrome-unstable', 'native-messaging-hosts', `${HOST_NAME}.json`),
    ];
  }

  return [];
}

/**
 * Get the user-level manifest path for a specific browser
 */
function getUserManifestPathForBrowser(browser: BrowserType): string {
  const platform = os.platform();

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(appData, 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.CHROMIUM:
        return path.join(appData, 'Chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      default:
        return path.join(appData, 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`);
    }
  } else if (platform === 'darwin') {
    const home = os.homedir();
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          home,
          'Library',
          'Application Support',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(
          home,
          'Library',
          'Application Support',
          'Chromium',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      default:
        return path.join(
          home,
          'Library',
          'Application Support',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  } else {
    // Linux
    const home = os.homedir();
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          home,
          '.config',
          'google-chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(home, '.config', 'chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      default:
        return path.join(
          home,
          '.config',
          'google-chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  }
}

/**
 * Get the system-level manifest path for a specific browser
 */
function getSystemManifestPathForBrowser(browser: BrowserType): string {
  const platform = os.platform();

  if (platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          programFiles,
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(programFiles, 'Chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      default:
        return path.join(
          programFiles,
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  } else if (platform === 'darwin') {
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          '/Library',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(
          '/Library',
          'Application Support',
          'Chromium',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      default:
        return path.join(
          '/Library',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  } else {
    // Linux
    switch (browser) {
      case BrowserType.CHROME:
        return path.join('/etc', 'opt', 'chrome', 'native-messaging-hosts', `${HOST_NAME}.json`);
      case BrowserType.CHROMIUM:
        return path.join('/etc', 'chromium', 'native-messaging-hosts', `${HOST_NAME}.json`);
      default:
        return path.join('/etc', 'opt', 'chrome', 'native-messaging-hosts', `${HOST_NAME}.json`);
    }
  }
}

/**
 * Get Windows registry keys for a browser
 */
function getRegistryKeys(browser: BrowserType): { user: string; system: string } | undefined {
  if (os.platform() !== 'win32') return undefined;

  const browserPaths: Record<BrowserType, { user: string; system: string }> = {
    [BrowserType.CHROME]: {
      user: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      system: `HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    },
    [BrowserType.CHROMIUM]: {
      user: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
      system: `HKLM\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
    },
  };

  return browserPaths[browser];
}

/**
 * Get browser configuration
 */
export function getBrowserConfig(browser: BrowserType): BrowserConfig {
  const registryKeys = getRegistryKeys(browser);
  const userManifestPath = getUserManifestPathForBrowser(browser);
  const systemManifestPath = getSystemManifestPathForBrowser(browser);
  const userManifestPaths = uniquePaths([
    userManifestPath,
    ...getAdditionalUserManifestPaths(browser),
  ]);
  const systemManifestPaths = uniquePaths([
    systemManifestPath,
    ...getAdditionalSystemManifestPaths(browser),
  ]);

  return {
    type: browser,
    displayName: browser.charAt(0).toUpperCase() + browser.slice(1),
    userManifestPath,
    systemManifestPath,
    userManifestPaths,
    systemManifestPaths,
    registryKey: registryKeys?.user,
    systemRegistryKey: registryKeys?.system,
  };
}

/**
 * Detect installed browsers on the system
 */
export function detectInstalledBrowsers(
  runCommand: BrowserDetectionCommandRunner = runBrowserDetectionCommand,
  platform: NodeJS.Platform = os.platform(),
): BrowserType[] {
  const detectedBrowsers: BrowserType[] = [];

  if (platform === 'win32') {
    // Check Windows registry for installed browsers
    const browsers: Array<{ type: BrowserType; registryPath: string }> = [
      { type: BrowserType.CHROME, registryPath: 'HKLM\\SOFTWARE\\Google\\Chrome' },
      { type: BrowserType.CHROMIUM, registryPath: 'HKLM\\SOFTWARE\\Chromium' },
    ];

    for (const browser of browsers) {
      try {
        runCommand('reg', ['query', browser.registryPath]);
        detectedBrowsers.push(browser.type);
      } catch {
        // Browser not installed
      }
    }
  } else if (platform === 'darwin') {
    // Check macOS Applications folder
    const browsers: Array<{ type: BrowserType; appPath: string }> = [
      { type: BrowserType.CHROME, appPath: '/Applications/Google Chrome.app' },
      { type: BrowserType.CHROME, appPath: '/Applications/Google Chrome for Testing.app' },
      { type: BrowserType.CHROME, appPath: '/Applications/Google Chrome Beta.app' },
      { type: BrowserType.CHROME, appPath: '/Applications/Google Chrome Canary.app' },
      { type: BrowserType.CHROMIUM, appPath: '/Applications/Chromium.app' },
    ];

    for (const browser of browsers) {
      if (fs.existsSync(browser.appPath) && !detectedBrowsers.includes(browser.type)) {
        detectedBrowsers.push(browser.type);
      }
    }
  } else {
    // Check Linux paths using which command
    const browsers: Array<{ type: BrowserType; commands: string[] }> = [
      { type: BrowserType.CHROME, commands: ['google-chrome', 'google-chrome-stable'] },
      { type: BrowserType.CHROMIUM, commands: ['chromium', 'chromium-browser'] },
    ];

    for (const browser of browsers) {
      for (const cmd of browser.commands) {
        try {
          runCommand('which', [cmd]);
          if (!detectedBrowsers.includes(browser.type)) {
            detectedBrowsers.push(browser.type);
          }
          break; // Found one command, no need to check others
        } catch {
          // Command not found
        }
      }
    }
  }

  return detectedBrowsers;
}

/**
 * Get all supported browser configs
 */
export function getAllBrowserConfigs(): BrowserConfig[] {
  return Object.values(BrowserType).map((browser) => getBrowserConfig(browser));
}

/**
 * Parse browser type from string
 */
export function parseBrowserType(browserStr: string): BrowserType | undefined {
  const normalized = browserStr.toLowerCase();
  return Object.values(BrowserType).find((type) => type === normalized);
}
