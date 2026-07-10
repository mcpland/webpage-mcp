import {
  AGENT_CLI_SOURCE_MAX_BYTES,
  AGENT_IDENTIFIER_MAX_BYTES,
  AGENT_MODEL_MAX_BYTES,
  AGENT_PROJECT_DESCRIPTION_MAX_BYTES,
  AGENT_PROJECT_LOCATION_MAX,
  AGENT_PROJECT_NAME_MAX_BYTES,
  AGENT_PROJECT_ROOT_MAX_BYTES,
  AGENT_PROJECT_UPSERT_MAX_JSON_BYTES,
} from 'webpage-mcp-shared';
import {
  AGENT_PAYLOAD_INVALID,
  AgentPayloadLimitError,
  assertJsonByteLimit,
  assertUtf8ByteLimit,
} from './payload-limits';

const PROJECT_UPSERT_KEYS = new Set([
  'id',
  'name',
  'description',
  'rootPath',
  'preferredCli',
  'selectedModel',
  'enableWebpageMcp',
  'allowCreate',
]);

function invalid(field: string): never {
  throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertKnownProjectKeys(value: Record<string, unknown>): void {
  if (Object.keys(value).some((key) => !PROJECT_UPSERT_KEYS.has(key))) {
    // Avoid reflecting attacker-controlled property names in RPC responses.
    invalid('project.keys');
  }
}

function validateString(
  value: unknown,
  field: string,
  maximumBytes: number,
  options: { optional?: boolean; allowEmpty?: boolean } = {},
): asserts value is string | undefined {
  if (value === undefined && options.optional) return;
  if (typeof value !== 'string') invalid(field);
  assertUtf8ByteLimit(value, field, maximumBytes);
  if (!options.allowEmpty && value.trim().length === 0) invalid(field);
}

export function validateProjectIdentifier(
  value: unknown,
  field = 'projectId',
): asserts value is string {
  validateString(value, field, AGENT_IDENTIFIER_MAX_BYTES);
}

export function validateOptionalProjectIdentifier(
  value: unknown,
  field: string,
  options: { allowNull?: boolean; allowEmpty?: boolean } = {},
): void {
  if (value === undefined || (options.allowNull && value === null)) return;
  validateString(value, field, AGENT_IDENTIFIER_MAX_BYTES, {
    allowEmpty: options.allowEmpty,
  });
}

export function validateProjectPath(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean } = {},
): asserts value is string {
  validateString(value, field, AGENT_PROJECT_ROOT_MAX_BYTES, options);
}

export function validateProjectName(
  value: unknown,
  field = 'projectName',
): asserts value is string {
  validateString(value, field, AGENT_PROJECT_NAME_MAX_BYTES);
}

export function validateProjectUpsertPayload(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalid('project');
  assertJsonByteLimit(
    value,
    'project',
    AGENT_PROJECT_UPSERT_MAX_JSON_BYTES,
  );
  assertKnownProjectKeys(value);

  validateOptionalProjectIdentifier(value.id, 'id');
  validateString(value.name, 'name', AGENT_PROJECT_NAME_MAX_BYTES);
  validateString(
    value.description,
    'description',
    AGENT_PROJECT_DESCRIPTION_MAX_BYTES,
    { optional: true, allowEmpty: true },
  );
  validateProjectPath(value.rootPath, 'rootPath');
  validateString(
    value.preferredCli,
    'preferredCli',
    AGENT_CLI_SOURCE_MAX_BYTES,
    { optional: true },
  );
  validateString(value.selectedModel, 'selectedModel', AGENT_MODEL_MAX_BYTES, {
    optional: true,
    allowEmpty: true,
  });

  for (const field of ['enableWebpageMcp', 'allowCreate'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') {
      invalid(field);
    }
  }
}

function validateProjectLocation(value: unknown, field: 'line' | 'column'): void {
  if (value === undefined) return;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > AGENT_PROJECT_LOCATION_MAX
  ) {
    invalid(field);
  }
}

export function validateProjectOpenTarget(value: unknown): asserts value is string {
  validateString(value, 'target', AGENT_CLI_SOURCE_MAX_BYTES);
}

export function validateProjectOpenFilePayload(
  filePath: unknown,
  line: unknown,
  column: unknown,
): asserts filePath is string {
  validateProjectPath(filePath, 'filePath');
  validateProjectLocation(line, 'line');
  validateProjectLocation(column, 'column');
}
