import { TOOL_NAMES } from 'webpage-mcp-shared';

/**
 * Tool profiles: which tools a client sees and may call.
 *
 * Every listed tool costs the client context on each request (all schemas
 * together are ~70KB), and most sessions only browse. WEBPAGE_MCP_TOOLSET
 * narrows the list, e.g. `core`, `browser`, `core,chrome_console` or
 * `all,-workflow`. It is read by the process the MCP client starts (stdio or
 * remote gateway), because the native host is started by Chrome and never
 * sees the client's environment.
 */
export const TOOLSET_ENV = 'WEBPAGE_MCP_TOOLSET';

const WORKFLOW_RUN_TOOL_NAME = 'workflow_run';

const BROWSER_TOOL_NAMES: readonly string[] = Object.values(TOOL_NAMES.BROWSER);
const WORKFLOW_TOOL_NAMES: readonly string[] = [
  ...Object.values(TOOL_NAMES.RECORD_REPLAY),
  WORKFLOW_RUN_TOOL_NAME,
];

/** Everyday browsing: open, read, act on and inspect pages. */
const CORE_TOOL_NAMES: readonly string[] = [
  TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
  TOOL_NAMES.BROWSER.NAVIGATE,
  TOOL_NAMES.BROWSER.SWITCH_TAB,
  TOOL_NAMES.BROWSER.CLOSE_TABS,
  TOOL_NAMES.BROWSER.READ_PAGE,
  TOOL_NAMES.BROWSER.WEB_FETCHER,
  TOOL_NAMES.BROWSER.SCREENSHOT,
  TOOL_NAMES.BROWSER.COMPUTER,
  TOOL_NAMES.BROWSER.CLICK,
  TOOL_NAMES.BROWSER.FILL,
  TOOL_NAMES.BROWSER.KEYBOARD,
  TOOL_NAMES.BROWSER.HANDLE_DIALOG,
  TOOL_NAMES.BROWSER.JAVASCRIPT,
];

export const TOOLSET_PROFILES: Readonly<Record<string, readonly string[]>> = {
  core: CORE_TOOL_NAMES,
  browser: BROWSER_TOOL_NAMES,
  workflow: WORKFLOW_TOOL_NAMES,
};

const KNOWN_TOOL_NAMES = new Set([...BROWSER_TOOL_NAMES, ...WORKFLOW_TOOL_NAMES]);

export interface Toolset {
  /** The setting as given; undefined when every tool is enabled. */
  readonly spec?: string;
  readonly warnings: readonly string[];
  allows(toolName: string): boolean;
}

const ALL_TOOLS: Toolset = { warnings: [], allows: () => true };

/**
 * Parse a comma-separated list of profiles (all, core, browser, workflow) and
 * tool names. Entries prefixed with "-" remove tools and win over additions;
 * a list of removals only starts from all tools.
 */
export function parseToolset(spec: string | undefined): Toolset {
  const trimmed = spec?.trim();
  if (!trimmed || trimmed === 'all') return ALL_TOOLS;

  const entries = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  let includeAll = entries.every((entry) => entry.startsWith('-'));
  const added = new Set<string>();
  const removed = new Set<string>();
  const warnings: string[] = [];

  for (const entry of entries) {
    const remove = entry.startsWith('-');
    const name = remove ? entry.slice(1).trim() : entry;
    if (name === 'all') {
      if (remove) warnings.push('"-all" is not supported and was ignored');
      else includeAll = true;
      continue;
    }
    const names = TOOLSET_PROFILES[name] ?? (KNOWN_TOOL_NAMES.has(name) ? [name] : undefined);
    if (!names) {
      warnings.push(
        `unknown entry "${name}" ignored (profiles: all, ${Object.keys(TOOLSET_PROFILES).join(', ')}; or a tool name)`,
      );
      continue;
    }
    for (const toolName of names) (remove ? removed : added).add(toolName);
  }

  return {
    spec: trimmed,
    warnings,
    allows(toolName) {
      // Legacy per-workflow `flow.<slug>` tools follow workflow_run.
      const name = toolName.startsWith('flow.') ? WORKFLOW_RUN_TOOL_NAME : toolName;
      if (removed.has(name)) return false;
      return includeAll || added.has(name);
    },
  };
}

let envToolset: { spec: string | undefined; toolset: Toolset } | undefined;

/** The toolset from WEBPAGE_MCP_TOOLSET, warning once about entries it ignored. */
export function getEnvToolset(): Toolset {
  const spec = process.env[TOOLSET_ENV];
  if (envToolset && envToolset.spec === spec) return envToolset.toolset;
  const toolset = parseToolset(spec);
  for (const warning of toolset.warnings) console.warn(`[${TOOLSET_ENV}] ${warning}`);
  envToolset = { spec, toolset };
  return toolset;
}
