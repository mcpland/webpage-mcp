/**
 * Quick Panel Core Types
 *
 * Shared contracts for the Quick Panel search and UI layers.
 * Framework-agnostic and safe to import from both UI and core modules.
 */

// ============================================================
// Scope Types
// ============================================================

/**
 * Available search scopes in Quick Panel
 */
export type QuickPanelScope = 'all' | 'tabs' | 'bookmarks' | 'history' | 'content' | 'commands';

/**
 * Scope definition with display properties
 */
export interface QuickPanelScopeDefinition {
  id: QuickPanelScope;
  label: string;
  icon: string;
  /**
   * Scope prefix for search input recognition.
   * - Space-terminated prefixes: "t ", "b ", "h ", "c "
   * - Command mode prefix: ">"
   * - null for 'all' scope (no prefix)
   */
  prefix: string | null;
}

/** Default scope when no prefix is detected */
export const DEFAULT_SCOPE: QuickPanelScope = 'all';

/** Scope definitions following PRD spec */
export const QUICK_PANEL_SCOPES: Readonly<Record<QuickPanelScope, QuickPanelScopeDefinition>> = {
  all: { id: 'all', label: 'All', icon: '\u2318', prefix: null },
  tabs: { id: 'tabs', label: 'Tabs', icon: '\uD83D\uDDC2\uFE0F', prefix: 't ' },
  bookmarks: { id: 'bookmarks', label: 'Bookmarks', icon: '\u2B50', prefix: 'b ' },
  history: { id: 'history', label: 'History', icon: '\uD83D\uDD50', prefix: 'h ' },
  content: { id: 'content', label: 'Content', icon: '\uD83D\uDCC4', prefix: 'c ' },
  commands: { id: 'commands', label: 'Commands', icon: '>', prefix: '>' },
} as const;

/**
 * Type guard for QuickPanelScope
 */
export function isQuickPanelScope(value: unknown): value is QuickPanelScope {
  return typeof value === 'string' && value in QUICK_PANEL_SCOPES;
}

/**
 * Normalize a value to a valid QuickPanelScope
 */
export function normalizeQuickPanelScope(
  value: unknown,
  fallback: QuickPanelScope = DEFAULT_SCOPE,
): QuickPanelScope {
  return isQuickPanelScope(value) ? value : fallback;
}

// ============================================================
// Scope Prefix Parsing
// ============================================================

/**
 * Result of parsing a scope-prefixed query string
 */
export interface ParsedScopeQuery {
  /** Original input string */
  raw: string;
  /** Detected or default scope */
  scope: QuickPanelScope;
  /** Query string with prefix removed */
  query: string;
  /** Whether a scope prefix was recognized and consumed */
  consumedPrefix: boolean;
}

/**
 * Parse a scope-prefixed input string following PRD conventions:
 * - `>foo` -> scope=commands, query="foo"
 * - `t foo` -> scope=tabs, query="foo"
 * - `b foo` -> scope=bookmarks, query="foo"
 * - `h foo` -> scope=history, query="foo"
 * - `c foo` -> scope=content, query="foo"
 *
 * Only checks the beginning of the string (after trimming leading whitespace).
 */
export function parseScopePrefixedQuery(
  rawInput: string,
  defaultScope: QuickPanelScope = DEFAULT_SCOPE,
): ParsedScopeQuery {
  const raw = typeof rawInput === 'string' ? rawInput : '';
  const leadingTrimmed = raw.replace(/^\s+/, '');

  // Check for command mode prefix (>)
  if (leadingTrimmed.startsWith('>')) {
    return {
      raw,
      scope: 'commands',
      query: leadingTrimmed.slice(1).trimStart(),
      consumedPrefix: true,
    };
  }

  // Check for space-terminated scope prefixes (t, b, h, c)
  const match = leadingTrimmed.match(/^([tbhc])\s+(.*)$/s);
  if (match) {
    const prefix = match[1];
    const rest = (match[2] ?? '').trimStart();

    const scopeMap: Record<string, QuickPanelScope> = {
      t: 'tabs',
      b: 'bookmarks',
      h: 'history',
      c: 'content',
    };

    const scope = scopeMap[prefix] ?? defaultScope;

    return { raw, scope, query: rest, consumedPrefix: true };
  }

  // No prefix detected
  return { raw, scope: defaultScope, query: raw.trim(), consumedPrefix: false };
}

// ============================================================
// Search Results
// ============================================================

/**
 * Icon type - can be an emoji string or a DOM node
 */
export type QuickPanelIcon = string | Node;

/**
 * Search result from a provider
 */
export interface SearchResult<TData = unknown> {
  /** Unique identifier within the provider */
  id: string;
  /** Provider that generated this result */
  provider: string;
  /** Display title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Icon (emoji or DOM node) */
  icon?: QuickPanelIcon;
  /** Provider-specific data */
  data: TData;
  /** Relevance score (higher is better) */
  score: number;
}

// ============================================================
// Actions
// ============================================================

/**
 * Visual tone for actions
 */
export type ActionTone = 'default' | 'danger';

/**
 * Context passed to action execution
 */
export interface ActionContext<TData = unknown> {
  /** The search result being acted upon */
  result: SearchResult<TData>;
  /**
   * Optional open mode hint for navigation actions.
   * Providers can ignore if not applicable.
   */
  openMode?: 'current_tab' | 'new_tab' | 'background_tab';
}

/**
 * An action that can be performed on a search result
 */
export interface Action<TData = unknown> {
  /** Unique identifier */
  id: string;
  /** Display title */
  title: string;
  /** Optional subtitle */
  subtitle?: string;
  /** Icon */
  icon?: QuickPanelIcon;
  /** Visual tone */
  tone?: ActionTone;
  /**
   * Hotkey hint for UI display (e.g., "Enter", "Cmd+Enter").
   * Controller remains source of truth for actual keybindings.
   */
  hotkeyHint?: string;
  /** Check if action is available for given context */
  isAvailable?: (ctx: ActionContext<TData>) => boolean;
  /** Execute the action */
  execute: (ctx: ActionContext<TData>) => void | Promise<void>;
}

// ============================================================
// Search Query
// ============================================================

/**
 * Normalized search query passed to providers.
 */
export interface SearchQuery {
  /** Original, unmodified query string */
  raw: string;
  /**
   * Normalized query used for matching/caching:
   * - trimmed
   * - collapsed whitespace
   * - lowercased
   */
  text: string;
  /** Tokenized representation of `text` */
  tokens: string[];
}

/**
 * Normalize a raw query string to SearchQuery format.
 */
export function normalizeSearchQuery(raw: string): SearchQuery {
  const input = typeof raw === 'string' ? raw : '';
  const trimmed = input.trim();
  const text = trimmed.replace(/\s+/g, ' ').toLowerCase();
  const tokens = text ? text.split(' ').filter(Boolean) : [];
  return { raw: input, text, tokens };
}

// ============================================================
// Providers
// ============================================================

/**
 * Context passed to provider.search method.
 */
export interface SearchProviderContext {
  /** The scope selected by the user (may be 'all'). */
  requestedScope: QuickPanelScope;
  /** Normalized query info */
  query: SearchQuery;
  /** Max results requested for this provider */
  limit: number;
  /** Abort signal for cancellation */
  signal: AbortSignal;
  /** Timestamp (ms) for consistent scoring */
  now: number;
}

/**
 * Search provider interface.
 *
 * Providers are responsible for:
 * - Searching a specific data source
 * - Ranking results with a score
 * - Providing actions for results
 */
export interface SearchProvider<TData = unknown> {
  /** Unique provider identifier */
  id: string;
  /** Display name */
  name: string;
  /** Provider icon */
  icon: string;

  /**
   * Scopes this provider can handle.
   *
   * Note: 'all' is a meta-scope and should not usually be listed here.
   * The SearchEngine will include providers in 'all' based on includeInAll.
   */
  scopes: readonly QuickPanelScope[];

  /**
   * Whether this provider participates in the 'all' meta-scope.
   * Default: true
   */
  includeInAll?: boolean;

  /**
   * Provider priority used as a tie-breaker when scores are equal (higher wins).
   * Default: 0
   */
  priority?: number;

  /**
   * Provider-level hard cap for returned items (optional).
   * The SearchEngine may apply additional caps.
   */
  maxResults?: number;

  /**
   * Whether the provider wants to run for empty queries.
   * Default: false
   */
  supportsEmptyQuery?: boolean;

  /**
   * Search for results matching the query.
   *
   * @param ctx - Search context with query, limit, signal, etc.
   * @returns Promise of search results
   */
  search: (ctx: SearchProviderContext) => Promise<SearchResult<TData>[]>;

  /**
   * Get available actions for a result.
   *
   * @param item - The search result to get actions for
   * @returns Array of available actions
   */
  getActions: (item: SearchResult<TData>) => Action<TData>[];

  /**
   * Optional cleanup hook for releasing resources.
   * Called when provider is unregistered or engine is disposed.
   */
  dispose?: () => void;
}

// ============================================================
// Panel View Types
// ============================================================

/**
 * Available views in Quick Panel
 */
export type QuickPanelView = 'search' | 'chat';

/**
 * Panel state
 */
export interface QuickPanelState {
  view: QuickPanelView;
  scope: QuickPanelScope;
  query: string;
  results: SearchResult[];
  selectedIndex: number;
  isLoading: boolean;
  errorMessage: string | null;
}
