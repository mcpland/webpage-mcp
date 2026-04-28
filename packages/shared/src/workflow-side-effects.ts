export type WorkflowSideEffectCategory = 'safe' | 'idempotent' | 'dangerous';

export type WorkflowRetryMode = 'default' | 'explicit' | 'never' | 'always';

export type WorkflowRetrySource = 'flowDefault' | 'pluginDefault' | 'node';

export interface WorkflowSideEffectProfile {
  category: WorkflowSideEffectCategory;
  retry?: WorkflowRetryMode;
  description?: string;
}

export interface WorkflowSideEffectSummary {
  safe: number;
  idempotent: number;
  dangerous: number;
  unknown: number;
}

const SAFE_QUERY_NODE_KINDS = new Set([
  'assert',
  'delay',
  'extract',
  'if',
  'screenshot',
  'switchFrame',
  'wait',
]);

const IDEMPOTENT_NODE_KINDS = new Set([
  'fill',
  'navigate',
  'openTab',
  'scroll',
  'setAttribute',
  'switchTab',
]);

const DANGEROUS_NODE_KINDS = new Set([
  'click',
  'closeTab',
  'dblclick',
  'drag',
  'executeFlow',
  'foreach',
  'handleDownload',
  'http',
  'key',
  'loopElements',
  'script',
  'triggerEvent',
  'while',
]);

function defaultRetryMode(category: WorkflowSideEffectCategory): WorkflowRetryMode {
  if (category === 'safe') return 'default';
  return 'explicit';
}

function defaultDescriptionForCategory(category: WorkflowSideEffectCategory): string {
  if (category === 'safe') {
    return 'Read-only, waiting, assertion, or diagnostic step.';
  }
  if (category === 'idempotent') {
    return 'Mutates local browser/page state but is usually repeatable when explicitly configured.';
  }
  return 'May trigger external, irreversible, or repeated side effects; retry requires explicit opt-in.';
}

function normalizeCategory(value: unknown): WorkflowSideEffectCategory | undefined {
  return value === 'safe' || value === 'idempotent' || value === 'dangerous'
    ? value
    : undefined;
}

function normalizeRetryMode(value: unknown): WorkflowRetryMode | undefined {
  return value === 'default' || value === 'explicit' || value === 'never' || value === 'always'
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isJsExtractConfig(config: unknown): boolean {
  if (!isRecord(config)) {
    return false;
  }
  const mode = typeof config.mode === 'string' ? config.mode.trim().toLowerCase() : '';
  if (mode === 'js') {
    return true;
  }
  if (mode === 'selector') {
    return false;
  }
  const code = config.code ?? config.js ?? config.script ?? config.jsScript;
  return typeof code === 'string' && code.trim().length > 0;
}

export function getDefaultWorkflowSideEffectProfile(kind: string): WorkflowSideEffectProfile {
  if (SAFE_QUERY_NODE_KINDS.has(kind)) {
    return {
      category: 'safe',
      retry: 'default',
      description: 'Read-only, waiting, assertion, or diagnostic step.',
    };
  }
  if (IDEMPOTENT_NODE_KINDS.has(kind)) {
    return {
      category: 'idempotent',
      retry: 'explicit',
      description: 'Mutates local browser/page state but is usually repeatable when explicitly configured.',
    };
  }
  if (DANGEROUS_NODE_KINDS.has(kind)) {
    return {
      category: 'dangerous',
      retry: 'explicit',
      description: 'May trigger external, irreversible, or repeated side effects; retry requires explicit opt-in.',
    };
  }
  return {
    category: 'dangerous',
    retry: 'explicit',
    description: 'Unknown node kind; treat as dangerous until classified.',
  };
}

export function getDefaultWorkflowNodeSideEffectProfile(
  kind: string,
  config?: unknown,
): WorkflowSideEffectProfile {
  if (kind === 'extract' && isJsExtractConfig(config)) {
    return {
      category: 'dangerous',
      retry: 'explicit',
      description: 'Executes custom JavaScript in the page; retry requires explicit opt-in.',
    };
  }
  return getDefaultWorkflowSideEffectProfile(kind);
}

export function isKnownWorkflowSideEffectKind(kind: string): boolean {
  return (
    SAFE_QUERY_NODE_KINDS.has(kind) ||
    IDEMPOTENT_NODE_KINDS.has(kind) ||
    DANGEROUS_NODE_KINDS.has(kind)
  );
}

function normalizeWorkflowSideEffectProfileFromBase(
  base: WorkflowSideEffectProfile,
  override?: Partial<WorkflowSideEffectProfile>,
): WorkflowSideEffectProfile {
  const overrideCategory = normalizeCategory(override?.category);
  const category = overrideCategory ?? base.category;
  const retry =
    normalizeRetryMode(override?.retry) ??
    (overrideCategory ? defaultRetryMode(category) : base.retry ?? defaultRetryMode(category));
  const fallbackDescription =
    overrideCategory && overrideCategory !== base.category
      ? defaultDescriptionForCategory(category)
      : base.description;
  const description =
    typeof override?.description === 'string' && override.description.trim()
      ? override.description.trim()
      : fallbackDescription;
  return {
    category,
    retry,
    ...(description ? { description } : {}),
  };
}

export function normalizeWorkflowSideEffectProfile(
  kind: string,
  override?: Partial<WorkflowSideEffectProfile>,
): WorkflowSideEffectProfile {
  return normalizeWorkflowSideEffectProfileFromBase(
    getDefaultWorkflowSideEffectProfile(kind),
    override,
  );
}

export function normalizeWorkflowNodeSideEffectProfile(
  kind: string,
  config?: unknown,
  override?: Partial<WorkflowSideEffectProfile>,
): WorkflowSideEffectProfile {
  return normalizeWorkflowSideEffectProfileFromBase(
    getDefaultWorkflowNodeSideEffectProfile(kind, config),
    override,
  );
}

export function workflowSideEffectAllowsRetry(
  profile: WorkflowSideEffectProfile,
  source: WorkflowRetrySource,
): boolean {
  const retry = profile.retry ?? defaultRetryMode(profile.category);
  if (retry === 'always') return true;
  if (retry === 'never') return false;
  if (retry === 'explicit') return source === 'node';
  return profile.category === 'safe';
}

export function createEmptyWorkflowSideEffectSummary(): WorkflowSideEffectSummary {
  return { safe: 0, idempotent: 0, dangerous: 0, unknown: 0 };
}
