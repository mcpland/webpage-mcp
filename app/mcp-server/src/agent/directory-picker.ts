/**
 * Directory Picker Service.
 *
 * Provides cross-platform directory selection using native system dialogs.
 * Commands are launched without a shell and all user-controlled values are
 * passed separately from the static AppleScript and PowerShell programs.
 */
import { execFile } from "node:child_process";
import os from "node:os";

const DEFAULT_TITLE = "Select Project Directory";
const PICKER_TIMEOUT_MS = 60_000;
const MAX_TITLE_BYTES = 256;
const MAX_STDIO_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_ERROR_BYTES = 2 * 1024;
const WINDOWS_TITLE_ENV = "WEBPAGE_MCP_DIRECTORY_PICKER_TITLE";

const MACOS_PICKER_SCRIPT = [
  "on run argv",
  "  set dialogTitle to item 1 of argv",
  "  set selectedFolder to choose folder with prompt dialogTitle",
  "  return POSIX path of selectedFolder",
  "end run",
].join("\n");

const WINDOWS_PICKER_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "try {",
  "  $dialog.Description = $env:WEBPAGE_MCP_DIRECTORY_PICKER_TITLE",
  "  $dialog.ShowNewFolderButton = $true",
  "  $result = $dialog.ShowDialog()",
  "  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
  "    [Console]::Out.WriteLine($dialog.SelectedPath)",
  "  }",
  "} finally {",
  "  $dialog.Dispose()",
  "}",
].join("\n");

export interface DirectoryPickerResult {
  success: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
}

export interface DirectoryPickerCommandOptions {
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
  shell: false;
  env?: NodeJS.ProcessEnv;
}

export interface DirectoryPickerCommandResult {
  stdout: string;
  stderr: string;
}

export type DirectoryPickerRunner = (
  executable: string,
  args: readonly string[],
  options: DirectoryPickerCommandOptions,
) => Promise<DirectoryPickerCommandResult>;

export interface DirectoryPickerDependencies {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  runner?: DirectoryPickerRunner;
}

const defaultRunner: DirectoryPickerRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { ...options, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

function commandOptions(
  env?: NodeJS.ProcessEnv,
): DirectoryPickerCommandOptions {
  return {
    timeout: PICKER_TIMEOUT_MS,
    maxBuffer: MAX_STDIO_BYTES,
    windowsHide: true,
    shell: false,
    ...(env ? { env } : {}),
  };
}

function windowsPickerEnvironment(title: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.toUpperCase() !== WINDOWS_TITLE_ENV,
    ),
  );
  env[WINDOWS_TITLE_ENV] = title;
  return env;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (utf8Bytes(value) <= maximumBytes) {
    return value;
  }

  const bounded = Buffer.from(value, "utf8")
    .subarray(0, maximumBytes)
    .toString("utf8");
  return bounded.endsWith("\uFFFD") ? bounded.slice(0, -1) : bounded;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateUtf8(message || "Directory picker failed", MAX_ERROR_BYTES);
}

function normalizeTitle(title: unknown): { title?: string; error?: string } {
  if (typeof title !== "string") {
    return { error: "Dialog title must be a string" };
  }
  if (utf8Bytes(title) > MAX_TITLE_BYTES) {
    return { error: `Dialog title exceeds ${MAX_TITLE_BYTES} UTF-8 bytes` };
  }
  if (title.includes("\0")) {
    return { error: "Dialog title contains a null character" };
  }
  return { title: title.trim() };
}

function pickerOutput(stdout: string): DirectoryPickerResult {
  if (utf8Bytes(stdout) > MAX_STDIO_BYTES) {
    return {
      success: false,
      error: "Directory picker output exceeded the safe limit",
    };
  }

  const selectedPath = stdout.trim();
  if (!selectedPath) {
    return { success: false, cancelled: true };
  }
  if (selectedPath.includes("\0")) {
    return {
      success: false,
      error: "Selected directory path contains a null character",
    };
  }
  if (utf8Bytes(selectedPath) > MAX_PATH_BYTES) {
    return {
      success: false,
      error: `Selected directory path exceeds ${MAX_PATH_BYTES} UTF-8 bytes`,
    };
  }
  return { success: true, path: selectedPath };
}

function processFailure(error: unknown): {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
} {
  if (!error || typeof error !== "object") {
    return {};
  }
  return error as {
    code?: string | number;
    killed?: boolean;
    signal?: NodeJS.Signals | null;
  };
}

function wasCancelled(error: unknown): boolean {
  const { code } = processFailure(error);
  return code === 1 || code === "1";
}

function wasTimedOut(error: unknown): boolean {
  const { code, killed } = processFailure(error);
  return killed === true || code === "ETIMEDOUT";
}

function exceededOutputLimit(error: unknown): boolean {
  return processFailure(error).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function timeoutResult(): DirectoryPickerResult {
  return { success: false, error: "Dialog timed out" };
}

function outputLimitResult(): DirectoryPickerResult {
  return {
    success: false,
    error: "Directory picker output exceeded the safe limit",
  };
}

/**
 * Open a native directory picker dialog.
 * Returns the selected directory path or indicates cancellation.
 */
export async function openDirectoryPicker(
  title: string = DEFAULT_TITLE,
  dependencies: DirectoryPickerDependencies = {},
): Promise<DirectoryPickerResult> {
  const normalizedTitle = normalizeTitle(title);
  if (normalizedTitle.error || normalizedTitle.title === undefined) {
    return { success: false, error: normalizedTitle.error };
  }

  const platform = dependencies.platform ?? os.platform();
  const runner = dependencies.runner ?? defaultRunner;

  try {
    switch (platform) {
      case "darwin":
        return await openMacOSPicker(normalizedTitle.title, runner);
      case "win32":
        return await openWindowsPicker(normalizedTitle.title, runner);
      case "linux":
        return await openLinuxPicker(
          normalizedTitle.title,
          dependencies.homeDirectory ?? os.homedir(),
          runner,
        );
      default:
        return {
          success: false,
          error: `Unsupported platform: ${platform}`,
        };
    }
  } catch (error) {
    return {
      success: false,
      error: safeErrorMessage(error),
    };
  }
}

/** macOS: Use a static AppleScript program and pass the title as argv. */
async function openMacOSPicker(
  title: string,
  runner: DirectoryPickerRunner,
): Promise<DirectoryPickerResult> {
  try {
    const { stdout } = await runner(
      "osascript",
      ["-e", MACOS_PICKER_SCRIPT, "--", title],
      commandOptions(),
    );
    return pickerOutput(stdout);
  } catch (error) {
    if (wasCancelled(error)) {
      return { success: false, cancelled: true };
    }
    if (wasTimedOut(error)) {
      return timeoutResult();
    }
    if (exceededOutputLimit(error)) {
      return outputLimitResult();
    }
    throw error;
  }
}

/** Windows: Use a static PowerShell program and pass the title via the environment. */
async function openWindowsPicker(
  title: string,
  runner: DirectoryPickerRunner,
): Promise<DirectoryPickerResult> {
  try {
    const { stdout } = await runner(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        WINDOWS_PICKER_SCRIPT,
      ],
      commandOptions(windowsPickerEnvironment(title)),
    );
    return pickerOutput(stdout);
  } catch (error) {
    if (wasTimedOut(error)) {
      return timeoutResult();
    }
    if (exceededOutputLimit(error)) {
      return outputLimitResult();
    }
    throw error;
  }
}

/** Linux: Try zenity first, then kdialog as fallback. */
async function openLinuxPicker(
  title: string,
  homeDirectory: string,
  runner: DirectoryPickerRunner,
): Promise<DirectoryPickerResult> {
  try {
    const { stdout } = await runner(
      "zenity",
      ["--file-selection", "--directory", "--title", title],
      commandOptions(),
    );
    return pickerOutput(stdout);
  } catch (error) {
    if (wasCancelled(error)) {
      return { success: false, cancelled: true };
    }
    if (wasTimedOut(error)) {
      return timeoutResult();
    }
    if (exceededOutputLimit(error)) {
      return outputLimitResult();
    }
  }

  try {
    const { stdout } = await runner(
      "kdialog",
      ["--getexistingdirectory", homeDirectory, "--title", title],
      commandOptions(),
    );
    return pickerOutput(stdout);
  } catch (error) {
    if (wasCancelled(error)) {
      return { success: false, cancelled: true };
    }
    if (wasTimedOut(error)) {
      return timeoutResult();
    }
    if (exceededOutputLimit(error)) {
      return outputLimitResult();
    }
    return {
      success: false,
      error: "No directory picker available. Please install zenity or kdialog.",
    };
  }
}
