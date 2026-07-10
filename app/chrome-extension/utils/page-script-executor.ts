import { cdpSessionManager } from './cdp-session-manager';

export const PAGE_SCRIPT_EXECUTION_LIMITS = Object.freeze({
  maxCodeBytes: 100_000,
  maxArgumentsBytes: 128 * 1024,
  maxResultBytes: 1024 * 1024,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 5 * 60_000,
});

export interface ExecutePageScriptOptions {
  tabId: number;
  frameId?: number;
  code: string;
  mode?: 'body' | 'raw';
  args?: Record<string, unknown>;
  world?: 'MAIN' | 'ISOLATED';
  timeoutMs?: number;
  owner?: string;
}

interface RuntimeRemoteObject {
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface RuntimeEvaluateResponse {
  result?: RuntimeRemoteObject;
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: string };
  };
}

interface CdpFrameTreeNode {
  frame?: { id?: string; url?: string };
  childFrames?: CdpFrameTreeNode[];
}

interface CdpFrameDescriptor {
  id: string;
  url: string;
  parentId: string | null;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_IDENTIFIERS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return PAGE_SCRIPT_EXECUTION_LIMITS.defaultTimeoutMs;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Page script timeout must be a positive integer');
  }
  return Math.min(value, PAGE_SCRIPT_EXECUTION_LIMITS.maxTimeoutMs);
}

function serializeArguments(args: Record<string, unknown>): string {
  for (const name of Object.keys(args)) {
    if (!IDENTIFIER_PATTERN.test(name) || RESERVED_IDENTIFIERS.has(name)) {
      throw new Error(
        `Invalid page script argument name: ${JSON.stringify(name)}`,
      );
    }
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(args);
  } catch {
    throw new Error('Page script arguments must be JSON serializable');
  }
  if (
    serialized === undefined ||
    byteLength(serialized) > PAGE_SCRIPT_EXECUTION_LIMITS.maxArgumentsBytes
  ) {
    throw new Error('Page script arguments exceed the supported byte limit');
  }
  return serialized
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function buildExpression(options: ExecutePageScriptOptions): string {
  if (typeof options.code !== 'string' || !options.code.trim()) {
    throw new Error('Page script code must not be empty');
  }
  if (byteLength(options.code) > PAGE_SCRIPT_EXECUTION_LIMITS.maxCodeBytes) {
    throw new Error(
      `Page script code exceeds the ${PAGE_SCRIPT_EXECUTION_LIMITS.maxCodeBytes} byte limit`,
    );
  }
  if ((options.mode ?? 'body') === 'raw') return options.code;

  const args = options.args ?? {};
  const serialized = serializeArguments(args);
  const names = Object.keys(args);
  const declarations = names
    .map((name) => `const ${name} = __webpageMcpArgs[${JSON.stringify(name)}];`)
    .join('\n');
  return `(async function () {\nconst __webpageMcpArgs = ${serialized};\n${declarations}\n${options.code}\n}).call(globalThis)`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`Page script execution timed out after ${timeoutMs}ms`),
        ),
      timeoutMs,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function extractResult(response: RuntimeEvaluateResponse): unknown {
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.exception?.value ||
        response.exceptionDetails.text ||
        'Page script failed',
    );
  }
  const remote = response.result;
  if (!remote) return null;
  if (Object.prototype.hasOwnProperty.call(remote, 'value'))
    return remote.value;
  if (typeof remote.unserializableValue === 'string')
    return remote.unserializableValue;
  if (typeof remote.description === 'string') return remote.description;
  return null;
}

function enforceResultLimit(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Page script result is not JSON serializable');
  }
  if (serialized === undefined) return null;
  if (byteLength(serialized) > PAGE_SCRIPT_EXECUTION_LIMITS.maxResultBytes) {
    throw new Error(
      `Page script result exceeds the ${PAGE_SCRIPT_EXECUTION_LIMITS.maxResultBytes} byte limit`,
    );
  }
  return value;
}

function flattenCdpFrames(
  node: CdpFrameTreeNode | undefined,
  parentId: string | null = null,
  output: CdpFrameDescriptor[] = [],
): CdpFrameDescriptor[] {
  const id = node?.frame?.id;
  if (!id) return output;
  output.push({ id, url: node.frame?.url ?? '', parentId });
  for (const child of node.childFrames ?? []) {
    flattenCdpFrames(child, id, output);
  }
  return output;
}

function buildAncestryPath<T extends string | number>(
  id: T,
  frames: Map<T, { url: string; parentId: T | null }>,
): string[] | null {
  const path: string[] = [];
  const visited = new Set<T>();
  let currentId: T | null = id;
  while (currentId !== null) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const current = frames.get(currentId);
    if (!current) return null;
    path.unshift(current.url);
    currentId = current.parentId;
  }
  return path;
}

async function resolveCdpFrameId(
  tabId: number,
  frameId: number,
): Promise<string> {
  const response = await cdpSessionManager.sendCommand<{
    frameTree?: CdpFrameTreeNode;
  }>(tabId, 'Page.getFrameTree');
  const cdpFrames = flattenCdpFrames(response?.frameTree);
  const root = cdpFrames.find((frame) => frame.parentId === null);
  if (!root) throw new Error('Unable to resolve the main CDP frame');
  if (frameId === 0) return root.id;

  const extensionFrames =
    (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  const target = extensionFrames.find((frame) => frame.frameId === frameId);
  if (!target) throw new Error(`Unable to resolve extension frame ${frameId}`);

  const extensionMap = new Map<
    number,
    { url: string; parentId: number | null }
  >();
  for (const frame of extensionFrames) {
    if (
      !Number.isSafeInteger(frame.frameId) ||
      !Number.isSafeInteger(frame.parentFrameId) ||
      typeof frame.url !== 'string'
    ) {
      continue;
    }
    extensionMap.set(frame.frameId, {
      url: frame.url,
      parentId: frame.parentFrameId < 0 ? null : frame.parentFrameId,
    });
  }
  const targetPath = buildAncestryPath(frameId, extensionMap);
  if (!targetPath) {
    throw new Error(
      `Unable to resolve ancestry for extension frame ${frameId}`,
    );
  }

  const cdpMap = new Map<string, { url: string; parentId: string | null }>(
    cdpFrames.map((frame) => [
      frame.id,
      { url: frame.url, parentId: frame.parentId },
    ]),
  );
  const serializedTargetPath = JSON.stringify(targetPath);
  const candidates = cdpFrames.filter((frame) => {
    const path = buildAncestryPath(frame.id, cdpMap);
    return path !== null && JSON.stringify(path) === serializedTargetPath;
  });
  if (candidates.length !== 1) {
    throw new Error(
      `CDP frame mapping for extension frame ${frameId} is ${candidates.length === 0 ? 'missing' : 'ambiguous'}`,
    );
  }
  return candidates[0].id;
}

async function resolveMainWorldContextId(
  tabId: number,
  cdpFrameId: string,
): Promise<number> {
  const debuggerApi = chrome.debugger;
  if (!debuggerApi?.onEvent) {
    throw new Error('Chrome debugger events are unavailable');
  }

  let resolveContext!: (contextId: number) => void;
  let rejectContext!: (error: Error) => void;
  const contextPromise = new Promise<number>((resolve, reject) => {
    resolveContext = resolve;
    rejectContext = reject;
  });
  let settled = false;
  const listener = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ): void => {
    if (source.tabId !== tabId || method !== 'Runtime.executionContextCreated')
      return;
    const context = (
      params as {
        context?: {
          id?: number;
          auxData?: { frameId?: string; isDefault?: boolean };
        };
      }
    )?.context;
    if (
      context?.auxData?.frameId === cdpFrameId &&
      context.auxData.isDefault === true &&
      Number.isSafeInteger(context.id)
    ) {
      settled = true;
      resolveContext(context.id!);
    }
  };
  debuggerApi.onEvent.addListener(listener);
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectContext(
      new Error(
        `Unable to resolve the MAIN execution context for frame ${cdpFrameId}`,
      ),
    );
  }, 500);
  try {
    await cdpSessionManager.sendCommand(tabId, 'Runtime.enable');
    return await contextPromise;
  } finally {
    clearTimeout(timer);
    debuggerApi.onEvent.removeListener(listener);
  }
}

/** Execute arbitrary workflow code only through Chrome's MV3-approved Debugger API. */
export async function executePageScript(
  options: ExecutePageScriptOptions,
): Promise<unknown> {
  if (!Number.isSafeInteger(options.tabId) || options.tabId < 0) {
    throw new Error('Page script tabId must be a non-negative integer');
  }
  const frameId = options.frameId ?? 0;
  if (!Number.isSafeInteger(frameId) || frameId < 0) {
    throw new Error('Page script frameId must be a non-negative integer');
  }
  const expression = buildExpression(options);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const owner = options.owner?.trim() || 'page-script';

  const response = await withTimeout(
    cdpSessionManager.withSession(options.tabId, owner, async () => {
      let contextId: number | undefined;
      if (options.world === 'ISOLATED' || frameId !== 0) {
        const cdpFrameId = await resolveCdpFrameId(options.tabId, frameId);
        if (options.world === 'ISOLATED') {
          const isolatedWorld = await cdpSessionManager.sendCommand<{
            executionContextId?: number;
          }>(options.tabId, 'Page.createIsolatedWorld', {
            frameId: cdpFrameId,
            worldName: 'webpage-mcp-workflow',
            grantUniveralAccess: false,
          });
          contextId = isolatedWorld?.executionContextId;
          if (!Number.isSafeInteger(contextId)) {
            throw new Error('Unable to create an isolated CDP execution world');
          }
        } else {
          contextId = await resolveMainWorldContextId(
            options.tabId,
            cdpFrameId,
          );
        }
      }

      return await cdpSessionManager.sendCommand<RuntimeEvaluateResponse>(
        options.tabId,
        'Runtime.evaluate',
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
          timeout: timeoutMs,
          ...(contextId === undefined ? {} : { contextId }),
        },
      );
    }),
    timeoutMs + 1_000,
  );

  return enforceResultLimit(extractResult(response));
}
