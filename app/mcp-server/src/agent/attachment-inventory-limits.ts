import {
  AGENT_ATTACHMENT_CLEANUP_MAX_PROJECT_IDS,
  AGENT_ATTACHMENT_CLEANUP_PROJECT_IDS_MAX_JSON_BYTES,
  AGENT_ATTACHMENT_STATS_DEFAULT_LIMIT,
  AGENT_ATTACHMENT_STATS_MAX_LIMIT,
  AGENT_ATTACHMENT_STATS_MAX_OFFSET,
  AGENT_IDENTIFIER_MAX_BYTES,
} from 'webpage-mcp-shared';
import {
  AGENT_PAYLOAD_INVALID,
  AgentPayloadLimitError,
  assertJsonByteLimit,
  assertUtf8ByteLimit,
} from './payload-limits';

const CLEANUP_REQUEST_KEYS = new Set(['projectIds']);
const PAGE_NUMBER_MAX_BYTES = 32;
const ATTACHMENT_PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface AttachmentStatsPageOptions {
  limit: number;
  offset: number;
}

export interface NormalizedAttachmentCleanupRequest {
  selected: boolean;
  projectIds?: string[];
}

function invalid(field: string): never {
  throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isValidAttachmentProjectId(value: string): boolean {
  return ATTACHMENT_PROJECT_ID_PATTERN.test(value);
}

export function parseAttachmentStatsPageValue(
  value: unknown,
  field: 'limit' | 'offset',
): number | undefined {
  if (value === undefined) return undefined;
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string') {
    assertUtf8ByteLimit(value, field, PAGE_NUMBER_MAX_BYTES);
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) invalid(field);
    parsed = Number(trimmed);
  } else {
    invalid(field);
  }
  if (!Number.isSafeInteger(parsed)) invalid(field);
  return parsed;
}

export function normalizeAttachmentStatsPageOptions(
  input: { limit?: unknown; offset?: unknown } = {},
): AttachmentStatsPageOptions {
  if (!isRecord(input)) invalid('pagination');
  const rawLimit = input.limit;
  const rawOffset = input.offset;
  if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isSafeInteger(rawLimit))) {
    invalid('limit');
  }
  if (
    rawOffset !== undefined &&
    (typeof rawOffset !== 'number' || !Number.isSafeInteger(rawOffset))
  ) {
    invalid('offset');
  }
  if (typeof rawLimit === 'number' && rawLimit <= 0) invalid('limit');
  if (
    typeof rawOffset === 'number' &&
    (rawOffset < 0 || rawOffset > AGENT_ATTACHMENT_STATS_MAX_OFFSET)
  ) {
    invalid('offset');
  }
  return {
    limit: Math.min(
      typeof rawLimit === 'number' ? rawLimit : AGENT_ATTACHMENT_STATS_DEFAULT_LIMIT,
      AGENT_ATTACHMENT_STATS_MAX_LIMIT,
    ),
    offset: typeof rawOffset === 'number' ? rawOffset : 0,
  };
}

export function normalizeAttachmentCleanupRequest(
  value: unknown,
): NormalizedAttachmentCleanupRequest {
  if (value === undefined) return { selected: false };
  if (!isRecord(value)) invalid('cleanup');
  for (const key in value) {
    if (
      Object.prototype.hasOwnProperty.call(value, key) &&
      !CLEANUP_REQUEST_KEYS.has(key)
    ) {
      invalid('cleanup.keys');
    }
  }
  if (value.projectIds === undefined) return { selected: false };
  if (!Array.isArray(value.projectIds)) invalid('projectIds');
  if (value.projectIds.length > AGENT_ATTACHMENT_CLEANUP_MAX_PROJECT_IDS) {
    invalid('projectIds.count');
  }
  assertJsonByteLimit(
    value.projectIds,
    'projectIds',
    AGENT_ATTACHMENT_CLEANUP_PROJECT_IDS_MAX_JSON_BYTES,
  );

  const projectIds: string[] = [];
  const seen = new Set<string>();
  value.projectIds.forEach((rawProjectId, index) => {
    const field = `projectIds[${index}]`;
    if (typeof rawProjectId !== 'string') invalid(field);
    assertUtf8ByteLimit(rawProjectId, field, AGENT_IDENTIFIER_MAX_BYTES);
    const projectId = rawProjectId.trim();
    if (!projectId || !isValidAttachmentProjectId(projectId)) invalid(field);
    if (!seen.has(projectId)) {
      seen.add(projectId);
      projectIds.push(projectId);
    }
  });
  return { selected: true, projectIds };
}
