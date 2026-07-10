export const USER_SCRIPT_EXECUTION_LIMITS = Object.freeze({
  maxCodeBytes: 256 * 1024,
  maxFrameIds: 256,
  maxResults: 256,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 5 * 60_000,
  maxRegisteredScripts: 256,
  maxMatchPatterns: 100,
});

export type UserScriptWorld = 'MAIN' | 'USER_SCRIPT';

export interface ExecuteUserScriptOptions {
  tabId: number;
  code: string;
  world?: UserScriptWorld;
  frameIds?: number[];
  allFrames?: boolean;
  injectImmediately?: boolean;
  timeoutMs?: number;
}

type UserScriptsApi = Pick<
  typeof chrome.userScripts,
  'execute' | 'getScripts' | 'register' | 'unregister' | 'update'
>;

function getUserScriptsApi(): UserScriptsApi {
  const api = (chrome as typeof chrome & { userScripts?: UserScriptsApi }).userScripts;
  if (!api || typeof api.execute !== 'function') {
    throw new Error(
      'Chrome User Scripts API is unavailable. In Chrome 135–137 enable Developer mode; in Chrome 138+ enable Allow User Scripts on the extension details page.',
    );
  }
  return api;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return USER_SCRIPT_EXECUTION_LIMITS.defaultTimeoutMs;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('User script timeout must be a positive integer');
  }
  return Math.min(timeoutMs, USER_SCRIPT_EXECUTION_LIMITS.maxTimeoutMs);
}

function validateTarget(options: ExecuteUserScriptOptions): chrome.userScripts.InjectionTarget {
  if (!Number.isSafeInteger(options.tabId) || options.tabId < 0) {
    throw new Error('User script tabId must be a non-negative integer');
  }
  if (options.allFrames && options.frameIds !== undefined) {
    throw new Error('User script target cannot combine allFrames with frameIds');
  }

  let frameIds: number[] | undefined;
  if (options.frameIds !== undefined) {
    if (
      !Array.isArray(options.frameIds) ||
      options.frameIds.length === 0 ||
      options.frameIds.length > USER_SCRIPT_EXECUTION_LIMITS.maxFrameIds
    ) {
      throw new Error('User script frameIds exceed the supported bounds');
    }
    frameIds = [...new Set(options.frameIds)];
    if (
      frameIds.length !== options.frameIds.length ||
      frameIds.some((frameId) => !Number.isSafeInteger(frameId) || frameId < 0)
    ) {
      throw new Error('User script frameIds must be unique non-negative integers');
    }
  }

  return {
    tabId: options.tabId,
    allFrames: options.allFrames || undefined,
    frameIds,
  };
}

function validateCode(code: string): void {
  if (typeof code !== 'string' || !code.trim()) {
    throw new Error('User script code must not be empty');
  }
  const bytes = new TextEncoder().encode(code).byteLength;
  if (bytes > USER_SCRIPT_EXECUTION_LIMITS.maxCodeBytes) {
    throw new Error(
      `User script code exceeds the ${USER_SCRIPT_EXECUTION_LIMITS.maxCodeBytes} byte limit`,
    );
  }
}

function validateRegisteredScript(script: chrome.userScripts.RegisteredUserScript): void {
  if (!/^[A-Za-z0-9_]+$/.test(script.id) || script.id.startsWith('_')) {
    throw new Error('Registered user script id is invalid');
  }
  if (
    !Array.isArray(script.matches) ||
    script.matches.length === 0 ||
    script.matches.length > USER_SCRIPT_EXECUTION_LIMITS.maxMatchPatterns
  ) {
    throw new Error('Registered user script matches exceed the supported bounds');
  }
  if (
    script.excludeMatches !== undefined &&
    (!Array.isArray(script.excludeMatches) ||
      script.excludeMatches.length > USER_SCRIPT_EXECUTION_LIMITS.maxMatchPatterns)
  ) {
    throw new Error('Registered user script excludes exceed the supported bounds');
  }
  if (!Array.isArray(script.js) || script.js.length !== 1 || !script.js[0]?.code) {
    throw new Error('Registered user script must contain exactly one code source');
  }
  validateCode(script.js[0].code);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`User script execution timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export async function executeUserScript(
  options: ExecuteUserScriptOptions,
): Promise<chrome.userScripts.InjectionResult[]> {
  validateCode(options.code);
  const target = validateTarget(options);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const world = options.world ?? 'USER_SCRIPT';
  const api = getUserScriptsApi();

  const results = await withTimeout(
    api.execute({
      target,
      world,
      injectImmediately: options.injectImmediately ?? true,
      js: [{ code: options.code }],
    }),
    timeoutMs,
  );
  if (!Array.isArray(results) || results.length > USER_SCRIPT_EXECUTION_LIMITS.maxResults) {
    throw new Error('Chrome returned an invalid user script result set');
  }
  const failedResult = results.find(
    (result) => typeof result?.error === 'string' && result.error.trim(),
  );
  if (failedResult?.error) {
    throw new Error(failedResult.error);
  }
  return results;
}

export async function upsertRegisteredUserScript(
  script: chrome.userScripts.RegisteredUserScript,
): Promise<void> {
  validateRegisteredScript(script);
  const api = getUserScriptsApi();
  const existing = await api.getScripts({ ids: [script.id] });
  if (existing.length > 1) {
    throw new Error(`Chrome returned duplicate user script registrations for ${script.id}`);
  }
  if (existing.length === 1) {
    await api.update([script]);
  } else {
    await api.register([script]);
  }
}

export async function unregisterUserScripts(ids: string[]): Promise<void> {
  if (
    !Array.isArray(ids) ||
    ids.length > USER_SCRIPT_EXECUTION_LIMITS.maxRegisteredScripts ||
    ids.some((id) => !/^[A-Za-z0-9_]+$/.test(id) || id.startsWith('_'))
  ) {
    throw new Error('User script unregister ids exceed the supported bounds');
  }
  if (ids.length === 0) return;
  await getUserScriptsApi().unregister({ ids: [...new Set(ids)] });
}

export async function listRegisteredUserScripts(): Promise<
  chrome.userScripts.RegisteredUserScript[]
> {
  const scripts = await getUserScriptsApi().getScripts();
  if (
    !Array.isArray(scripts) ||
    scripts.length > USER_SCRIPT_EXECUTION_LIMITS.maxRegisteredScripts
  ) {
    throw new Error('Chrome returned too many registered user scripts');
  }
  return scripts;
}
