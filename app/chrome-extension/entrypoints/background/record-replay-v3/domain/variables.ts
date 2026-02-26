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
  /** Scope (excluding persistent, persistent is judged by $ prefix) */
  scope?: Exclude<VariableScope, 'persistent'>;
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
