import type { AgentAttachment } from 'webpage-mcp-shared';

export const MAX_AGENT_ATTACHMENTS_PER_REQUEST = 4;
export const MAX_AGENT_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_AGENT_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_AGENT_ATTACHMENT_BYTES / 3) * 4;
export const MAX_AGENT_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_AGENT_ATTACHMENT_NAME_LENGTH = 255;
export const MAX_PROJECT_ATTACHMENT_BYTES = 256 * 1024 * 1024;
export const MAX_PROJECT_ATTACHMENT_FILES = 500;

export const ALLOWED_AGENT_ATTACHMENT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function isBase64Character(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  );
}

function decodedBase64Length(value: string): number | null {
  if (!value || value.length % 4 !== 0) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    if (!isBase64Character(value.charCodeAt(index))) return null;
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }
  const finalDataCharacter = value[value.length - padding - 1];
  const finalValue = BASE64_ALPHABET.indexOf(finalDataCharacter);
  if ((padding === 2 && (finalValue & 0x0f) !== 0) || (padding === 1 && (finalValue & 0x03) !== 0)) {
    return null;
  }
  return (value.length / 4) * 3 - padding;
}

export function validateAgentAttachments(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return 'attachments must be an array';
  if (value.length > MAX_AGENT_ATTACHMENTS_PER_REQUEST) {
    return `attachments may contain at most ${MAX_AGENT_ATTACHMENTS_PER_REQUEST} images`;
  }

  let totalBytes = 0;
  for (const attachment of value) {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      return 'attachments must contain objects';
    }
    const record = attachment as Record<string, unknown>;
    if (record.type !== 'image') return 'Only image attachments are supported';
    if (
      typeof record.name !== 'string' ||
      typeof record.mimeType !== 'string' ||
      typeof record.dataBase64 !== 'string'
    ) {
      return 'image attachments require name, mimeType, and dataBase64';
    }
    const name = record.name.trim();
    if (!name || name.length > MAX_AGENT_ATTACHMENT_NAME_LENGTH) {
      return `attachment names must be between 1 and ${MAX_AGENT_ATTACHMENT_NAME_LENGTH} characters`;
    }
    if (!ALLOWED_AGENT_ATTACHMENT_MIME_TYPES.has(record.mimeType)) {
      return `Unsupported MIME type: ${record.mimeType}`;
    }
    if (record.dataBase64.length > MAX_AGENT_ATTACHMENT_BASE64_LENGTH) {
      return `attachment ${name} exceeds the ${MAX_AGENT_ATTACHMENT_BYTES}-byte limit`;
    }
    const decodedBytes = decodedBase64Length(record.dataBase64);
    if (decodedBytes === null) return `attachment ${name} contains invalid base64 data`;
    if (decodedBytes > MAX_AGENT_ATTACHMENT_BYTES) {
      return `attachment ${name} exceeds the ${MAX_AGENT_ATTACHMENT_BYTES}-byte limit`;
    }
    totalBytes += decodedBytes;
    if (totalBytes > MAX_AGENT_ATTACHMENTS_TOTAL_BYTES) {
      return `attachments exceed the ${MAX_AGENT_ATTACHMENTS_TOTAL_BYTES}-byte total limit`;
    }
  }
  return undefined;
}

export function decodeValidatedAgentAttachment(attachment: AgentAttachment): Buffer {
  const error = validateAgentAttachments([attachment]);
  if (error) throw new Error(error);
  const decoded = Buffer.from(attachment.dataBase64, 'base64');
  if (decoded.toString('base64') !== attachment.dataBase64) {
    throw new Error(`attachment ${attachment.name.trim()} contains invalid base64 data`);
  }
  return decoded;
}
