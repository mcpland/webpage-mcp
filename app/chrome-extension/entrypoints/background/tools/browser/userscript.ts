import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { ExecutionWorld, STORAGE_KEYS } from '@/common/constants';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  USER_SCRIPT_EXECUTION_LIMITS,
  executeUserScript,
  listRegisteredUserScripts,
  unregisterUserScripts,
  upsertRegisteredUserScript,
} from '@/utils/user-script-executor';

type UserscriptAction =
  | 'create'
  | 'list'
  | 'get'
  | 'enable'
  | 'disable'
  | 'update'
  | 'remove'
  | 'send_command'
  | 'export';

interface UserscriptArgsBase {
  action: UserscriptAction;
  args?: any;
}

interface CreateArgs {
  script: string;
  name?: string;
  description?: string;
  matches?: string[];
  excludes?: string[];
  persist?: boolean; // default true
  runAt?: 'document_start' | 'document_end' | 'document_idle' | 'auto'; // default auto(document_idle)
  world?: 'auto' | 'ISOLATED' | 'MAIN'; // default auto(ISOLATED)
  allFrames?: boolean; // default true
  mode?: 'auto' | 'css' | 'persistent' | 'once'; // default auto
  dnrFallback?: boolean; // default true
  tags?: string[];
  tabId?: number;
  windowId?: number;
}

type UpdateArgs = Partial<Omit<CreateArgs, 'script'>> & { id: string; script?: string };

interface UserscriptRecord {
  id: string;
  name?: string;
  description?: string;
  script: string;
  sourceType: 'JS' | 'CSS' | 'TM';
  matches: string[];
  excludes: string[];
  runAt: 'document_start' | 'document_end' | 'document_idle';
  world: 'ISOLATED' | 'MAIN';
  allFrames: boolean;
  persist: boolean;
  dnrFallback: boolean;
  tags?: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  installedBy?: string;
  lastError?: string;
  applyCount?: number;
  lastAppliedAt?: number;
  sha256?: string;
  cspBlocked?: boolean;
}

// In-memory tracking of active injections per tab. JavaScript handlers also keep
// a registry inside their execution world so they can be disposed after a
// service worker restart, when this map is empty.
type ActiveInjection =
  | { kind: 'css'; source: string; allFrames: boolean }
  | { kind: 'js'; world: 'ISOLATED' | 'MAIN'; allFrames: boolean };
const activeInjections: Map<number, Map<string, ActiveInjection>> = new Map();

const MAIN_USERSCRIPT_REGISTRY = '__WEBPAGE_MCP_MAIN_USERSCRIPT_REGISTRY__';
const ISOLATED_USERSCRIPT_REGISTRY = '__WEBPAGE_MCP_ISOLATED_USERSCRIPT_REGISTRY__';

async function loadAllRecords(): Promise<Record<string, UserscriptRecord>> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.USERSCRIPTS]);
  return (res[STORAGE_KEYS.USERSCRIPTS] as Record<string, UserscriptRecord>) || {};
}

async function saveAllRecords(records: Record<string, UserscriptRecord>): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.USERSCRIPTS]: records });
}

// Simple FNV-1a hash for deterministic IDs
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  // Force to unsigned and hex
  return (h >>> 0).toString(16);
}

function now(): number {
  return Date.now();
}

async function computeSHA256(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Basic TM header parser (subset)
function parseUserscriptMeta(source: string): {
  meta: Record<string, string[]>;
  isTM: boolean;
} {
  const meta: Record<string, string[]> = {};
  const start = source.indexOf('==UserScript==');
  const end = source.indexOf('==/UserScript==');
  if (start !== -1 && end !== -1 && end > start) {
    const block = source.slice(start, end).split(/\r?\n/);
    for (const line of block) {
      const m = line.match(/@([\w-]+)\s+(.+)/);
      if (m) {
        const k = m[1].trim();
        const v = m[2].trim();
        if (!meta[k]) meta[k] = [];
        meta[k].push(v);
      }
    }
    return { meta, isTM: true };
  }
  return { meta: {}, isTM: false };
}

function pick<T>(arr: T[] | undefined): T | undefined {
  return arr && arr.length > 0 ? arr[0] : undefined;
}

function deriveName(meta: Record<string, string[]>, fallback?: string): string | undefined {
  return pick(meta['name']) || fallback;
}

function toBoolean(val: any, d: boolean): boolean {
  return typeof val === 'boolean' ? val : d;
}

// Very light CSS heuristic
function isLikelyCSS(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed.startsWith('/*') && trimmed.includes('==UserStyle')) return true;
  if (/^[.#\w\-\s*,:>+~\n\r{}();'"%!@/]+$/.test(trimmed)) {
    // no obvious JS keywords
    if (
      !/(function|=>|var\s|let\s|const\s|document\.|window\.|\beval\b|new\s+Function)/.test(trimmed)
    ) {
      // has CSS braces and colons
      const colon = (trimmed.match(/:/g) || []).length;
      const brace = (trimmed.match(/[{}]/g) || []).length;
      return colon > 0 && brace >= 2;
    }
  }
  return false;
}

function normalizeMatches(matches?: string[], currentUrl?: string): string[] {
  if (matches && matches.length > 0) return matches;
  if (!currentUrl) return ['<all_urls>'];
  try {
    const u = new URL(currentUrl);
    const host = u.hostname;
    const base = host.startsWith('www.') ? host.slice(4) : host;
    return [`${u.protocol}//*.${base}/*`, `${u.protocol}//${host}/*`];
  } catch {
    return ['<all_urls>'];
  }
}

const MAX_MATCH_PATTERNS = 100;
const MAX_MATCH_PATTERN_LENGTH = 2_048;
const MAX_MATCH_URL_LENGTH = 16_384;
const MAX_USERSCRIPT_TAGS = 32;
const MAX_USERSCRIPT_TAG_LENGTH = 128;

function validateUserscriptRecord(record: UserscriptRecord): void {
  if (
    !record.script.trim() ||
    new TextEncoder().encode(record.script).byteLength > USER_SCRIPT_EXECUTION_LIMITS.maxCodeBytes
  ) {
    throw new Error('Userscript source exceeds the supported byte limit');
  }
  for (const [label, patterns, allowEmpty] of [
    ['matches', record.matches, false],
    ['excludes', record.excludes, true],
  ] as const) {
    if (
      !Array.isArray(patterns) ||
      (!allowEmpty && patterns.length === 0) ||
      patterns.length > MAX_MATCH_PATTERNS ||
      patterns.some(
        (pattern) =>
          typeof pattern !== 'string' ||
          !pattern.trim() ||
          pattern.length > MAX_MATCH_PATTERN_LENGTH,
      )
    ) {
      throw new Error(`Userscript ${label} exceed the supported bounds`);
    }
  }
  if (
    record.tags !== undefined &&
    (!Array.isArray(record.tags) ||
      record.tags.length > MAX_USERSCRIPT_TAGS ||
      record.tags.some((tag) => typeof tag !== 'string' || tag.length > MAX_USERSCRIPT_TAG_LENGTH))
  ) {
    throw new Error('Userscript tags exceed the supported bounds');
  }
}

function matchWildcardPath(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const startsWithWildcard = pattern.startsWith('*');
  const endsWithWildcard = pattern.endsWith('*');
  const segments = pattern.split('*').filter(Boolean);
  if (segments.length === 0) return true;

  let segmentIndex = 0;
  let valueIndex = 0;
  if (!startsWithWildcard) {
    const first = segments[0];
    if (!value.startsWith(first)) return false;
    valueIndex = first.length;
    segmentIndex = 1;
  }

  const middleEnd = endsWithWildcard
    ? segments.length
    : Math.max(segmentIndex, segments.length - 1);
  for (; segmentIndex < middleEnd; segmentIndex += 1) {
    const foundAt = value.indexOf(segments[segmentIndex], valueIndex);
    if (foundAt < 0) return false;
    valueIndex = foundAt + segments[segmentIndex].length;
  }

  if (endsWithWildcard) return true;
  const last = segments[segments.length - 1];
  const lastStart = value.length - last.length;
  return lastStart >= valueIndex && value.endsWith(last);
}

function matchPatternHost(pattern: string, hostname: string): boolean {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedHost = hostname.toLowerCase();
  if (normalizedPattern === '*') return normalizedHost.length > 0;
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === normalizedPattern;
}

// Deterministic Chrome match-pattern subset. The wildcard matcher is linear
// and does not compile user-controlled patterns into backtracking regexes.
export function matchUrl(patterns: string[], url?: string): boolean {
  if (!url || url.length > MAX_MATCH_URL_LENGTH || !Array.isArray(patterns)) return false;
  try {
    const u = new URL(url);
    for (const rawPattern of patterns.slice(0, MAX_MATCH_PATTERNS)) {
      if (typeof rawPattern !== 'string' || rawPattern.length > MAX_MATCH_PATTERN_LENGTH) continue;
      const p = rawPattern;
      if (p === '<all_urls>') return true;
      const schemeEnd = p.indexOf('://');
      if (schemeEnd <= 0) continue;
      const scheme = p.slice(0, schemeEnd);
      const hostAndPath = p.slice(schemeEnd + 3);
      const pathStart = hostAndPath.indexOf('/');
      if (pathStart < 0) continue;
      const host = hostAndPath.slice(0, pathStart);
      const path = hostAndPath.slice(pathStart + 1);
      if (scheme !== '*' && `${scheme}:` !== u.protocol) continue;
      if (!matchPatternHost(host, u.hostname)) continue;
      const testPath = (u.pathname + (u.search || '') + (u.hash || '')).replace(/^\//, '');
      if (matchWildcardPath(path, testPath)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function recordMatchesUrl(record: UserscriptRecord, url?: string): boolean {
  return matchUrl(record.matches, url) && !matchUrl(record.excludes, url);
}

async function insertCssToTab(tabId: number, css: string, allFrames: boolean) {
  await chrome.scripting.insertCSS({ target: { tabId, allFrames }, css });
}

async function removeCssFromTab(tabId: number, css: string, allFrames: boolean) {
  try {
    await chrome.scripting.removeCSS({ target: { tabId, allFrames }, css });
  } catch (e) {
    // ignore if not present
  }
}

function toUserScriptWorld(world: 'ISOLATED' | 'MAIN'): chrome.userScripts.ExecutionWorld {
  return world === ExecutionWorld.MAIN ? 'MAIN' : 'USER_SCRIPT';
}

function buildUserscriptSource(scriptId: string, code: string, world: 'ISOLATED' | 'MAIN'): string {
  const id = JSON.stringify(scriptId);
  const registryName = JSON.stringify(
    world === ExecutionWorld.MAIN ? MAIN_USERSCRIPT_REGISTRY : ISOLATED_USERSCRIPT_REGISTRY,
  );
  const handlerName = JSON.stringify(
    world === ExecutionWorld.MAIN ? '__userscript_onCommand' : '__userscript_onCommand__',
  );
  const setup = `
const root = globalThis;
const id = ${id};
const registryName = ${registryName};
const handlerName = ${handlerName};
let registry = root[registryName];
if (!(registry instanceof Map)) {
  registry = new Map();
  root[registryName] = registry;
}
registry.get(id)?.();
const previousDescriptor = Object.getOwnPropertyDescriptor(root, handlerName);
let handler;
try {
  Reflect.deleteProperty(root, handlerName);
  (function () {
${code}
  }).call(root);
} finally {
  handler = root[handlerName];
  if (previousDescriptor) Object.defineProperty(root, handlerName, previousDescriptor);
  else Reflect.deleteProperty(root, handlerName);
}
`;

  return `(function () {${setup}
const eventHandler = (event) => {
  const detail = event.detail || {};
  if (detail.scriptId !== id) return;
  const respond = (response) => window.dispatchEvent(new CustomEvent('webpage-mcp:response', {
    detail: { requestId: detail.requestId, ...response },
  }));
  try {
    const result = typeof handler === 'function'
      ? handler(detail.action, detail.payload, detail.scriptId)
      : undefined;
    Promise.resolve(result).then(
      (data) => respond({ data }),
      (error) => respond({ error: String(error?.message || error) }),
    );
  } catch (error) {
    respond({ error: String(error?.message || error) });
  }
};
window.addEventListener('webpage-mcp:execute', eventHandler);
const dispose = () => {
  window.removeEventListener('webpage-mcp:execute', eventHandler);
  if (registry.get(id) === dispose) registry.delete(id);
};
registry.set(id, dispose);
})()`;
}

function toRegisteredUserScript(record: UserscriptRecord): chrome.userScripts.RegisteredUserScript {
  return {
    id: record.id,
    matches: record.matches,
    excludeMatches: record.excludes.length > 0 ? record.excludes : undefined,
    js: [{ code: buildUserscriptSource(record.id, record.script, record.world) }],
    runAt: record.runAt,
    world: toUserScriptWorld(record.world),
    allFrames: record.allFrames,
  };
}

async function injectJsPersistent(
  tabId: number,
  scriptId: string,
  code: string,
  world: 'ISOLATED' | 'MAIN',
  allFrames: boolean,
) {
  await executeUserScript({
    tabId,
    code: buildUserscriptSource(scriptId, code, world),
    world: toUserScriptWorld(world),
    allFrames,
  });
}

async function disposeJsFromTab(
  tabId: number,
  scriptId: string,
  world: 'ISOLATED' | 'MAIN',
  allFrames: boolean,
): Promise<void> {
  const registryName =
    world === ExecutionWorld.MAIN ? MAIN_USERSCRIPT_REGISTRY : ISOLATED_USERSCRIPT_REGISTRY;
  await executeUserScript({
    tabId,
    allFrames,
    world: toUserScriptWorld(world),
    code: `(function () {
const registry = globalThis[${JSON.stringify(registryName)}];
registry?.get(${JSON.stringify(scriptId)})?.();
})()`,
  });
}

function setActiveInjection(tabId: number, id: string, inj: ActiveInjection) {
  let m = activeInjections.get(tabId);
  if (!m) {
    m = new Map();
    activeInjections.set(tabId, m);
  }
  m.set(id, inj);
}

function clearActiveInjection(tabId: number, id: string) {
  const m = activeInjections.get(tabId);
  if (!m) return;
  m.delete(id);
  if (m.size === 0) activeInjections.delete(tabId);
}

async function cleanupActiveInjection(
  tabId: number,
  scriptId: string,
  injection: ActiveInjection,
): Promise<void> {
  try {
    if (injection.kind === 'css') {
      await removeCssFromTab(tabId, injection.source, injection.allFrames);
    } else {
      await disposeJsFromTab(tabId, scriptId, injection.world, injection.allFrames);
    }
  } finally {
    clearActiveInjection(tabId, scriptId);
  }
}

async function cleanupRecordFromAllTabs(record: UserscriptRecord): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  const tabIds = new Set<number>();
  for (const tab of tabs) {
    if (typeof tab.id === 'number') tabIds.add(tab.id);
  }
  for (const [tabId, injections] of activeInjections) {
    if (injections.has(record.id)) tabIds.add(tabId);
  }

  await Promise.all(
    Array.from(tabIds, async (tabId) => {
      const tracked = activeInjections.get(tabId)?.get(record.id);
      if (tracked) {
        await cleanupActiveInjection(tabId, record.id, tracked).catch(() => {});
      }

      if (record.sourceType === 'CSS') {
        await removeCssFromTab(tabId, record.script, record.allFrames);
        return;
      }

      // Dispose both worlds. This also cleans up pages that survived a service
      // worker restart or a world change during an update.
      await Promise.all(
        (['ISOLATED', 'MAIN'] as const).map((world) =>
          disposeJsFromTab(tabId, record.id, world, record.allFrames).catch(() => {}),
        ),
      );
    }),
  );
}

async function applyRecordToTab(record: UserscriptRecord, tabId: number): Promise<void> {
  const tracked = activeInjections.get(tabId)?.get(record.id);
  if (tracked) await cleanupActiveInjection(tabId, record.id, tracked).catch(() => {});

  if (record.sourceType === 'CSS') {
    await insertCssToTab(tabId, record.script, record.allFrames);
    setActiveInjection(tabId, record.id, {
      kind: 'css',
      source: record.script,
      allFrames: record.allFrames,
    });
    return;
  }

  await injectJsPersistent(tabId, record.id, record.script, record.world, record.allFrames);
  setActiveInjection(tabId, record.id, {
    kind: 'js',
    world: record.world,
    allFrames: record.allFrames,
  });
}

async function applyRecordToMatchingTabs(record: UserscriptRecord): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== 'number' || !recordMatchesUrl(record, tab.url)) return;
      await applyRecordToTab(record, tab.id).catch((error) => {
        console.warn('Userscript injection failed for tab', tab.id, record.id, error);
      });
    }),
  );
}

function isJavaScriptRecord(record: UserscriptRecord): boolean {
  return record.sourceType === 'JS' || record.sourceType === 'TM';
}

async function synchronizeRegisteredUserScripts(): Promise<void> {
  const [records, disabledResult, registered] = await Promise.all([
    loadAllRecords(),
    chrome.storage.local.get([STORAGE_KEYS.USERSCRIPTS_DISABLED]),
    listRegisteredUserScripts(),
  ]);
  const disabled = Boolean(disabledResult[STORAGE_KEYS.USERSCRIPTS_DISABLED]);
  const desired = new Map(
    Object.values(records)
      .filter(
        (record) => !disabled && record.enabled && record.persist && isJavaScriptRecord(record),
      )
      .map((record) => [record.id, record]),
  );
  const staleIds = registered
    .filter((script) => script.id.startsWith('us_') && !desired.has(script.id))
    .map((script) => script.id);
  await unregisterUserScripts(staleIds);
  for (const record of desired.values()) {
    await upsertRegisteredUserScript(toRegisteredUserScript(record));
  }
}

async function reinjectForTab(tabId: number, url?: string) {
  // Emergency global switch
  const flag = (await chrome.storage.local.get([STORAGE_KEYS.USERSCRIPTS_DISABLED]))[
    STORAGE_KEYS.USERSCRIPTS_DISABLED
  ];
  if (flag) return;
  const all = await loadAllRecords();
  for (const rec of Object.values(all)) {
    if (!rec.enabled || !rec.persist || rec.sourceType !== 'CSS' || rec.runAt !== 'document_idle')
      continue;
    if (!recordMatchesUrl(rec, url)) continue;
    try {
      await applyRecordToTab(rec, tabId);
    } catch (e) {
      console.warn('Reinject failed for tab', tabId, rec.id, e);
    }
  }
}

// Tab update listener: re-apply enabled persistent scripts
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    reinjectForTab(tabId, tab.url).catch(() => {});
  }
});

// webNavigation based runAt mapping
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  // A top-level navigation destroys the old execution worlds and their
  // handlers. Drop the old bookkeeping before applying the new document.
  activeInjections.delete(details.tabId);
  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  if (!tab) return;
  const disabled = (await chrome.storage.local.get([STORAGE_KEYS.USERSCRIPTS_DISABLED]))[
    STORAGE_KEYS.USERSCRIPTS_DISABLED
  ];
  if (disabled) return;
  const all = await loadAllRecords();
  for (const rec of Object.values(all)) {
    if (!rec.enabled || !rec.persist || rec.sourceType !== 'CSS' || rec.runAt !== 'document_start')
      continue;
    if (!recordMatchesUrl(rec, tab.url)) continue;
    try {
      await applyRecordToTab(rec, details.tabId);
    } catch {
      // noop
    }
  }
});

chrome.webNavigation.onDOMContentLoaded.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  if (!tab) return;
  const disabled = (await chrome.storage.local.get([STORAGE_KEYS.USERSCRIPTS_DISABLED]))[
    STORAGE_KEYS.USERSCRIPTS_DISABLED
  ];
  if (disabled) return;
  const all = await loadAllRecords();
  for (const rec of Object.values(all)) {
    if (!rec.enabled || !rec.persist || rec.sourceType !== 'CSS' || rec.runAt !== 'document_end')
      continue;
    if (!recordMatchesUrl(rec, tab.url)) continue;
    try {
      await applyRecordToTab(rec, details.tabId);
    } catch {
      // noop
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeInjections.delete(tabId);
});

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local' || !(STORAGE_KEYS.USERSCRIPTS_DISABLED in changes)) return;
  void (async () => {
    await synchronizeRegisteredUserScripts();
    const records = await loadAllRecords();
    const disabled = Boolean(changes[STORAGE_KEYS.USERSCRIPTS_DISABLED]?.newValue);
    if (disabled) {
      await Promise.all(Object.values(records).map((record) => cleanupRecordFromAllTabs(record)));
      return;
    }
    await Promise.all(
      Object.values(records)
        .filter((record) => record.enabled)
        .map((record) => applyRecordToMatchingTabs(record)),
    );
  })().catch((error) => console.warn('Failed to apply userscript emergency state:', error));
});

if ((chrome as typeof chrome & { userScripts?: unknown }).userScripts) {
  void synchronizeRegisteredUserScripts().catch((error) =>
    console.warn('Failed to synchronize registered user scripts:', error),
  );
}

class UserscriptTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.USERSCRIPT;

  private async resolveTargetTab(target?: {
    tabId?: number;
    windowId?: number;
  }): Promise<chrome.tabs.Tab | null> {
    if (typeof target?.tabId === 'number') {
      return await this.tryGetTab(target.tabId);
    }
    try {
      if (typeof target?.windowId === 'number') {
        return await this.getActiveTabOrThrowInWindow(target.windowId);
      }
      return await this.getActiveTabOrThrow();
    } catch {
      return null;
    }
  }

  async execute(params: UserscriptArgsBase): Promise<ToolResult> {
    try {
      const { action } = params;
      const args = params.args || {};

      switch (action) {
        case 'create':
          return await this.create(args as CreateArgs);
        case 'list':
          return await this.list(args);
        case 'get':
          return await this.get(args);
        case 'enable':
          return await this.enable(args, true);
        case 'disable':
          return await this.enable(args, false);
        case 'update':
          return await this.update(args as UpdateArgs);
        case 'remove':
          return await this.remove(args);
        case 'send_command':
          return await this.sendCommand(args);
        case 'export':
          return await this.exportAll();
        default:
          return createErrorResponse(`Unknown action: ${String(action)}`);
      }
    } catch (error) {
      console.error('Userscript tool error:', error);
      return createErrorResponse(
        `Userscript error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async create(args: CreateArgs): Promise<ToolResult> {
    if (typeof args.script !== 'string' || !args.script.trim()) {
      return createErrorResponse('script is required');
    }
    const active = await this.resolveTargetTab({ tabId: args.tabId, windowId: args.windowId });
    if (!active || !active.id) {
      if (typeof args.tabId === 'number') {
        return createErrorResponse(`Tab not found: ${args.tabId}`);
      }
      return createErrorResponse('No active tab found');
    }
    const currentUrl = active.url;

    const emergency = (await chrome.storage.local.get([STORAGE_KEYS.USERSCRIPTS_DISABLED]))[
      STORAGE_KEYS.USERSCRIPTS_DISABLED
    ];

    const { meta, isTM } = parseUserscriptMeta(args.script);
    const name = args.name || deriveName(meta, undefined);
    const description = args.description || pick(meta['description']);
    const matches = normalizeMatches(args.matches || meta['match'] || meta['include'], currentUrl);
    const excludes = args.excludes || meta['exclude'] || [];

    const runAt: UserscriptRecord['runAt'] =
      (args.runAt && args.runAt !== 'auto' ? args.runAt : (pick(meta['run-at']) as any)) ||
      'document_idle';
    const requestedWorld =
      (args.world && args.world !== 'auto' ? args.world : (pick(meta['inject-into']) as any)) ||
      'ISOLATED';
    const allFrames = toBoolean(args.allFrames, true);
    const mode = args.mode || 'auto';
    const persist = mode === 'once' ? false : toBoolean(args.persist, true);
    const dnrFallback = toBoolean(args.dnrFallback, true);

    const sourceType: UserscriptRecord['sourceType'] = isTM
      ? 'TM'
      : mode === 'css' || isLikelyCSS(args.script)
        ? 'CSS'
        : 'JS';

    const sha256 = await computeSHA256(args.script).catch(() => undefined);
    const id = `us_${fnv1a((name || '') + '|' + args.script)}`;

    const record: UserscriptRecord = {
      id,
      name,
      description,
      script: args.script,
      sourceType,
      matches,
      excludes,
      runAt,
      world: requestedWorld === 'MAIN' ? 'MAIN' : 'ISOLATED',
      allFrames,
      persist,
      dnrFallback,
      tags: args.tags,
      enabled: true,
      createdAt: now(),
      updatedAt: now(),
      applyCount: 0,
      sha256,
      installedBy: 'local-extension-ui',
    };
    validateUserscriptRecord(record);

    const all = await loadAllRecords();
    if (record.persist) {
      all[id] = record;
      await saveAllRecords(all);
    }

    // Apply to current tab immediately if matches
    let applied = false;
    const t0 = performance.now();
    try {
      if (emergency) {
        applied = false;
      } else if (mode === 'once') {
        // Once: CDP evaluate in page
        await cdpSessionManager.withSession(active.id!, 'userscript_once', async () => {
          const expression = `(function(){try{return (function(){${record.script}\n})()}catch(e){return {__error:String(e&&e.message||e)}}})()`;
          const result: any = await cdpSessionManager.sendCommand(active.id!, 'Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          if (result?.result?.value?.__error) {
            throw new Error(result.result.value.__error);
          }
        });
        applied = true;
      } else if (sourceType === 'CSS') {
        await insertCssToTab(active.id!, record.script, record.allFrames);
        setActiveInjection(active.id!, id, {
          kind: 'css',
          source: record.script,
          allFrames: record.allFrames,
        });
        applied = true;
      } else {
        if (record.persist) {
          await upsertRegisteredUserScript(toRegisteredUserScript(record));
        }
        await injectJsPersistent(active.id!, id, record.script, record.world, record.allFrames);
        setActiveInjection(active.id!, id, {
          kind: 'js',
          world: record.world,
          allFrames: record.allFrames,
        });
        applied = true;
      }
    } catch (e) {
      if (record.persist) {
        all[id].lastError = e instanceof Error ? e.message : String(e);
        all[id].cspBlocked = false;
        await saveAllRecords(all);
      }
    }

    const result = {
      id,
      status: record.persist && all[id]?.lastError ? 'queued' : applied ? 'applied' : 'queued',
      strategy: {
        kind:
          mode === 'once'
            ? 'once_cdp'
            : sourceType === 'CSS'
              ? 'insertCSS'
              : `persistent_${(record.persist ? all[id]?.world || record.world : record.world).toLowerCase()}`,
        runAt: record.persist ? all[id]?.runAt || record.runAt : record.runAt,
        world: record.persist ? all[id]?.world || record.world : record.world,
        allFrames: record.persist ? (all[id]?.allFrames ?? record.allFrames) : record.allFrames,
        fallbacksTried: [],
        cspBlocked: false,
      },
      warnings: emergency ? ['USERSCRIPTS_DISABLED is ON, injection skipped'] : [],
      metrics: { injectMs: Math.round(performance.now() - t0) },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
    };
  }

  private async list(args: any): Promise<ToolResult> {
    const all = await loadAllRecords();
    const q = (args && args.query ? String(args.query).toLowerCase() : '').trim();
    const status = args && args.status ? String(args.status) : '';
    const domain = args && args.domain ? String(args.domain) : '';
    const items = Object.values(all)
      .filter((r) => (status ? (status === 'enabled' ? r.enabled : !r.enabled) : true))
      .filter((r) => (domain ? matchUrl(r.matches, `https://${domain}/`) : true))
      .filter((r) =>
        q
          ? (r.name || '').toLowerCase().includes(q) ||
            (r.description || '').toLowerCase().includes(q)
          : true,
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        status: r.enabled ? 'enabled' : 'disabled',
        sourceType: r.sourceType,
        matches: r.matches,
        world: r.world,
        runAt: r.runAt,
        tags: r.tags || [],
        lastError: r.lastError,
        updatedAt: r.updatedAt,
        applyCount: r.applyCount || 0,
        lastAppliedAt: r.lastAppliedAt || null,
      }));
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, items }) }],
      isError: false,
    };
  }

  private async get(args: any): Promise<ToolResult> {
    const { id } = args || {};
    if (!id) return createErrorResponse('id is required');
    const all = await loadAllRecords();
    const rec = all[id];
    if (!rec) return createErrorResponse('userscript not found');
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, record: rec }) }],
      isError: false,
    };
  }

  private async enable(args: any, enabled: boolean): Promise<ToolResult> {
    const { id } = args || {};
    if (!id) return createErrorResponse('id is required');
    const all = await loadAllRecords();
    const rec = all[id];
    if (!rec) return createErrorResponse('userscript not found');
    rec.enabled = enabled;
    rec.updatedAt = now();
    await saveAllRecords(all);
    if (enabled) {
      const disabled = Boolean(
        (await chrome.storage.local.get([STORAGE_KEYS.USERSCRIPTS_DISABLED]))[
          STORAGE_KEYS.USERSCRIPTS_DISABLED
        ],
      );
      if (!disabled) {
        if (rec.persist && isJavaScriptRecord(rec)) {
          await upsertRegisteredUserScript(toRegisteredUserScript(rec));
        }
        await applyRecordToMatchingTabs(rec);
      }
    } else {
      if (isJavaScriptRecord(rec)) {
        await unregisterUserScripts([rec.id]).catch(() => undefined);
      }
      await cleanupRecordFromAllTabs(rec);
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }], isError: false };
  }

  private async update(args: UpdateArgs): Promise<ToolResult> {
    const { id, ...rest } = args;
    if (!id) return createErrorResponse('id is required');
    const all = await loadAllRecords();
    const rec = all[id];
    if (!rec) return createErrorResponse('userscript not found');
    const previousRecord = structuredClone(rec);

    if (rest.name !== undefined) rec.name = rest.name;
    if (rest.description !== undefined) rec.description = rest.description;
    if (rest.matches) rec.matches = rest.matches;
    if (rest.excludes) rec.excludes = rest.excludes;
    if (rest.runAt && rest.runAt !== 'auto') rec.runAt = rest.runAt;
    if (rest.world && rest.world !== 'auto') rec.world = rest.world as any;
    if (typeof rest.allFrames === 'boolean') rec.allFrames = rest.allFrames;
    if (typeof rest.persist === 'boolean') rec.persist = rest.persist;
    if (typeof rest.dnrFallback === 'boolean') rec.dnrFallback = rest.dnrFallback;
    if (rest.tags) rec.tags = rest.tags;
    if (typeof rest.script === 'string') rec.script = rest.script;
    rec.updatedAt = now();
    validateUserscriptRecord(rec);
    if (isJavaScriptRecord(previousRecord)) {
      await unregisterUserScripts([previousRecord.id]).catch(() => undefined);
    }
    await cleanupRecordFromAllTabs(previousRecord);
    await saveAllRecords(all);
    const disabled = Boolean(
      (await chrome.storage.local.get([STORAGE_KEYS.USERSCRIPTS_DISABLED]))[
        STORAGE_KEYS.USERSCRIPTS_DISABLED
      ],
    );
    if (rec.enabled && !disabled) {
      if (rec.persist && isJavaScriptRecord(rec)) {
        await upsertRegisteredUserScript(toRegisteredUserScript(rec));
      }
      await applyRecordToMatchingTabs(rec);
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }], isError: false };
  }

  private async remove(args: any): Promise<ToolResult> {
    const { id } = args || {};
    if (!id) return createErrorResponse('id is required');
    const all = await loadAllRecords();
    const rec = all[id];
    if (!rec) return createErrorResponse('userscript not found');
    delete all[id];
    await saveAllRecords(all);
    if (isJavaScriptRecord(rec)) {
      await unregisterUserScripts([rec.id]).catch(() => undefined);
    }
    await cleanupRecordFromAllTabs(rec);

    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }], isError: false };
  }

  private async sendCommand(args: any): Promise<ToolResult> {
    const { id, payload, tabId, windowId } = args || {};
    if (!id) return createErrorResponse('id is required');
    const tab = await this.resolveTargetTab({ tabId, windowId });
    if (!tab || !tab.id) {
      if (typeof tabId === 'number') {
        return createErrorResponse(`Tab not found: ${tabId}`);
      }
      return createErrorResponse('No active tab found');
    }

    const all = await loadAllRecords();
    const rec = all[id];
    if (!rec) return createErrorResponse('userscript not found');

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        files: ['inject-scripts/inject-bridge.js'],
        world: ExecutionWorld.ISOLATED,
      });
      const result = await chrome.tabs.sendMessage(
        tab.id,
        {
          action: 'userscript:command',
          payload,
          scriptId: id,
          targetWorld: rec.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT',
        },
        { frameId: 0 },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }],
        isError: false,
      };
    } catch (e) {
      return createErrorResponse(
        `send_command failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async exportAll(): Promise<ToolResult> {
    const all = await loadAllRecords();
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: all }) }],
      isError: false,
    };
  }
}

export const userscriptTool = new UserscriptTool();
