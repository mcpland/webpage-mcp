import {
  X_OK,
  accessSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

export const EXECUTABLE_PATH_MAX_ENTRIES = 256;

type PathImplementation = typeof path.posix;

export interface TrustedExecutableResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  untrustedCwd?: string;
  isRunnableFile?: (candidate: string, platform: NodeJS.Platform) => boolean;
  canonicalize?: (candidate: string) => string;
}

function getPathImplementation(platform: NodeJS.Platform): PathImplementation {
  return platform === 'win32' ? path.win32 : path.posix;
}

function getEnvironmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[key];
  const matchedKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return matchedKey ? env[matchedKey] : undefined;
}

function defaultIsRunnableFile(
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== 'win32') accessSync(candidate, X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultCanonicalize(candidate: string): string {
  return realpathSync.native(candidate);
}

function stripOptionalPathQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function isWithinDirectory(
  candidate: string,
  directory: string,
  pathImplementation: PathImplementation,
  platform: NodeJS.Platform,
): boolean {
  const normalizeForComparison = (value: string): string =>
    platform === 'win32' ? value.toLowerCase() : value;
  const relative = normalizeForComparison(
    pathImplementation.relative(directory, candidate),
  );
  return (
    relative === '' ||
    (!relative.startsWith(`..${pathImplementation.sep}`) &&
      relative !== '..' &&
      !pathImplementation.isAbsolute(relative))
  );
}

function getWindowsExtensions(
  command: string,
  env: NodeJS.ProcessEnv,
): string[] {
  if (path.win32.extname(command)) return [''];
  const configured = getEnvironmentValue(env, 'PATHEXT', 'win32');
  const extensions = (configured || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => /^\.[a-z0-9]+$/i.test(entry))
    .slice(0, 32);
  return extensions.length > 0 ? extensions : ['.COM', '.EXE', '.BAT', '.CMD'];
}

/**
 * Resolve an executable before changing to an untrusted project directory.
 *
 * Windows searches the child cwd before PATH for bare commands, including when
 * cross-spawn uses `shell: false`. Returning a canonical absolute path prevents
 * a repository-local `node.cmd` or `codex.cmd` from taking precedence.
 */
export function resolveTrustedExecutable(
  command: string,
  options: TrustedExecutableResolveOptions = {},
): string {
  if (!command || command !== command.trim() || command.includes('\0')) {
    throw new Error('Executable command must be a non-empty, normalized string');
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const processExecPath = options.processExecPath ?? process.execPath;
  const pathImplementation = getPathImplementation(platform);
  const isRunnableFile = options.isRunnableFile ?? defaultIsRunnableFile;
  const canonicalize = options.canonicalize ?? defaultCanonicalize;

  let canonicalUntrustedCwd: string | undefined;
  if (options.untrustedCwd) {
    try {
      canonicalUntrustedCwd = canonicalize(options.untrustedCwd);
    } catch {
      canonicalUntrustedCwd = pathImplementation.resolve(options.untrustedCwd);
    }
  }

  const acceptCandidate = (candidate: string): string | null => {
    if (!isRunnableFile(candidate, platform)) return null;
    let canonicalCandidate: string;
    try {
      canonicalCandidate = canonicalize(candidate);
    } catch {
      return null;
    }
    if (!pathImplementation.isAbsolute(canonicalCandidate)) return null;
    if (
      canonicalUntrustedCwd &&
      isWithinDirectory(
        canonicalCandidate,
        canonicalUntrustedCwd,
        pathImplementation,
        platform,
      )
    ) {
      return null;
    }
    return canonicalCandidate;
  };

  const normalizedRuntimeName = pathImplementation.basename(command).toLowerCase();
  if (
    command === processExecPath ||
    normalizedRuntimeName === 'node' ||
    normalizedRuntimeName === 'node.exe' ||
    normalizedRuntimeName === 'bun' ||
    normalizedRuntimeName === 'bun.exe'
  ) {
    const resolvedRuntime = acceptCandidate(processExecPath);
    if (!resolvedRuntime) {
      throw new Error('The current JavaScript runtime is not a trusted executable');
    }
    return resolvedRuntime;
  }

  if (pathImplementation.isAbsolute(command)) {
    const resolvedAbsolute = acceptCandidate(command);
    if (!resolvedAbsolute) {
      throw new Error('Executable path is missing, not runnable, or inside the project');
    }
    return resolvedAbsolute;
  }

  if (command.includes('/') || command.includes('\\')) {
    throw new Error('Relative executable paths are not allowed');
  }

  const configuredPath = getEnvironmentValue(env, 'PATH', platform);
  const pathEntries = (configuredPath ?? '')
    .split(pathImplementation.delimiter)
    .slice(0, EXECUTABLE_PATH_MAX_ENTRIES);
  const extensions =
    platform === 'win32' ? getWindowsExtensions(command, env) : [''];

  for (const rawDirectory of pathEntries) {
    const directory = stripOptionalPathQuotes(rawDirectory.trim());
    // Empty and relative entries represent the current directory and must not
    // participate in lookup for a process launched inside an untrusted repo.
    if (!directory || !pathImplementation.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const resolved = acceptCandidate(
        pathImplementation.join(directory, `${command}${extension}`),
      );
      if (resolved) return resolved;
    }
  }

  throw new Error(
    `Unable to resolve a trusted absolute executable for ${JSON.stringify(command)}`,
  );
}
