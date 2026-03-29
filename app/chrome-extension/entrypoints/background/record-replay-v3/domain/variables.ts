/**
 * @fileoverview Variable type definition
 * @description Define variable pointers and persistent variables used in Record-Replay V3
 */

import type { JsonValue, UnixMillis } from './json';

/** variable name */
export type VariableName = string;

/** Persistence variable name (starting with $) */
export type PersistentVariableName = `$${string}`;

/** variable scope */
export type VariableScope = 'run' | 'flow' | 'persistent';
export type VariableKind = 'string' | 'number' | 'boolean' | 'json' | 'enum' | 'array';
export type VariableArrayItemKind = 'string' | 'number' | 'boolean' | 'json';

/**
 * variable pointer
 * @description A reference to a variable, supporting JSON path access
 */
export interface VariablePointer {
  /** variable scope */
  scope: VariableScope;
  /** variable name */
  name: VariableName;
  /** JSON path（for accessing nested properties) */
  path?: ReadonlyArray<string | number>;
}

/**
 * variable definition
 * @description Flow variables declared in
 */
export interface VariableDefinition {
  /** variable name */
  name: VariableName;
  /** show label */
  label?: string;
  /** Description */
  description?: string;
  /** Is it sensitive (not displayed/exported) */
  sensitive?: boolean;
  /** Is it necessary */
  required?: boolean;
  /** Default value */
  default?: JsonValue;
  /** Variable value kind */
  kind?: VariableKind;
  /** Enum options when kind is enum */
  options?: JsonValue[];
  /** Array item kind when kind is array */
  item?: VariableArrayItemKind;
  /** Scope (excluding persistent, persistent is judged by $ prefix) */
  scope?: Exclude<VariableScope, 'persistent'>;
}

const VARIABLE_KINDS = new Set<VariableKind>([
  'string',
  'number',
  'boolean',
  'json',
  'enum',
  'array',
]);

const VARIABLE_ARRAY_ITEM_KINDS = new Set<VariableArrayItemKind>([
  'string',
  'number',
  'boolean',
  'json',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (isRecord(value)) {
    return Object.values(value).every((item) => isJsonValue(item));
  }

  return false;
}

function normalizeTextValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeVariableKind(
  value: unknown,
  fieldPath: string,
): VariableKind | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = normalizeTextValue(value).toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (!VARIABLE_KINDS.has(normalized as VariableKind)) {
    throw new Error(
      `${fieldPath} must be one of "string", "number", "boolean", "json", "enum", or "array"`,
    );
  }

  return normalized as VariableKind;
}

function normalizeVariableArrayItemKind(
  value: unknown,
  fieldPath: string,
): VariableArrayItemKind | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = normalizeTextValue(value).toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (!VARIABLE_ARRAY_ITEM_KINDS.has(normalized as VariableArrayItemKind)) {
    throw new Error(
      `${fieldPath} must be one of "string", "number", "boolean", or "json"`,
    );
  }

  return normalized as VariableArrayItemKind;
}

function normalizeVariableOptions(
  value: unknown,
  fieldPath: string,
): JsonValue[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an array`);
  }

  if (!value.every((item) => isJsonValue(item))) {
    throw new Error(`${fieldPath} must contain JSON-serializable values`);
  }

  return value as JsonValue[];
}

export function normalizeVariableDefinition(
  value: unknown,
  fieldPath: string,
): VariableDefinition {
  if (!isRecord(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }

  const name =
    normalizeTextValue(value.name) || normalizeTextValue(value.key);
  if (!name) {
    throw new Error(`${fieldPath}.name is required`);
  }

  const variable: VariableDefinition = { name };
  const label = normalizeTextValue(value.label);
  if (label) {
    variable.label = label;
  }

  const description = normalizeTextValue(value.description);
  if (description) {
    variable.description = description;
  }

  if (typeof value.sensitive === 'boolean') {
    variable.sensitive = value.sensitive;
  }

  let rules: Record<string, unknown> | undefined;
  if (value.rules !== undefined && value.rules !== null) {
    if (!isRecord(value.rules)) {
      throw new Error(`${fieldPath}.rules must be an object`);
    }
    rules = value.rules;
  }

  if (typeof value.required === 'boolean') {
    variable.required = value.required;
  } else if (typeof rules?.required === 'boolean') {
    variable.required = rules.required;
  }

  if (value.default !== undefined) {
    if (!isJsonValue(value.default)) {
      throw new Error(`${fieldPath}.default must be JSON-serializable`);
    }
    variable.default = value.default;
  }

  let kind = normalizeVariableKind(
    value.kind ?? value.type,
    `${fieldPath}.kind`,
  );
  const options =
    normalizeVariableOptions(value.options, `${fieldPath}.options`) ??
    normalizeVariableOptions(rules?.enum, `${fieldPath}.rules.enum`);
  const item = normalizeVariableArrayItemKind(value.item, `${fieldPath}.item`);

  if (!kind && options) {
    kind = 'enum';
  }
  if (!kind && item) {
    kind = 'array';
  }

  if (options && kind !== 'enum') {
    throw new Error(`${fieldPath}.options requires kind "enum"`);
  }
  if (item && kind !== 'array') {
    throw new Error(`${fieldPath}.item requires kind "array"`);
  }

  if (kind) {
    variable.kind = kind;
  }
  if (options) {
    variable.options = options;
  }
  if (item) {
    variable.item = item;
  }

  if (value.scope !== undefined) {
    if (value.scope !== 'flow' && value.scope !== 'run') {
      throw new Error(`${fieldPath}.scope must be "flow" or "run"`);
    }
    variable.scope = value.scope;
  }

  return variable;
}

export function normalizeVariableDefinitions(
  value: unknown,
  fieldPath: string,
): VariableDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an array`);
  }

  const seen = new Set<string>();
  const variables: VariableDefinition[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const variable = normalizeVariableDefinition(
      value[index],
      `${fieldPath}[${index}]`,
    );
    if (seen.has(variable.name)) {
      throw new Error(`Duplicate variable name: "${variable.name}"`);
    }
    seen.add(variable.name);
    variables.push(variable);
  }

  return variables;
}

/**
 * Persistent variable logging
 * @description Persistent variables stored in IndexedDB
 */
export interface PersistentVarRecord {
  /** Variable keys (starting with $) */
  key: PersistentVariableName;
  /** variable value */
  value: JsonValue;
  /** Last updated */
  updatedAt: UnixMillis;
  /** Version number (monotonically increasing, used for LWW and debugging) */
  version: number;
}

/**
 * Determine whether the variable name is a persistent variable
 */
export function isPersistentVariable(name: string): name is PersistentVariableName {
  return name.startsWith('$');
}

/**
 * Parse variable pointer string
 * @example "$user.name" -> { scope: 'persistent', name: '$user', path: ['name'] }
 */
export function parseVariablePointer(ref: string): VariablePointer | null {
  if (!ref) return null;

  const parts = ref.split('.');
  const name = parts[0];
  const path = parts.slice(1);

  if (isPersistentVariable(name)) {
    return {
      scope: 'persistent',
      name,
      path: path.length > 0 ? path : undefined,
    };
  }

  // Defaults to run scope
  return {
    scope: 'run',
    name,
    path: path.length > 0 ? path : undefined,
  };
}
