import {
  AGENT_ACT_NON_ATTACHMENT_MAX_JSON_BYTES,
  AGENT_ATTACHMENT_MAX_BYTES,
  AGENT_CLI_SOURCE_MAX_BYTES,
  AGENT_CLIENT_META_MAX_JSON_BYTES,
  AGENT_CONTEXT_ELEMENT_INFO_MAX_JSON_BYTES,
  AGENT_CONTEXT_MAX_JSON_BYTES,
  AGENT_CONTEXT_PAGE_URL_MAX_BYTES,
  AGENT_CONTEXT_SELECTED_TEXT_MAX_BYTES,
  AGENT_DISPLAY_TEXT_MAX_BYTES,
  AGENT_FINAL_PROMPT_MAX_BYTES,
  AGENT_CREATED_AT_MAX_BYTES,
  AGENT_IDENTIFIER_MAX_BYTES,
  AGENT_MESSAGE_CONTENT_MAX_BYTES,
  AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
  AGENT_MODEL_MAX_BYTES,
  AGENT_PROJECT_ROOT_MAX_BYTES,
  AGENT_STORED_MESSAGE_MAX_JSON_BYTES,
} from 'webpage-mcp-shared';

export const AGENT_PAYLOAD_INVALID = 'AGENT_PAYLOAD_INVALID' as const;
export const AGENT_PAYLOAD_TOO_LARGE = 'AGENT_PAYLOAD_TOO_LARGE' as const;
export const AGENT_JSON_MAX_DEPTH = 64;
export const AGENT_JSON_MAX_NODES = 50_000;
export const AGENT_JSON_MAX_CONTAINER_ENTRIES = 10_000;

export type AgentPayloadErrorCode =
  | typeof AGENT_PAYLOAD_INVALID
  | typeof AGENT_PAYLOAD_TOO_LARGE;

export interface AgentPayloadErrorResponse {
  error: string;
  code: AgentPayloadErrorCode;
  field: string;
  actualBytes?: number;
  maximumBytes?: number;
}

export class AgentPayloadLimitError extends Error {
  public readonly name = 'AgentPayloadLimitError';

  public constructor(
    public readonly code: AgentPayloadErrorCode,
    public readonly field: string,
    public readonly actualBytes?: number,
    public readonly maximumBytes?: number,
  ) {
    super(
      code === AGENT_PAYLOAD_TOO_LARGE
        ? `${field} is too large (${actualBytes ?? 'unknown'} bytes; maximum ${maximumBytes ?? 'unknown'} bytes)`
        : `${field} has an invalid type or is not JSON serializable`,
    );
  }
}

export function isAgentPayloadLimitError(error: unknown): error is AgentPayloadLimitError {
  return error instanceof AgentPayloadLimitError;
}

export function toAgentPayloadErrorResponse(
  error: AgentPayloadLimitError,
): AgentPayloadErrorResponse {
  return {
    error: error.message,
    code: error.code,
    field: error.field,
    ...(error.actualBytes === undefined ? {} : { actualBytes: error.actualBytes }),
    ...(error.maximumBytes === undefined ? {} : { maximumBytes: error.maximumBytes }),
  };
}

export function getUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertJsonStructureLimits(value: unknown, field: string): void {
  type StackEntry =
    | { value: unknown; depth: number; exiting?: false }
    | { value: object; depth: number; exiting: true };

  const stack: StackEntry[] = [{ value, depth: 0 }];
  const activeContainers = new WeakSet<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (entry.exiting) {
      activeContainers.delete(entry.value);
      continue;
    }

    nodes += 1;
    if (nodes > AGENT_JSON_MAX_NODES) {
      throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, field);
    }

    const current = entry.value;
    if (!current || typeof current !== 'object') continue;
    if (entry.depth > AGENT_JSON_MAX_DEPTH || activeContainers.has(current)) {
      throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, field);
    }

    activeContainers.add(current);
    stack.push({ value: current, depth: entry.depth, exiting: true });

    if (Array.isArray(current)) {
      if (current.length > AGENT_JSON_MAX_CONTAINER_ENTRIES) {
        throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, field);
      }
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current[index], depth: entry.depth + 1 });
      }
      continue;
    }

    let entries = 0;
    for (const key in current as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      entries += 1;
      if (entries > AGENT_JSON_MAX_CONTAINER_ENTRIES) {
        throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, field);
      }
      stack.push({
        value: (current as Record<string, unknown>)[key],
        depth: entry.depth + 1,
      });
    }
  }
}

export function stringifyPayloadJson(value: unknown, field: string): string {
  try {
    assertJsonStructureLimits(value, field);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, field);
    }
    return serialized;
  } catch (error) {
    if (isAgentPayloadLimitError(error)) throw error;
    throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, field);
  }
}

export function getJsonByteLength(value: unknown, field = 'payload'): number {
  return getUtf8ByteLength(stringifyPayloadJson(value, field));
}

export function assertUtf8ByteLimit(
  value: string,
  field: string,
  maximumBytes: number,
): void {
  const actualBytes = getUtf8ByteLength(value);
  if (actualBytes > maximumBytes) {
    throw new AgentPayloadLimitError(
      AGENT_PAYLOAD_TOO_LARGE,
      field,
      actualBytes,
      maximumBytes,
    );
  }
}

export function assertJsonByteLimit(
  value: unknown,
  field: string,
  maximumBytes: number,
): string {
  const serialized = stringifyPayloadJson(value, field);
  const actualBytes = getUtf8ByteLength(serialized);
  if (actualBytes > maximumBytes) {
    throw new AgentPayloadLimitError(
      AGENT_PAYLOAD_TOO_LARGE,
      field,
      actualBytes,
      maximumBytes,
    );
  }
  return serialized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalidPayload(field: string): never {
  throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, field);
}

function validateOptionalStringField(
  record: Record<string, unknown>,
  key: string,
  field: string,
  maximumBytes: number,
  allowNull = false,
): void {
  const value = record[key];
  if (value === undefined) return;
  if (allowNull && value === null) return;
  if (typeof value !== 'string') invalidPayload(field);
  assertUtf8ByteLimit(value, field, maximumBytes);
}

function attachmentExtension(mimeType: unknown): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

function validateCanonicalUserMessage(
  record: Record<string, unknown>,
  instruction: string,
  sessionId?: string,
): void {
  const requestedProjectId =
    typeof record.projectId === 'string' ? record.projectId.trim() : '';
  const projectedProjectId =
    requestedProjectId || 'p'.repeat(AGENT_IDENTIFIER_MAX_BYTES);
  const messageId = '00000000-0000-4000-8000-000000000000';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.slice(0, 4).flatMap((value, index) => {
        const attachment = asRecord(value);
        if (!attachment) return [];
        const extension = attachmentExtension(attachment.mimeType);
        const filename = `${messageId}-${index}-00000000.${extension}`;
        return [
          {
            version: 1,
            kind: 'image',
            projectId: projectedProjectId,
            messageId,
            index,
            filename,
            urlPath: `/agent/attachments/${projectedProjectId}/${filename}`,
            mimeType:
              typeof attachment.mimeType === 'string' ? attachment.mimeType : 'image/png',
            sizeBytes: AGENT_ATTACHMENT_MAX_BYTES,
            originalName: typeof attachment.name === 'string' ? attachment.name : '',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ];
      })
    : [];

  const metadata = {
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(record.clientMeta === undefined ? {} : { clientMeta: record.clientMeta }),
    ...(record.displayText === undefined ? {} : { displayText: record.displayText }),
  };
  validateStoredMessagePayload({
    id: messageId,
    projectId: projectedProjectId,
    sessionId:
      sessionId ??
      (typeof record.dbSessionId === 'string'
        ? record.dbSessionId
        : 's'.repeat(AGENT_IDENTIFIER_MAX_BYTES)),
    conversationId: null,
    role: 'user',
    content: instruction.trim(),
    messageType: 'chat',
    metadata: Object.keys(metadata).length === 0 ? undefined : metadata,
    cliSource:
      typeof record.cliPreference === 'string' && record.cliPreference.length > 0
        ? record.cliPreference
        : 'claude',
    requestId:
      typeof record.requestId === 'string' && record.requestId.length > 0
        ? record.requestId
        : '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

export function validateAgentActPayload(
  payload: unknown,
  options: { sessionId?: string } = {},
): void {
  const record = asRecord(payload);
  if (!record) {
    invalidPayload('payload');
  }

  if (typeof record.instruction !== 'string') invalidPayload('instruction');
  assertUtf8ByteLimit(record.instruction, 'instruction', AGENT_MESSAGE_CONTENT_MAX_BYTES);
  validateOptionalStringField(record, 'requestId', 'requestId', AGENT_IDENTIFIER_MAX_BYTES);
  validateOptionalStringField(record, 'projectId', 'projectId', AGENT_IDENTIFIER_MAX_BYTES);
  validateOptionalStringField(record, 'dbSessionId', 'dbSessionId', AGENT_IDENTIFIER_MAX_BYTES);
  validateOptionalStringField(record, 'model', 'model', AGENT_MODEL_MAX_BYTES);
  validateOptionalStringField(
    record,
    'cliPreference',
    'cliPreference',
    AGENT_CLI_SOURCE_MAX_BYTES,
  );
  validateOptionalStringField(
    record,
    'projectRoot',
    'projectRoot',
    AGENT_PROJECT_ROOT_MAX_BYTES,
  );
  if (options.sessionId !== undefined) {
    assertUtf8ByteLimit(options.sessionId, 'sessionId', AGENT_IDENTIFIER_MAX_BYTES);
  }

  if (record.context !== undefined) {
    const context = asRecord(record.context);
    if (!context) invalidPayload('context');
    if (context) {
      if (context.pageUrl !== undefined) {
        if (typeof context.pageUrl !== 'string') invalidPayload('context.pageUrl');
        assertUtf8ByteLimit(
          context.pageUrl,
          'context.pageUrl',
          AGENT_CONTEXT_PAGE_URL_MAX_BYTES,
        );
      }
      if (context.selectedText !== undefined) {
        if (typeof context.selectedText !== 'string') invalidPayload('context.selectedText');
        assertUtf8ByteLimit(
          context.selectedText,
          'context.selectedText',
          AGENT_CONTEXT_SELECTED_TEXT_MAX_BYTES,
        );
      }
      if (context.elementInfo !== undefined) {
        assertJsonByteLimit(
          context.elementInfo,
          'context.elementInfo',
          AGENT_CONTEXT_ELEMENT_INFO_MAX_JSON_BYTES,
        );
      }
    }
    assertJsonByteLimit(record.context, 'context', AGENT_CONTEXT_MAX_JSON_BYTES);
  }

  if (record.clientMeta !== undefined) {
    if (!asRecord(record.clientMeta)) invalidPayload('clientMeta');
    assertJsonByteLimit(record.clientMeta, 'clientMeta', AGENT_CLIENT_META_MAX_JSON_BYTES);
  }
  if (record.displayText !== undefined) {
    if (typeof record.displayText !== 'string') invalidPayload('displayText');
    assertUtf8ByteLimit(record.displayText, 'displayText', AGENT_DISPLAY_TEXT_MAX_BYTES);
  }

  let nonAttachmentPayload: Record<string, unknown>;
  try {
    nonAttachmentPayload = Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== 'attachments'),
    );
  } catch {
    throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, 'payload');
  }
  assertJsonByteLimit(
    nonAttachmentPayload,
    'payload',
    AGENT_ACT_NON_ATTACHMENT_MAX_JSON_BYTES,
  );
  validateCanonicalUserMessage(record, record.instruction, options.sessionId);
}

export function validateFinalAgentPrompt(prompt: string): void {
  assertUtf8ByteLimit(prompt, 'prompt', AGENT_FINAL_PROMPT_MAX_BYTES);
}

export interface AgentMessagePayload {
  content: string;
  metadata?: unknown;
  [key: string]: unknown;
}

export interface ValidatedAgentMessagePayload {
  metadataJson?: string;
}

export function validateAgentMessageFields(
  content: string,
  metadata?: unknown,
): ValidatedAgentMessagePayload {
  assertUtf8ByteLimit(content, 'content', AGENT_MESSAGE_CONTENT_MAX_BYTES);
  if (metadata === undefined) return {};
  return {
    metadataJson: assertJsonByteLimit(
      metadata,
      'metadata',
      AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
    ),
  };
}

export function validateStoredMessagePayload(
  payload: AgentMessagePayload,
): ValidatedAgentMessagePayload {
  if (typeof payload.content !== 'string') {
    throw new AgentPayloadLimitError(AGENT_PAYLOAD_INVALID, 'content');
  }
  const record = payload as Record<string, unknown>;
  validateOptionalStringField(record, 'id', 'id', AGENT_IDENTIFIER_MAX_BYTES);
  validateOptionalStringField(record, 'projectId', 'projectId', AGENT_IDENTIFIER_MAX_BYTES);
  validateOptionalStringField(record, 'sessionId', 'sessionId', AGENT_IDENTIFIER_MAX_BYTES);
  validateOptionalStringField(
    record,
    'conversationId',
    'conversationId',
    AGENT_IDENTIFIER_MAX_BYTES,
    true,
  );
  validateOptionalStringField(record, 'requestId', 'requestId', AGENT_IDENTIFIER_MAX_BYTES, true);
  validateOptionalStringField(record, 'cliSource', 'cliSource', AGENT_CLI_SOURCE_MAX_BYTES, true);
  validateOptionalStringField(record, 'createdAt', 'createdAt', AGENT_CREATED_AT_MAX_BYTES);
  validateOptionalStringField(record, 'role', 'role', AGENT_CLI_SOURCE_MAX_BYTES);
  validateOptionalStringField(record, 'messageType', 'messageType', AGENT_CLI_SOURCE_MAX_BYTES);
  const validated = validateAgentMessageFields(payload.content, payload.metadata);
  const normalized = {
    ...payload,
    ...(validated.metadataJson === undefined
      ? {}
      : { metadata: JSON.parse(validated.metadataJson) as unknown }),
  };
  assertJsonByteLimit(normalized, 'message', AGENT_STORED_MESSAGE_MAX_JSON_BYTES);
  return validated;
}
