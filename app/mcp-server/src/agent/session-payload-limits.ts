import {
  AGENT_CLI_SOURCE_MAX_BYTES,
  AGENT_CODEX_AUTO_INSTRUCTIONS_MAX_BYTES,
  AGENT_IDENTIFIER_MAX_BYTES,
  AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES,
  AGENT_MODEL_MAX_BYTES,
  AGENT_SESSION_CONFIG_MAX_JSON_BYTES,
  AGENT_SESSION_NAME_MAX_BYTES,
  AGENT_SESSION_OPTION_STRING_MAX_BYTES,
  AGENT_SESSION_OPTIONS_MAX_JSON_BYTES,
  AGENT_SYSTEM_PROMPT_CONFIG_MAX_JSON_BYTES,
  AGENT_SYSTEM_PROMPT_TEXT_MAX_BYTES,
} from 'webpage-mcp-shared';
import {
  AGENT_PAYLOAD_INVALID,
  AGENT_PAYLOAD_TOO_LARGE,
  AgentPayloadLimitError,
  assertJsonByteLimit,
  assertUtf8ByteLimit,
  getUtf8ByteLength,
} from './payload-limits';

const SESSION_OPTION_KEYS = new Set([
  'settingSources',
  'allowedTools',
  'disallowedTools',
  'tools',
  'betas',
  'maxThinkingTokens',
  'maxTurns',
  'maxBudgetUsd',
  'mcpServers',
  'outputFormat',
  'enableFileCheckpointing',
  'sandbox',
  'env',
  'codexConfig',
]);

const CODEX_CONFIG_KEYS = new Set([
  'includeApplyPatchTool',
  'includePlanTool',
  'enableWebSearch',
  'useStreamableShell',
  'sandboxMode',
  'dangerouslyAllowFullAccess',
  'maxTurns',
  'maxThinkingTokens',
  'reasoningEffort',
  'autoInstructions',
  'appendProjectContext',
]);

const BOOLEAN_CODEX_CONFIG_KEYS = new Set([
  'includeApplyPatchTool',
  'includePlanTool',
  'enableWebSearch',
  'useStreamableShell',
  'dangerouslyAllowFullAccess',
  'appendProjectContext',
]);

interface SessionCreatePayload {
  id?: unknown;
  engineSessionId?: unknown;
  name?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  allowDangerouslySkipPermissions?: unknown;
  systemPromptConfig?: unknown;
  optionsConfig?: unknown;
}

interface SessionUpdatePayload {
  engineSessionId?: unknown;
  name?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  allowDangerouslySkipPermissions?: unknown;
  systemPromptConfig?: unknown;
  optionsConfig?: unknown;
  managementInfo?: unknown;
}

function invalid(field: string): never {
  throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  field: string,
): void {
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    // Do not reflect an attacker-controlled key in the response.
    invalid(`${field}.keys`);
  }
}

function validateOptionalString(
  value: unknown,
  field: string,
  maximumBytes: number,
  allowNull: boolean,
): void {
  if (value === undefined || (allowNull && value === null)) return;
  if (typeof value !== 'string') invalid(field);
  assertUtf8ByteLimit(value, field, maximumBytes);
}

function validateStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value)) invalid(field);
  value.forEach((item, index) => {
    if (typeof item !== 'string') invalid(`${field}[${index}]`);
    assertUtf8ByteLimit(
      item,
      `${field}[${index}]`,
      AGENT_SESSION_OPTION_STRING_MAX_BYTES,
    );
  });
}

function validatePositiveNumber(
  value: unknown,
  field: string,
  integer: boolean,
): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  ) {
    invalid(field);
  }
}

function validateSystemPromptConfig(
  value: unknown,
  allowNull: boolean,
): number {
  if (value === undefined || (allowNull && value === null)) return 0;
  if (!isRecord(value)) invalid('systemPromptConfig');

  const serialized = assertJsonByteLimit(
    value,
    'systemPromptConfig',
    AGENT_SYSTEM_PROMPT_CONFIG_MAX_JSON_BYTES,
  );
  if (value.type === 'custom') {
    assertKnownKeys(value, new Set(['type', 'text']), 'systemPromptConfig');
    if (typeof value.text !== 'string') invalid('systemPromptConfig.text');
    assertUtf8ByteLimit(
      value.text,
      'systemPromptConfig.text',
      AGENT_SYSTEM_PROMPT_TEXT_MAX_BYTES,
    );
  } else if (value.type === 'preset') {
    assertKnownKeys(
      value,
      new Set(['type', 'preset', 'append']),
      'systemPromptConfig',
    );
    if (value.preset !== 'claude_code') invalid('systemPromptConfig.preset');
    validateOptionalString(
      value.append,
      'systemPromptConfig.append',
      AGENT_SYSTEM_PROMPT_TEXT_MAX_BYTES,
      false,
    );
  } else {
    invalid('systemPromptConfig.type');
  }
  return getUtf8ByteLength(serialized);
}

function validateCodexConfig(value: unknown): void {
  if (!isRecord(value)) invalid('optionsConfig.codexConfig');
  assertKnownKeys(value, CODEX_CONFIG_KEYS, 'optionsConfig.codexConfig');

  for (const key of Object.keys(value)) {
    const item = value[key];
    const field = `optionsConfig.codexConfig.${key}`;
    if (item === undefined) continue;
    if (BOOLEAN_CODEX_CONFIG_KEYS.has(key)) {
      if (typeof item !== 'boolean') invalid(field);
      continue;
    }
    if (key === 'maxTurns' || key === 'maxThinkingTokens') {
      validatePositiveNumber(item, field, true);
      continue;
    }
    if (key === 'autoInstructions') {
      if (typeof item !== 'string') invalid(field);
      assertUtf8ByteLimit(item, field, AGENT_CODEX_AUTO_INSTRUCTIONS_MAX_BYTES);
      continue;
    }
    if (typeof item !== 'string') invalid(field);
    assertUtf8ByteLimit(item, field, AGENT_SESSION_OPTION_STRING_MAX_BYTES);
  }
}

function validateEnvironment(value: unknown): void {
  if (!isRecord(value)) invalid('optionsConfig.env');
  for (const [key, item] of Object.entries(value)) {
    assertUtf8ByteLimit(
      key,
      'optionsConfig.env.key',
      AGENT_SESSION_OPTION_STRING_MAX_BYTES,
    );
    if (typeof item !== 'string') invalid('optionsConfig.env.value');
    assertUtf8ByteLimit(
      item,
      'optionsConfig.env.value',
      AGENT_SESSION_OPTION_STRING_MAX_BYTES,
    );
  }
}

function validateTools(value: unknown): void {
  if (Array.isArray(value)) {
    validateStringArray(value, 'optionsConfig.tools');
    return;
  }
  if (!isRecord(value)) invalid('optionsConfig.tools');
  assertKnownKeys(value, new Set(['type', 'preset']), 'optionsConfig.tools');
  if (value.type !== 'preset' || value.preset !== 'claude_code') {
    invalid('optionsConfig.tools');
  }
}

function validateOptionsConfig(value: unknown, allowNull: boolean): number {
  if (value === undefined || (allowNull && value === null)) return 0;
  if (!isRecord(value)) invalid('optionsConfig');

  const serialized = assertJsonByteLimit(
    value,
    'optionsConfig',
    AGENT_SESSION_OPTIONS_MAX_JSON_BYTES,
  );
  assertKnownKeys(value, SESSION_OPTION_KEYS, 'optionsConfig');

  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const field = `optionsConfig.${key}`;
    if (
      key === 'settingSources' ||
      key === 'allowedTools' ||
      key === 'disallowedTools' ||
      key === 'betas'
    ) {
      validateStringArray(item, field);
    } else if (key === 'tools') {
      validateTools(item);
    } else if (key === 'maxThinkingTokens' || key === 'maxTurns') {
      validatePositiveNumber(item, field, true);
    } else if (key === 'maxBudgetUsd') {
      validatePositiveNumber(item, field, false);
    } else if (key === 'enableFileCheckpointing') {
      if (typeof item !== 'boolean') invalid(field);
    } else if (key === 'env') {
      validateEnvironment(item);
    } else if (key === 'codexConfig') {
      validateCodexConfig(item);
    } else if (!isRecord(item)) {
      invalid(field);
    }
  }
  return getUtf8ByteLength(serialized);
}

function validateCombinedConfigBytes(
  systemPromptBytes: number,
  optionsBytes: number,
): void {
  const actualBytes = systemPromptBytes + optionsBytes;
  if (actualBytes > AGENT_SESSION_CONFIG_MAX_JSON_BYTES) {
    throw new AgentPayloadLimitError(
      AGENT_PAYLOAD_TOO_LARGE,
      'sessionConfig',
      actualBytes,
      AGENT_SESSION_CONFIG_MAX_JSON_BYTES,
    );
  }
}

function validateCommonFields(
  payload: SessionCreatePayload | SessionUpdatePayload,
  allowNull: boolean,
): void {
  validateOptionalString(
    payload.engineSessionId,
    'engineSessionId',
    AGENT_IDENTIFIER_MAX_BYTES,
    allowNull,
  );
  validateOptionalString(
    payload.name,
    'name',
    AGENT_SESSION_NAME_MAX_BYTES,
    allowNull,
  );
  validateOptionalString(
    payload.model,
    'model',
    AGENT_MODEL_MAX_BYTES,
    allowNull,
  );
  validateOptionalString(
    payload.permissionMode,
    'permissionMode',
    AGENT_CLI_SOURCE_MAX_BYTES,
    allowNull,
  );
  if (
    payload.allowDangerouslySkipPermissions !== undefined &&
    !(allowNull && payload.allowDangerouslySkipPermissions === null) &&
    typeof payload.allowDangerouslySkipPermissions !== 'boolean'
  ) {
    invalid('allowDangerouslySkipPermissions');
  }
  validateCombinedConfigBytes(
    validateSystemPromptConfig(payload.systemPromptConfig, allowNull),
    validateOptionsConfig(payload.optionsConfig, allowNull),
  );
}

export function validateSessionIdentifier(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(field);
  assertUtf8ByteLimit(value, field, AGENT_IDENTIFIER_MAX_BYTES);
}

export function validateSessionCreatePayload(
  projectId: unknown,
  engineName: unknown,
  payload: SessionCreatePayload,
): void {
  if (!isRecord(payload)) invalid('payload');
  validateSessionIdentifier(projectId, 'projectId');
  validateSessionIdentifier(engineName, 'engineName');
  if (payload.id !== undefined) validateSessionIdentifier(payload.id, 'id');
  validateCommonFields(payload, false);
}

export function validateSessionUpdatePayload(
  sessionId: unknown,
  payload: SessionUpdatePayload,
): void {
  if (!isRecord(payload)) invalid('payload');
  validateSessionIdentifier(sessionId, 'sessionId');
  validateCommonFields(payload, true);
  if (payload.managementInfo !== undefined && payload.managementInfo !== null) {
    if (!isRecord(payload.managementInfo)) invalid('managementInfo');
    assertJsonByteLimit(
      payload.managementInfo,
      'managementInfo',
      AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES,
    );
  }
}

export function stringifySessionConfig(
  value: unknown,
  field: 'systemPromptConfig' | 'optionsConfig' | 'managementInfo',
): string | null {
  if (value === null || value === undefined) return null;
  const maximumBytes =
    field === 'systemPromptConfig'
      ? AGENT_SYSTEM_PROMPT_CONFIG_MAX_JSON_BYTES
      : field === 'optionsConfig'
        ? AGENT_SESSION_OPTIONS_MAX_JSON_BYTES
        : AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES;
  return assertJsonByteLimit(value, field, maximumBytes);
}
