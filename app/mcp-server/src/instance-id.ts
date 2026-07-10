import { DEFAULT_MCP_INSTANCE_ID } from 'webpage-mcp-shared';

export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const INSTANCE_ID_MAX_INPUT_CODE_UNITS = 128;
export const WEBPAGE_MCP_INSTANCE_ID_ENV = 'WEBPAGE_MCP_INSTANCE_ID';

/**
 * Resolve an optional instance identifier without allowing malformed explicit
 * values to fall through to the default instance.
 */
export function resolveInstanceId(raw: unknown): string {
  if (raw === undefined) {
    return DEFAULT_MCP_INSTANCE_ID;
  }

  if (typeof raw !== 'string' || raw.length > INSTANCE_ID_MAX_INPUT_CODE_UNITS) {
    throw new Error(
      'Invalid instanceId: expected a string containing 1-64 letters, numbers, dots, underscores, or hyphens',
    );
  }

  const trimmed = raw.trim();
  if (!INSTANCE_ID_PATTERN.test(trimmed)) {
    throw new Error('Invalid instanceId: expected 1-64 letters, numbers, dots, underscores, or hyphens');
  }

  return trimmed;
}
