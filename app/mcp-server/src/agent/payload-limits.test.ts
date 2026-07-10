import { describe, expect, it } from 'vitest';
import {
  AGENT_ACT_NON_ATTACHMENT_MAX_JSON_BYTES,
  AGENT_CLI_SOURCE_MAX_BYTES,
  AGENT_CLIENT_META_MAX_JSON_BYTES,
  AGENT_CONTEXT_ELEMENT_INFO_MAX_JSON_BYTES,
  AGENT_CONTEXT_MAX_JSON_BYTES,
  AGENT_CONTEXT_PAGE_URL_MAX_BYTES,
  AGENT_CONTEXT_SELECTED_TEXT_MAX_BYTES,
  AGENT_CREATED_AT_MAX_BYTES,
  AGENT_DISPLAY_TEXT_MAX_BYTES,
  AGENT_FINAL_PROMPT_MAX_BYTES,
  AGENT_IDENTIFIER_MAX_BYTES,
  AGENT_MESSAGE_CONTENT_MAX_BYTES,
  AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
  AGENT_MODEL_MAX_BYTES,
  AGENT_PROJECT_ROOT_MAX_BYTES,
  AGENT_STORED_MESSAGE_MAX_JSON_BYTES,
} from 'webpage-mcp-shared';
import {
  AGENT_PAYLOAD_INVALID,
  AGENT_PAYLOAD_TOO_LARGE,
  AgentPayloadLimitError,
  getJsonByteLength,
  getUtf8ByteLength,
  toAgentPayloadErrorResponse,
  validateAgentActPayload,
  validateAgentMessageFields,
  validateFinalAgentPrompt,
  validateStoredMessagePayload,
} from './payload-limits';

function jsonObjectAtBytes(
  maximumBytes: number,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const empty = { ...base, padding: '' };
  const emptyBytes = getJsonByteLength(empty);
  if (emptyBytes > maximumBytes) throw new Error('base object exceeds requested size');
  const value = { ...base, padding: 'a'.repeat(maximumBytes - emptyBytes) };
  expect(getJsonByteLength(value)).toBe(maximumBytes);
  return value;
}

function expectTooLarge(
  action: () => void,
  field: string,
  maximumBytes: number,
): AgentPayloadLimitError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentPayloadLimitError);
    const limitError = error as AgentPayloadLimitError;
    expect(limitError).toMatchObject({
      code: AGENT_PAYLOAD_TOO_LARGE,
      field,
      maximumBytes,
    });
    expect(limitError.actualBytes).toBeGreaterThan(maximumBytes);
    return limitError;
  }
  throw new Error('expected payload validation to fail');
}

describe('agent payload byte limits', () => {
  it.each([
    ['ASCII', 'a', 1],
    ['Chinese', '界', 3],
    ['emoji', '😀', 4],
  ] as const)('accepts exact %s content boundaries and rejects one more code point', (_, unit, unitBytes) => {
    expect(AGENT_MESSAGE_CONTENT_MAX_BYTES % unitBytes).toBe(0);
    const exact = unit.repeat(AGENT_MESSAGE_CONTENT_MAX_BYTES / unitBytes);
    expect(getUtf8ByteLength(exact)).toBe(AGENT_MESSAGE_CONTENT_MAX_BYTES);
    expect(() => validateAgentMessageFields(exact)).not.toThrow();

    const error = expectTooLarge(
      () => validateAgentMessageFields(`${exact}${unit}`),
      'content',
      AGENT_MESSAGE_CONTENT_MAX_BYTES,
    );
    expect(error.actualBytes).toBe(AGENT_MESSAGE_CONTENT_MAX_BYTES + unitBytes);
  });

  it('enforces every act field and aggregate budget without truncation', () => {
    expect(() =>
      validateAgentActPayload({ instruction: 'a'.repeat(AGENT_MESSAGE_CONTENT_MAX_BYTES) }),
    ).not.toThrow();
    expectTooLarge(
      () =>
        validateAgentActPayload({
          instruction: 'a'.repeat(AGENT_MESSAGE_CONTENT_MAX_BYTES + 1),
        }),
      'instruction',
      AGENT_MESSAGE_CONTENT_MAX_BYTES,
    );

    expect(() =>
      validateAgentActPayload({
        instruction: 'x',
        context: { pageUrl: 'a'.repeat(AGENT_CONTEXT_PAGE_URL_MAX_BYTES) },
      }),
    ).not.toThrow();
    expect(() =>
      validateAgentActPayload({
        instruction: 'x',
        displayText: 'a'.repeat(AGENT_DISPLAY_TEXT_MAX_BYTES),
      }),
    ).not.toThrow();
    expectTooLarge(
      () =>
        validateAgentActPayload({
          instruction: 'x',
          context: { pageUrl: 'a'.repeat(AGENT_CONTEXT_PAGE_URL_MAX_BYTES + 1) },
        }),
      'context.pageUrl',
      AGENT_CONTEXT_PAGE_URL_MAX_BYTES,
    );
    expect(() =>
      validateAgentActPayload({
        instruction: 'x',
        context: { selectedText: 'a'.repeat(AGENT_CONTEXT_SELECTED_TEXT_MAX_BYTES) },
      }),
    ).not.toThrow();
    expectTooLarge(
      () =>
        validateAgentActPayload({
          instruction: 'x',
          context: { selectedText: 'a'.repeat(AGENT_CONTEXT_SELECTED_TEXT_MAX_BYTES + 1) },
        }),
      'context.selectedText',
      AGENT_CONTEXT_SELECTED_TEXT_MAX_BYTES,
    );

    const exactElementInfo = jsonObjectAtBytes(AGENT_CONTEXT_ELEMENT_INFO_MAX_JSON_BYTES);
    expect(() =>
      validateAgentActPayload({ instruction: 'x', context: { elementInfo: exactElementInfo } }),
    ).not.toThrow();
    expectTooLarge(
      () =>
        validateAgentActPayload({
          instruction: 'x',
          context: {
            elementInfo: jsonObjectAtBytes(AGENT_CONTEXT_ELEMENT_INFO_MAX_JSON_BYTES + 1),
          },
        }),
      'context.elementInfo',
      AGENT_CONTEXT_ELEMENT_INFO_MAX_JSON_BYTES,
    );

    const exactContext = jsonObjectAtBytes(AGENT_CONTEXT_MAX_JSON_BYTES);
    expect(() => validateAgentActPayload({ instruction: 'x', context: exactContext })).not.toThrow();
    expectTooLarge(
      () =>
        validateAgentActPayload({
          instruction: 'x',
          context: jsonObjectAtBytes(AGENT_CONTEXT_MAX_JSON_BYTES + 1),
        }),
      'context',
      AGENT_CONTEXT_MAX_JSON_BYTES,
    );

    const exactClientMeta = jsonObjectAtBytes(AGENT_CLIENT_META_MAX_JSON_BYTES);
    expect(() =>
      validateAgentActPayload({ instruction: 'x', clientMeta: exactClientMeta }),
    ).not.toThrow();
    expectTooLarge(
      () =>
        validateAgentActPayload({
          instruction: 'x',
          clientMeta: jsonObjectAtBytes(AGENT_CLIENT_META_MAX_JSON_BYTES + 1),
        }),
      'clientMeta',
      AGENT_CLIENT_META_MAX_JSON_BYTES,
    );

    expectTooLarge(
      () =>
        validateAgentActPayload({
          instruction: 'x',
          displayText: 'a'.repeat(AGENT_DISPLAY_TEXT_MAX_BYTES + 1),
        }),
      'displayText',
      AGENT_DISPLAY_TEXT_MAX_BYTES,
    );

    const exactPayload = jsonObjectAtBytes(AGENT_ACT_NON_ATTACHMENT_MAX_JSON_BYTES, {
      instruction: 'x',
    });
    expect(() => validateAgentActPayload(exactPayload)).not.toThrow();
    expectTooLarge(
      () =>
        validateAgentActPayload(
          jsonObjectAtBytes(AGENT_ACT_NON_ATTACHMENT_MAX_JSON_BYTES + 1, {
            instruction: 'x',
          }),
        ),
      'payload',
      AGENT_ACT_NON_ATTACHMENT_MAX_JSON_BYTES,
    );

    expect(() => validateFinalAgentPrompt('a'.repeat(AGENT_FINAL_PROMPT_MAX_BYTES))).not.toThrow();
    expectTooLarge(
      () => validateFinalAgentPrompt('a'.repeat(AGENT_FINAL_PROMPT_MAX_BYTES + 1)),
      'prompt',
      AGENT_FINAL_PROMPT_MAX_BYTES,
    );
  });

  it('enforces metadata and complete stored-message JSON budgets', () => {
    const exactMetadata = jsonObjectAtBytes(AGENT_MESSAGE_METADATA_MAX_JSON_BYTES);
    expect(() => validateAgentMessageFields('x', exactMetadata)).not.toThrow();
    expectTooLarge(
      () =>
        validateAgentMessageFields(
          'x',
          jsonObjectAtBytes(AGENT_MESSAGE_METADATA_MAX_JSON_BYTES + 1),
        ),
      'metadata',
      AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
    );

    const exactMessage = jsonObjectAtBytes(AGENT_STORED_MESSAGE_MAX_JSON_BYTES, {
      content: 'x',
    }) as { content: string; [key: string]: unknown };
    expect(() => validateStoredMessagePayload(exactMessage)).not.toThrow();

    const oversizedCombinedMessage = {
      content: 'a'.repeat(AGENT_MESSAGE_CONTENT_MAX_BYTES),
      metadata: exactMetadata,
    };
    expectTooLarge(
      () => validateStoredMessagePayload(oversizedCombinedMessage),
      'message',
      AGENT_STORED_MESSAGE_MAX_JSON_BYTES,
    );
  });

  it('bounds identifiers, model names, paths, and complete canonical metadata', () => {
    for (const [field, maximumBytes] of [
      ['requestId', AGENT_IDENTIFIER_MAX_BYTES],
      ['projectId', AGENT_IDENTIFIER_MAX_BYTES],
      ['dbSessionId', AGENT_IDENTIFIER_MAX_BYTES],
      ['model', AGENT_MODEL_MAX_BYTES],
      ['cliPreference', AGENT_CLI_SOURCE_MAX_BYTES],
      ['projectRoot', AGENT_PROJECT_ROOT_MAX_BYTES],
    ] as const) {
      expect(() =>
        validateAgentActPayload({
          instruction: 'x',
          [field]: 'a'.repeat(maximumBytes),
        }),
      ).not.toThrow();
      expectTooLarge(
        () =>
          validateAgentActPayload({
            instruction: 'x',
            [field]: 'a'.repeat(maximumBytes + 1),
          }),
        field,
        maximumBytes,
      );
    }
    expect(() =>
      validateAgentActPayload(
        { instruction: 'x' },
        { sessionId: 'a'.repeat(AGENT_IDENTIFIER_MAX_BYTES) },
      ),
    ).not.toThrow();
    expectTooLarge(
      () =>
        validateAgentActPayload(
          { instruction: 'x' },
          { sessionId: 'a'.repeat(AGENT_IDENTIFIER_MAX_BYTES + 1) },
        ),
      'sessionId',
      AGENT_IDENTIFIER_MAX_BYTES,
    );

    const fullClientMeta = jsonObjectAtBytes(AGENT_CLIENT_META_MAX_JSON_BYTES);
    expectTooLarge(
      () =>
        validateAgentActPayload({
          instruction: 'x',
          projectId: 'project-1',
          clientMeta: fullClientMeta,
          displayText: '\u0000'.repeat(AGENT_DISPLAY_TEXT_MAX_BYTES),
          attachments: [
            {
              type: 'image',
              name: 'context.png',
              mimeType: 'image/png',
              dataBase64: 'eA==',
            },
          ],
        }),
      'metadata',
      AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
    );

    for (const [field, maximumBytes] of [
      ['id', AGENT_IDENTIFIER_MAX_BYTES],
      ['projectId', AGENT_IDENTIFIER_MAX_BYTES],
      ['sessionId', AGENT_IDENTIFIER_MAX_BYTES],
      ['conversationId', AGENT_IDENTIFIER_MAX_BYTES],
      ['requestId', AGENT_IDENTIFIER_MAX_BYTES],
      ['cliSource', AGENT_CLI_SOURCE_MAX_BYTES],
      ['createdAt', AGENT_CREATED_AT_MAX_BYTES],
      ['role', AGENT_CLI_SOURCE_MAX_BYTES],
      ['messageType', AGENT_CLI_SOURCE_MAX_BYTES],
    ] as const) {
      expect(() =>
        validateStoredMessagePayload({
          content: 'x',
          [field]: 'a'.repeat(maximumBytes),
        }),
      ).not.toThrow();
      expectTooLarge(
        () =>
          validateStoredMessagePayload({
            content: 'x',
            [field]: 'a'.repeat(maximumBytes + 1),
          }),
        field,
        maximumBytes,
      );
    }
  });

  it('rejects invalid instruction and context types with field-specific errors', () => {
    for (const [field, payload] of [
      ['instruction', { instruction: 1 }],
      ['context', { instruction: 'x', context: [] }],
      ['context.pageUrl', { instruction: 'x', context: { pageUrl: 1 } }],
      ['clientMeta', { instruction: 'x', clientMeta: [] }],
    ] as const) {
      expect(() => validateAgentActPayload(payload)).toThrowError(
        expect.objectContaining({ code: AGENT_PAYLOAD_INVALID, field }),
      );
    }
  });

  it('classifies circular, BigInt, and undefined JSON as invalid payloads', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const [field, value] of [
      ['circular', circular],
      ['bigint', { value: 1n }],
      ['undefined', undefined],
    ] as const) {
      expect(() => getJsonByteLength(value, field)).toThrowError(
        expect.objectContaining({
          code: AGENT_PAYLOAD_INVALID,
          field,
        }),
      );
    }

    const error = new AgentPayloadLimitError(
      AGENT_PAYLOAD_TOO_LARGE,
      'content',
      11,
      10,
    );
    expect(toAgentPayloadErrorResponse(error)).toEqual({
      error: 'content is too large (11 bytes; maximum 10 bytes)',
      code: AGENT_PAYLOAD_TOO_LARGE,
      field: 'content',
      actualBytes: 11,
      maximumBytes: 10,
    });
  });
});
