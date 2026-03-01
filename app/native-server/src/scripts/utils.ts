import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { promisify } from 'util';
import { COMMAND_NAME, DESCRIPTION, EXTENSION_ID, HOST_NAME } from './constant';
import { BrowserType, getBrowserConfig, detectInstalledBrowsers } from './browser-config';

export const access = promisify(fs.access);
export const mkdir = promisify(fs.mkdir);
export const writeFile = promisify(fs.writeFile);

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/**
 * Get the log directory path for wrapper scripts.
 * Uses platform-appropriate user directories to avoid permission issues.
 *
 * - macOS: ~/Library/Logs/webpage-mcp
 * - Windows: %LOCALAPPDATA%/webpage-mcp/logs
 * - Linux: $XDG_STATE_HOME/webpage-mcp/logs or ~/.local/state/webpage-mcp/logs
 */
export function getLogDir(): string {
  const homedir = os.homedir();

  if (os.platform() === 'darwin') {
    return path.join(homedir, 'Library', 'Logs', 'webpage-mcp');
  } else if (os.platform() === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local'),
      'webpage-mcp',
      'logs',
    );
  } else {
    // Linux: XDG_STATE_HOME or ~/.local/state
    const xdgState = process.env.XDG_STATE_HOME || path.join(homedir, '.local', 'state');
    return path.join(xdgState, 'webpage-mcp', 'logs');
  }
}

/**
 * Print colored text
 */
export function colorText(text: string, color: string): string {
  const colors: Record<string, string> = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    reset: '\x1b[0m',
  };

  return colors[color] + text + colors.reset;
}

function toExtensionId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return EXTENSION_ID_PATTERN.test(normalized) ? normalized : null;
}

function toOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('chrome-extension://')) {
    const normalized = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
    return normalized;
  }

  const extensionId = toExtensionId(trimmed);
  return extensionId ? `chrome-extension://${extensionId}/` : null;
}

function splitEnvList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function detectChromeLikeProfileRoots(): string[] {
  if (os.platform() === 'darwin') {
    const home = os.homedir();
    return [
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Beta'),
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome for Testing'),
      path.join(home, 'Library', 'Application Support', 'Chromium'),
    ];
  }

  if (os.platform() === 'linux') {
    const home = os.homedir();
    return [
      path.join(home, '.config', 'google-chrome'),
      path.join(home, '.config', 'google-chrome-beta'),
      path.join(home, '.config', 'google-chrome-unstable'),
      path.join(home, '.config', 'google-chrome-for-testing'),
      path.join(home, '.config', 'chromium'),
    ];
  }

  if (os.platform() === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(local, 'Google', 'Chrome', 'User Data'),
      path.join(local, 'Google', 'Chrome Beta', 'User Data'),
      path.join(local, 'Google', 'Chrome SxS', 'User Data'),
      path.join(local, 'Google', 'Chrome for Testing', 'User Data'),
      path.join(local, 'Chromium', 'User Data'),
    ];
  }

  return [];
}

function detectLocalExtensionIds(): string[] {
  if (process.env.WEBPAGE_MCP_DISABLE_EXTENSION_ID_DISCOVERY === '1') {
    return [];
  }

  const roots = detectChromeLikeProfileRoots().filter((rootPath) => fs.existsSync(rootPath));
  if (roots.length === 0) {
    return [];
  }

  const matches = new Set<string>();
  const profileDirPattern = /^(Default|Profile \d+|Guest Profile|System Profile)$/;

  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (!profileDirPattern.test(name)) {
        continue;
      }

      const preferencesPath = path.join(root, name, 'Preferences');
      if (!fs.existsSync(preferencesPath)) {
        continue;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
      } catch {
        continue;
      }

      const settings =
        parsed?.extensions?.settings && typeof parsed.extensions.settings === 'object'
          ? (parsed.extensions.settings as Record<string, any>)
          : null;
      if (!settings) {
        continue;
      }

      for (const [extensionId, data] of Object.entries(settings)) {
        const normalizedId = toExtensionId(extensionId);
        if (!normalizedId) {
          continue;
        }

        const extensionPath = typeof data?.path === 'string' ? data.path.toLowerCase() : '';
        const manifestName = typeof data?.manifest?.name === 'string' ? data.manifest.name.toLowerCase() : '';
        const isWebpageMcp =
          extensionPath.includes('webpage-mcp') ||
          extensionPath.includes('webpage_mcp') ||
          extensionPath.includes('webpage mcp') ||
          manifestName.includes('webpage') ||
          manifestName.includes('mcp');

        if (isWebpageMcp) {
          matches.add(normalizedId);
        }
      }
    }
  }

  return Array.from(matches.values());
}

export function resolveAllowedOrigins(options?: { includeDetectedExtensionIds?: boolean }): string[] {
  const origins = new Set<string>([`chrome-extension://${EXTENSION_ID}/`]);

  const extensionIds = [
    ...splitEnvList(process.env.WEBPAGE_MCP_EXTENSION_ID),
    ...splitEnvList(process.env.WEBPAGE_MCP_EXTENSION_IDS),
  ];
  for (const rawId of extensionIds) {
    const extensionId = toExtensionId(rawId);
    if (!extensionId) {
      continue;
    }
    origins.add(`chrome-extension://${extensionId}/`);
  }

  for (const rawOrigin of splitEnvList(process.env.WEBPAGE_MCP_ALLOWED_ORIGINS)) {
    const origin = toOrigin(rawOrigin);
    if (!origin) {
      continue;
    }
    origins.add(origin);
  }

  if (options?.includeDetectedExtensionIds) {
    for (const extensionId of detectLocalExtensionIds()) {
      origins.add(`chrome-extension://${extensionId}/`);
    }
  }

  return Array.from(origins.values());
}

/**
 * Get user-level manifest file path
 */
export function getUserManifestPath(): string {
  if (os.platform() === 'win32') {
    // Windows: %APPDATA%\Google\Chrome\NativeMessagingHosts\
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Google',
      'Chrome',
      'NativeMessagingHosts',
      `${HOST_NAME}.json`,
    );
  } else if (os.platform() === 'darwin') {
    // macOS: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      'NativeMessagingHosts',
      `${HOST_NAME}.json`,
    );
  } else {
    // Linux: ~/.config/google-chrome/NativeMessagingHosts/
    return path.join(
      os.homedir(),
      '.config',
      'google-chrome',
      'NativeMessagingHosts',
      `${HOST_NAME}.json`,
    );
  }
}

/**
 * Get system-level manifest file path
 */
export function getSystemManifestPath(): string {
  if (os.platform() === 'win32') {
    // Windows: %ProgramFiles%\Google\Chrome\NativeMessagingHosts\
    return path.join(
      process.env.ProgramFiles || 'C:\\Program Files',
      'Google',
      'Chrome',
      'NativeMessagingHosts',
      `${HOST_NAME}.json`,
    );
  } else if (os.platform() === 'darwin') {
    // macOS: /Library/Google/Chrome/NativeMessagingHosts/
    return path.join('/Library', 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`);
  } else {
    // Linux: /etc/opt/chrome/native-messaging-hosts/
    return path.join('/etc', 'opt', 'chrome', 'native-messaging-hosts', `${HOST_NAME}.json`);
  }
}

/**
 * Get native host startup script file path
 */
export async function getMainPath(): Promise<string> {
  try {
    const packageDistDir = path.join(__dirname, '..');
    const wrapperScriptName = process.platform === 'win32' ? 'run_host.bat' : 'run_host.sh';
    const absoluteWrapperPath = path.resolve(packageDistDir, wrapperScriptName);
    return absoluteWrapperPath;
  } catch (error) {
    console.log(colorText('Cannot find global package path, using current directory', 'yellow'));
    throw error;
  }
}

/**
 * Write Node.js executable path to node_path.txt for run_host scripts.
 * This ensures the native host uses the same Node.js version that was used during installation,
 * avoiding NODE_MODULE_VERSION mismatch errors with native modules like better-sqlite3.
 *
 * @param distDir - The dist directory where node_path.txt should be written
 * @param nodeExecPath - The Node.js executable path to write (defaults to current process.execPath)
 */
export function writeNodePathFile(distDir: string, nodeExecPath = process.execPath): void {
  try {
    const nodePathFile = path.join(distDir, 'node_path.txt');
    fs.mkdirSync(distDir, { recursive: true });

    console.log(colorText(`Writing Node.js path: ${nodeExecPath}`, 'blue'));
    fs.writeFileSync(nodePathFile, nodeExecPath, 'utf8');
    console.log(colorText('✓ Node.js path written for run_host scripts', 'green'));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(colorText(`⚠️ Failed to write Node.js path: ${message}`, 'yellow'));
  }
}

/**
 * Make sure critical files have execute permissions
 */
export async function ensureExecutionPermissions(): Promise<void> {
  try {
    const packageDistDir = path.join(__dirname, '..');

    if (process.platform === 'win32') {
      // Windows Platform processing
      await ensureWindowsFilePermissions(packageDistDir);
      return;
    }

    // Unix/Linux Platform processing
    const filesToCheck = [
      path.join(packageDistDir, 'index.js'),
      path.join(packageDistDir, 'run_host.sh'),
      path.join(packageDistDir, 'cli.js'),
    ];

    for (const filePath of filesToCheck) {
      if (fs.existsSync(filePath)) {
        try {
          fs.chmodSync(filePath, '755');
          console.log(
            colorText(`✓ Set execution permissions for ${path.basename(filePath)}`, 'green'),
          );
        } catch (err: any) {
          console.warn(
            colorText(
              `⚠️ Unable to set execution permissions for ${path.basename(filePath)}: ${err.message}`,
              'yellow',
            ),
          );
        }
      } else {
        console.warn(colorText(`⚠️ File not found: ${filePath}`, 'yellow'));
      }
    }
  } catch (error: any) {
    console.warn(colorText(`⚠️ Error ensuring execution permissions: ${error.message}`, 'yellow'));
  }
}

/**
 * Windows Platform file permission processing
 */
async function ensureWindowsFilePermissions(packageDistDir: string): Promise<void> {
  const filesToCheck = [
    path.join(packageDistDir, 'index.js'),
    path.join(packageDistDir, 'run_host.bat'),
    path.join(packageDistDir, 'cli.js'),
  ];

  for (const filePath of filesToCheck) {
    if (fs.existsSync(filePath)) {
      try {
        // Check if the file is read-only, if so remove the read-only attribute
        const stats = fs.statSync(filePath);
        if (!(stats.mode & parseInt('200', 8))) {
          // Check write permission
          // Try removing the read-only attribute
          fs.chmodSync(filePath, stats.mode | parseInt('200', 8));
          console.log(
            colorText(`✓ Removed read-only attribute from ${path.basename(filePath)}`, 'green'),
          );
        }

        // Verify file readability
        fs.accessSync(filePath, fs.constants.R_OK);
        console.log(
          colorText(`✓ Verified file accessibility for ${path.basename(filePath)}`, 'green'),
        );
      } catch (err: any) {
        console.warn(
          colorText(
            `⚠️ Unable to verify file permissions for ${path.basename(filePath)}: ${err.message}`,
            'yellow',
          ),
        );
      }
    } else {
      console.warn(colorText(`⚠️ File not found: ${filePath}`, 'yellow'));
    }
  }
}

/**
 * Create Native Messaging host manifest content
 */
export async function createManifestContent(): Promise<any> {
  const mainPath = await getMainPath();
  const allowedOrigins = resolveAllowedOrigins({ includeDetectedExtensionIds: true });

  return {
    name: HOST_NAME,
    description: DESCRIPTION,
    path: mainPath, // Node.jsExecutable file path
    type: 'stdio',
    allowed_origins: allowedOrigins,
  };
}

/**
 * Verify that the Windows registry key exists and points to the correct path
 */
function verifyWindowsRegistryEntry(registryKey: string, expectedPath: string): boolean {
  if (os.platform() !== 'win32') {
    return true; // Non-Windows platforms skip verification
  }

  const normalizeForCompare = (filePath: string): string => path.normalize(filePath).toLowerCase();

  try {
    const output = execSync(`reg query "${registryKey}" /ve`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const lines = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of lines) {
      const match = line.match(/REG_SZ\s+(.*)$/i);
      if (!match?.[1]) continue;
      const actualPath = match[1].trim();
      return normalizeForCompare(actualPath) === normalizeForCompare(expectedPath);
    }
  } catch {
    // ignore
  }

  return false;
}

/**
 * Write node_path.txt and then register user-level Native Messaging host.
 * This is the recommended entry point for development and production registration,
 * as it ensures the Node.js path is captured before registration.
 *
 * @param browsers - Optional list of browsers to register for
 * @returns true if at least one browser was registered successfully
 */
export async function registerUserLevelHostWithNodePath(
  browsers?: BrowserType[],
): Promise<boolean> {
  writeNodePathFile(path.join(__dirname, '..'));
  return tryRegisterUserLevelHost(browsers);
}

/**
 * Try registering a user-level Native Messaging host
 */
export async function tryRegisterUserLevelHost(targetBrowsers?: BrowserType[]): Promise<boolean> {
  try {
    console.log(colorText('Attempting to register user-level Native Messaging host...', 'blue'));

    // 1. Ensure execution permissions
    await ensureExecutionPermissions();

    // 2. Determine which browser to register
    const browsersToRegister = targetBrowsers || detectInstalledBrowsers();
    if (browsersToRegister.length === 0) {
      // If no browser is detected, Chrome and Chromium are registered by default
      browsersToRegister.push(BrowserType.CHROME, BrowserType.CHROMIUM);
      console.log(
        colorText('No browsers detected, registering for Chrome and Chromium by default', 'yellow'),
      );
    } else {
      console.log(colorText(`Detected browsers: ${browsersToRegister.join(', ')}`, 'blue'));
    }

    // 3. Create manifest content
    const manifest = await createManifestContent();

    let successCount = 0;
    const results: { browser: string; success: boolean; error?: string }[] = [];

    // 4. Register for each browser
    for (const browserType of browsersToRegister) {
      const config = getBrowserConfig(browserType);
      console.log(colorText(`\nRegistering for ${config.displayName}...`, 'blue'));

      try {
        const manifestPaths =
          Array.isArray(config.userManifestPaths) && config.userManifestPaths.length > 0
            ? config.userManifestPaths
            : [config.userManifestPath];
        const writtenPaths: string[] = [];

        for (const manifestPath of manifestPaths) {
          try {
            await mkdir(path.dirname(manifestPath), { recursive: true });
            await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
            writtenPaths.push(manifestPath);
            if (manifestPath === config.userManifestPath) {
              console.log(colorText(`✓ Manifest written to ${manifestPath}`, 'green'));
            } else {
              console.log(
                colorText(`✓ Channel manifest written to ${manifestPath}`, 'green'),
              );
            }
          } catch (error: any) {
            if (manifestPath === config.userManifestPath) {
              throw error;
            }
            console.log(
              colorText(
                `⚠️ Skipped optional channel path ${manifestPath}: ${error?.message || String(error)}`,
                'yellow',
              ),
            );
          }
        }

        if (writtenPaths.length === 0) {
          throw new Error('No manifest paths could be written');
        }

        // WindowsAdditional registry keys required
        if (os.platform() === 'win32' && config.registryKey) {
          try {
            // NOTE: There is no need to double-write the backslashes manually, the reg command will handle Windows paths correctly
            const regCommand = `reg add "${config.registryKey}" /ve /t REG_SZ /d "${config.userManifestPath}" /f`;
            execSync(regCommand, { stdio: 'pipe' });

            if (verifyWindowsRegistryEntry(config.registryKey, config.userManifestPath)) {
              console.log(colorText(`✓ Registry entry created for ${config.displayName}`, 'green'));
            } else {
              throw new Error('Registry verification failed');
            }
          } catch (error: any) {
            throw new Error(`Registry error: ${error.message}`);
          }
        }

        successCount++;
        results.push({ browser: config.displayName, success: true });
        console.log(colorText(`✓ Successfully registered ${config.displayName}`, 'green'));
      } catch (error: any) {
        results.push({ browser: config.displayName, success: false, error: error.message });
        console.log(
          colorText(`✗ Failed to register ${config.displayName}: ${error.message}`, 'red'),
        );
      }
    }

    // 5. Report results
    console.log(colorText('\n===== Registration Summary =====', 'blue'));
    for (const result of results) {
      if (result.success) {
        console.log(colorText(`✓ ${result.browser}: Success`, 'green'));
      } else {
        console.log(colorText(`✗ ${result.browser}: Failed - ${result.error}`, 'red'));
      }
    }

    return successCount > 0;
  } catch (error) {
    console.log(
      colorText(
        `User-level registration failed: ${error instanceof Error ? error.message : String(error)}`,
        'yellow',
      ),
    );
    return false;
  }
}

// Import the is-admin package (only used on Windows platform)
let isAdmin: () => boolean = () => false;
if (process.platform === 'win32') {
  try {
    isAdmin = require('is-admin');
  } catch (error) {
    console.warn('Missing is-admin dependency, administrator permissions may not be correctly detected on Windows platform');
    console.warn(error);
  }
}

/**
 * Registering a system-level manifest using elevated privileges
 */
export async function registerWithElevatedPermissions(): Promise<void> {
  try {
    console.log(colorText('Attempting to register system-level manifest...', 'blue'));

    // 1. Ensure execution permissions
    await ensureExecutionPermissions();

    // 2. Prepare list contents
    const manifest = await createManifestContent();

    // 3. Get system-level manifest path
    const manifestPath = getSystemManifestPath();

    // 4. Create temporary manifest file
    const tempManifestPath = path.join(os.tmpdir(), `${HOST_NAME}.json`);
    await writeFile(tempManifestPath, JSON.stringify(manifest, null, 2));

    // 5. Check if you already have administrator rights
    const isRoot = process.getuid && process.getuid() === 0; // Unix/Linux/Mac
    const hasAdminRights = process.platform === 'win32' ? isAdmin() : false; // WindowsPlatform detection administrator permissions
    const hasElevatedPermissions = isRoot || hasAdminRights;

    // Prepare command
    const command =
      os.platform() === 'win32'
        ? `if not exist "${path.dirname(manifestPath)}" mkdir "${path.dirname(manifestPath)}" && copy "${tempManifestPath}" "${manifestPath}"`
        : `mkdir -p "${path.dirname(manifestPath)}" && cp "${tempManifestPath}" "${manifestPath}" && chmod 644 "${manifestPath}"`;

    if (hasElevatedPermissions) {
      // Already have administrator rights, execute the command directly
      try {
        // Create directory
        if (!fs.existsSync(path.dirname(manifestPath))) {
          fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        }

        // Copy files
        fs.copyFileSync(tempManifestPath, manifestPath);

        // Set permissions (non-Windows platforms)
        if (os.platform() !== 'win32') {
          fs.chmodSync(manifestPath, '644');
        }

        console.log(colorText('System-level manifest registration successful!', 'green'));
      } catch (error: any) {
        console.error(
          colorText(`System-level manifest installation failed: ${error.message}`, 'red'),
        );
        throw error;
      }
    } else {
      // Without administrator rights, print manual operation prompts
      console.log(
        colorText('⚠️ Administrator privileges required for system-level installation', 'yellow'),
      );
      console.log(
        colorText(
          'Please run one of the following commands with administrator privileges:',
          'blue',
        ),
      );

      if (os.platform() === 'win32') {
        console.log(colorText('  1. Open Command Prompt as Administrator and run:', 'blue'));
        console.log(colorText(`     ${command}`, 'cyan'));
      } else {
        console.log(colorText('  1. Run with sudo:', 'blue'));
        console.log(colorText(`     sudo ${command}`, 'cyan'));
      }

      console.log(
        colorText('  2. Or run the registration command with elevated privileges:', 'blue'),
      );
      console.log(colorText(`     sudo ${COMMAND_NAME} register --system`, 'cyan'));

      throw new Error('Administrator privileges required for system-level installation');
    }

    // 6. WindowsSpecial Handling - Setting up the System Level Registry
    if (os.platform() === 'win32') {
      const registryKey = `HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
      // NOTE: There is no need to double-write the backslashes manually, the reg command will handle Windows paths correctly
      const regCommand = `reg add "${registryKey}" /ve /t REG_SZ /d "${manifestPath}" /f`;

      console.log(colorText(`Creating system registry entry: ${registryKey}`, 'blue'));
      console.log(colorText(`Manifest path: ${manifestPath}`, 'blue'));

      if (hasElevatedPermissions) {
        // Already have administrator rights, directly execute the registry command
        try {
          execSync(regCommand, { stdio: 'pipe' });

          // Verify that the registry key is created successfully
          if (verifyWindowsRegistryEntry(registryKey, manifestPath)) {
            console.log(colorText('Windows registry entry created successfully!', 'green'));
          } else {
            console.log(colorText('⚠️ Registry entry created but verification failed', 'yellow'));
          }
        } catch (error: any) {
          console.error(
            colorText(`Windows registry entry creation failed: ${error.message}`, 'red'),
          );
          console.error(colorText(`Command: ${regCommand}`, 'red'));
          throw error;
        }
      } else {
        // Without administrator rights, print manual operation prompts
        console.log(
          colorText(
            '⚠️ Administrator privileges required for Windows registry modification',
            'yellow',
          ),
        );
        console.log(colorText('Please run the following command as Administrator:', 'blue'));
        console.log(colorText(`  ${regCommand}`, 'cyan'));
        console.log(colorText('Or run the registration command with elevated privileges:', 'blue'));
        console.log(
          colorText(
            `  Run Command Prompt as Administrator and execute: ${COMMAND_NAME} register --system`,
            'cyan',
          ),
        );

        throw new Error('Administrator privileges required for Windows registry modification');
      }
    }
  } catch (error: any) {
    console.error(colorText(`Registration failed: ${error.message}`, 'red'));
    throw error;
  }
}
