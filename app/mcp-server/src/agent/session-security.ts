import {
  CLAUDE_PERMISSION_MODES,
  CODEX_REASONING_EFFORTS,
  CODEX_SANDBOX_MODES,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  DEFAULT_CODEX_CONFIG,
  isClaudePermissionMode,
  isCodexReasoningEffort,
  isCodexSandboxMode,
  type ClaudePermissionMode,
} from 'webpage-mcp-shared';
import type { EngineName } from './engines/types';

const BOOLEAN_CODEX_CONFIG_FIELDS = [
  'includeApplyPatchTool',
  'includePlanTool',
  'enableWebSearch',
  'useStreamableShell',
  'appendProjectContext',
  'dangerouslyAllowFullAccess',
] as const;

const POSITIVE_INTEGER_CODEX_CONFIG_FIELDS = ['maxTurns', 'maxThinkingTokens'] as const;

interface SessionSecurityInput {
  permissionMode?: unknown;
  allowDangerouslySkipPermissions?: unknown;
  optionsConfig?: unknown;
}

interface ExistingSessionSecurityConfig {
  permissionMode: string;
  allowDangerouslySkipPermissions: boolean;
}

export interface SessionSecurityValidationOptions {
  engineName: EngineName;
  input: SessionSecurityInput;
  existing?: ExistingSessionSecurityConfig;
  update?: boolean;
}

export interface ResolvedClaudePermissionSettings {
  permissionMode: ClaudePermissionMode;
  allowDangerouslySkipPermissions: boolean;
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateCodexConfig(codexConfig: unknown): string | undefined {
  if (!isRecord(codexConfig)) {
    return 'optionsConfig.codexConfig must be an object';
  }

  for (const field of BOOLEAN_CODEX_CONFIG_FIELDS) {
    if (
      hasOwn(codexConfig, field) &&
      codexConfig[field] !== undefined &&
      typeof codexConfig[field] !== 'boolean'
    ) {
      return `optionsConfig.codexConfig.${field} must be a boolean`;
    }
  }

  for (const field of POSITIVE_INTEGER_CODEX_CONFIG_FIELDS) {
    const value = codexConfig[field];
    if (
      hasOwn(codexConfig, field) &&
      value !== undefined &&
      (!Number.isInteger(value) || (value as number) <= 0)
    ) {
      return `optionsConfig.codexConfig.${field} must be a positive integer`;
    }
  }

  if (
    hasOwn(codexConfig, 'sandboxMode') &&
    codexConfig.sandboxMode !== undefined &&
    !isCodexSandboxMode(codexConfig.sandboxMode)
  ) {
    return `optionsConfig.codexConfig.sandboxMode must be one of: ${CODEX_SANDBOX_MODES.join(', ')}`;
  }

  if (
    hasOwn(codexConfig, 'reasoningEffort') &&
    codexConfig.reasoningEffort !== undefined &&
    !isCodexReasoningEffort(codexConfig.reasoningEffort)
  ) {
    return `optionsConfig.codexConfig.reasoningEffort must be one of: ${CODEX_REASONING_EFFORTS.join(', ')}`;
  }

  if (
    hasOwn(codexConfig, 'autoInstructions') &&
    codexConfig.autoInstructions !== undefined &&
    typeof codexConfig.autoInstructions !== 'string'
  ) {
    return 'optionsConfig.codexConfig.autoInstructions must be a string';
  }

  const sandboxMode = codexConfig.sandboxMode ?? DEFAULT_CODEX_CONFIG.sandboxMode;
  const dangerousAcknowledgement = codexConfig.dangerouslyAllowFullAccess === true;
  if (sandboxMode === 'danger-full-access' && !dangerousAcknowledgement) {
    return (
      'optionsConfig.codexConfig.dangerouslyAllowFullAccess must be true ' +
      'when sandboxMode is "danger-full-access"'
    );
  }
  if (sandboxMode !== 'danger-full-access' && dangerousAcknowledgement) {
    return (
      'optionsConfig.codexConfig.dangerouslyAllowFullAccess may only be true ' +
      'when sandboxMode is "danger-full-access"'
    );
  }

  return undefined;
}

function readCodexConfig(
  optionsConfig: unknown,
  update: boolean,
): { present: boolean; value?: unknown; error?: string } {
  if (optionsConfig === undefined || (update && optionsConfig === null)) {
    return { present: false };
  }
  if (!isRecord(optionsConfig)) {
    return {
      present: false,
      error: update
        ? 'optionsConfig must be an object or null'
        : 'optionsConfig must be an object',
    };
  }
  if (!hasOwn(optionsConfig, 'codexConfig') || optionsConfig.codexConfig === undefined) {
    return { present: false };
  }
  return { present: true, value: optionsConfig.codexConfig };
}

/**
 * Resolve Claude SDK permission settings without silently escalating them.
 * Persisted legacy values are rejected instead of being converted to a more
 * permissive mode at execution time.
 */
export function resolveClaudePermissionSettings(
  permissionMode: unknown,
  allowDangerouslySkipPermissions: unknown,
): ResolvedClaudePermissionSettings {
  const normalizedMode =
    typeof permissionMode === 'string' ? permissionMode.trim() : permissionMode;
  const resolvedPermissionMode =
    normalizedMode === undefined || normalizedMode === null || normalizedMode === ''
      ? DEFAULT_CLAUDE_PERMISSION_MODE
      : normalizedMode;

  if (!isClaudePermissionMode(resolvedPermissionMode)) {
    throw new Error(
      `Invalid Claude permissionMode. Must be one of: ${CLAUDE_PERMISSION_MODES.join(', ')}`,
    );
  }

  if (
    allowDangerouslySkipPermissions !== undefined &&
    allowDangerouslySkipPermissions !== null &&
    typeof allowDangerouslySkipPermissions !== 'boolean'
  ) {
    throw new Error('allowDangerouslySkipPermissions must be a boolean');
  }

  const resolvedDangerousAcknowledgement = allowDangerouslySkipPermissions === true;
  if (resolvedPermissionMode === 'bypassPermissions' && !resolvedDangerousAcknowledgement) {
    throw new Error(
      'permissionMode "bypassPermissions" requires explicit allowDangerouslySkipPermissions=true',
    );
  }
  if (resolvedPermissionMode !== 'bypassPermissions' && resolvedDangerousAcknowledgement) {
    throw new Error(
      'allowDangerouslySkipPermissions=true is only valid with permissionMode "bypassPermissions"',
    );
  }

  return {
    permissionMode: resolvedPermissionMode,
    allowDangerouslySkipPermissions: resolvedDangerousAcknowledgement,
  };
}

/** Validate the security-sensitive portion of public session create/update RPCs. */
export function validateSessionSecurityConfig({
  engineName,
  input,
  existing,
  update = false,
}: SessionSecurityValidationOptions): string | undefined {
  const hasPermissionMode = hasOwn(input, 'permissionMode') && input.permissionMode !== undefined;
  const hasDangerousAcknowledgement =
    hasOwn(input, 'allowDangerouslySkipPermissions') &&
    input.allowDangerouslySkipPermissions !== undefined;

  if (engineName === 'codex') {
    if (hasPermissionMode) {
      const normalizedMode =
        typeof input.permissionMode === 'string'
          ? input.permissionMode.trim()
          : input.permissionMode;
      if (normalizedMode !== 'default') {
        return 'permissionMode must be "default" for codex sessions';
      }
    }
    if (hasDangerousAcknowledgement) {
      const acknowledgement = input.allowDangerouslySkipPermissions;
      if (acknowledgement !== false && !(update && acknowledgement === null)) {
        return 'allowDangerouslySkipPermissions must be false for codex sessions';
      }
    }
  } else {
    if (hasPermissionMode) {
      const value = input.permissionMode;
      if (value === null && !update) {
        return `permissionMode must be one of: ${CLAUDE_PERMISSION_MODES.join(', ')}`;
      }
      const normalized = typeof value === 'string' ? value.trim() : value;
      if (normalized !== null && !isClaudePermissionMode(normalized)) {
        return `permissionMode must be one of: ${CLAUDE_PERMISSION_MODES.join(', ')}`;
      }
    }

    if (hasDangerousAcknowledgement) {
      const value = input.allowDangerouslySkipPermissions;
      if (typeof value !== 'boolean' && !(update && value === null)) {
        return update
          ? 'allowDangerouslySkipPermissions must be a boolean or null'
          : 'allowDangerouslySkipPermissions must be a boolean';
      }
    }
  }

  const codexConfig = readCodexConfig(input.optionsConfig, update);
  if (codexConfig.error) {
    return codexConfig.error;
  }
  if (codexConfig.present && engineName !== 'codex') {
    return 'optionsConfig.codexConfig is only supported for codex sessions';
  }
  if (codexConfig.present) {
    const configError = validateCodexConfig(codexConfig.value);
    if (configError) return configError;
  }

  if (engineName !== 'claude') {
    return undefined;
  }

  const rawMode = hasPermissionMode
    ? input.permissionMode === null
      ? DEFAULT_CLAUDE_PERMISSION_MODE
      : input.permissionMode
    : existing?.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE;
  const normalizedMode = typeof rawMode === 'string' ? rawMode.trim() : rawMode;

  if (!isClaudePermissionMode(normalizedMode)) {
    if (hasPermissionMode || hasDangerousAcknowledgement) {
      return `permissionMode must be one of: ${CLAUDE_PERMISSION_MODES.join(', ')}`;
    }
    return undefined;
  }

  if (
    hasPermissionMode &&
    normalizedMode === 'bypassPermissions' &&
    input.allowDangerouslySkipPermissions !== true
  ) {
    return 'permissionMode "bypassPermissions" requires explicit allowDangerouslySkipPermissions=true';
  }

  const resolvedDangerousAcknowledgement = hasDangerousAcknowledgement
    ? input.allowDangerouslySkipPermissions === true
    : existing?.allowDangerouslySkipPermissions ?? false;

  if (normalizedMode === 'bypassPermissions' && !resolvedDangerousAcknowledgement) {
    return 'permissionMode "bypassPermissions" requires explicit allowDangerouslySkipPermissions=true';
  }
  if (normalizedMode !== 'bypassPermissions' && resolvedDangerousAcknowledgement) {
    return 'allowDangerouslySkipPermissions=true is only valid with permissionMode "bypassPermissions"';
  }

  return undefined;
}
