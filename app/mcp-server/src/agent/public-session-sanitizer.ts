import type { AgentSession, ManagementInfo, SessionOptionsConfig } from './session-service';

const SENSITIVE_CONFIG_KEYS = new Set([
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'env',
  'environment',
  'header',
  'headers',
  'password',
  'privatekey',
  'secret',
  'token',
]);
const PUBLIC_OPTION_KEYS = [
  'settingSources',
  'allowedTools',
  'disallowedTools',
  'tools',
  'betas',
  'maxThinkingTokens',
  'maxTurns',
  'maxBudgetUsd',
  'enableFileCheckpointing',
] as const;

function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    SENSITIVE_CONFIG_KEYS.has(normalized) ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('password') ||
    normalized.endsWith('privatekey') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('token')
  );
}

function sanitizeNestedConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeNestedConfig);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (!isSensitiveConfigKey(key)) {
      sanitized[key] = sanitizeNestedConfig(nestedValue);
    }
  }
  return sanitized;
}

function sanitizeOptionsConfigForPublicRead(
  optionsConfig?: SessionOptionsConfig,
): SessionOptionsConfig | undefined {
  if (!optionsConfig) {
    return undefined;
  }

  const raw = optionsConfig as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const key of PUBLIC_OPTION_KEYS) {
    if (raw[key] !== undefined) {
      sanitized[key] = sanitizeNestedConfig(raw[key]);
    }
  }

  // mcpServers/env/sandbox/outputFormat are deliberately omitted because they
  // accept arbitrary nested values, command arguments, paths, and credentials.
  // Codex settings are known scalars, but custom autoInstructions can contain
  // private prompt material and must not be exposed.
  if (raw.codexConfig && typeof raw.codexConfig === 'object' && !Array.isArray(raw.codexConfig)) {
    const { autoInstructions: _autoInstructions, ...codexConfig } = raw.codexConfig as Record<
      string,
      unknown
    >;
    const safeCodexConfig = sanitizeNestedConfig(codexConfig) as Record<string, unknown>;
    if (Object.keys(safeCodexConfig).length > 0) {
      sanitized.codexConfig = safeCodexConfig;
    }
  }

  return Object.keys(sanitized).length > 0 ? (sanitized as SessionOptionsConfig) : undefined;
}

export function sanitizeManagementInfoForPublicRead(
  managementInfo?: ManagementInfo | null,
): ManagementInfo | null | undefined {
  if (managementInfo === null) {
    return null;
  }
  if (!managementInfo) {
    return undefined;
  }

  const { cwd: _cwd, plugins, ...rest } = managementInfo;
  const sanitizedPlugins = plugins?.map((plugin) => ({ name: plugin.name }));

  const sanitized: ManagementInfo = {
    ...rest,
    ...(sanitizedPlugins ? { plugins: sanitizedPlugins } : {}),
  };

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function sanitizeSessionForPublicRead(session: AgentSession): AgentSession {
  return {
    ...session,
    engineSessionId: undefined,
    optionsConfig: sanitizeOptionsConfigForPublicRead(session.optionsConfig),
    managementInfo: sanitizeManagementInfoForPublicRead(session.managementInfo) ?? undefined,
  };
}
