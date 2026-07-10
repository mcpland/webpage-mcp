import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_ATTACHMENT_BYTES,
  MAX_AGENT_ATTACHMENTS_PER_REQUEST,
  validateAgentAttachments,
} from './attachment-limits';

function image(dataBase64 = 'cG5n'): Record<string, unknown> {
  return { type: 'image', name: 'image.png', mimeType: 'image/png', dataBase64 };
}

describe('agent attachment request limits', () => {
  it('accepts supported canonical image data', () => {
    expect(validateAgentAttachments([image()])).toBeUndefined();
  });

  it('rejects unsupported MIME types and malformed base64', () => {
    expect(validateAgentAttachments([{ ...image(), mimeType: 'image/svg+xml' }])).toContain(
      'Unsupported MIME type',
    );
    expect(validateAgentAttachments([image('not base64')])).toContain('invalid base64');
    expect(validateAgentAttachments([image('AB==')])).toContain('invalid base64');
  });

  it('enforces attachment count and decoded byte limits before persistence', () => {
    expect(
      validateAgentAttachments(
        Array.from({ length: MAX_AGENT_ATTACHMENTS_PER_REQUEST + 1 }, () => image()),
      ),
    ).toContain(`at most ${MAX_AGENT_ATTACHMENTS_PER_REQUEST}`);

    const oversized = Buffer.alloc(MAX_AGENT_ATTACHMENT_BYTES + 1).toString('base64');
    expect(validateAgentAttachments([image(oversized)])).toContain(
      `${MAX_AGENT_ATTACHMENT_BYTES}-byte limit`,
    );
  });
});
