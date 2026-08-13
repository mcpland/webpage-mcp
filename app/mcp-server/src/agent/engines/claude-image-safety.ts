import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAttachment } from 'webpage-mcp-shared';
import { decodeValidatedAgentAttachment } from '../attachment-limits';

const HEADER_BYTES = 12;
const MAX_READ_PATH_BYTES = 8 * 1024;
const MAX_TOOL_RESPONSE_DEPTH = 32;
const MAX_TOOL_RESPONSE_KEYS = 256;
const MAX_TOOL_RESPONSE_NODES = 4_096;
const BASE64_HEADER_CHARACTERS = 24;

export type UnsafeClaudeImageFormat = 'GIF' | 'TIFF' | 'VIPS';

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Detect formats covered by GHSA-f88m-g3jw-g9cj without invoking an image
 * decoder. Claude Code currently embeds an affected Sharp release, so these
 * formats must not reach its image loader until the upstream binary is fixed.
 */
export function detectUnsafeClaudeImageFormat(
  bytes: Uint8Array,
): UnsafeClaudeImageFormat | undefined {
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'GIF';
  }
  if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]) ||
    startsWith(bytes, [0x49, 0x49, 0x2b, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2b])
  ) {
    return 'TIFF';
  }
  if (startsWith(bytes, [0xb6, 0xa6, 0xf2, 0x08]) || startsWith(bytes, [0x08, 0xf2, 0xa6, 0xb6])) {
    return 'VIPS';
  }
  return undefined;
}

function unsafeImageError(format: UnsafeClaudeImageFormat): Error {
  return new Error(
    `ClaudeEngine: ${format} images are temporarily blocked because the bundled image runtime is not patched`,
  );
}

export function assertClaudeSafeAttachment(attachment: AgentAttachment): void {
  const format = detectUnsafeClaudeImageFormat(decodeValidatedAgentAttachment(attachment));
  if (format) throw unsafeImageError(format);
}

async function inspectClaudeImageFile(
  filePath: string,
): Promise<UnsafeClaudeImageFormat | undefined> {
  let flags = fsConstants.O_RDONLY;
  if (typeof fsConstants.O_NONBLOCK === 'number') {
    flags |= fsConstants.O_NONBLOCK;
  }
  const handle = await open(filePath, flags);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;
    const header = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return detectUnsafeClaudeImageFormat(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function assertClaudeSafeImagePath(filePath: string): Promise<void> {
  let format: UnsafeClaudeImageFormat | undefined;
  try {
    format = await inspectClaudeImageFile(filePath);
  } catch {
    throw new Error('ClaudeEngine: image attachment could not be inspected safely');
  }
  if (format) throw unsafeImageError(format);
}

function readToolPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  const filePath = record.file_path ?? record.path;
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    Buffer.byteLength(filePath) > MAX_READ_PATH_BYTES ||
    filePath.includes('\0')
  ) {
    return;
  }
  return filePath;
}

export interface ClaudePreToolUseInput {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}

function denyClaudeImageRead(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** Deny vulnerable image formats before Claude Code's built-in Read executes. */
export async function enforceClaudeImageReadSafety(
  input: ClaudePreToolUseInput,
): Promise<Record<string, unknown>> {
  if (
    input.hook_event_name !== 'PreToolUse' ||
    typeof input.tool_name !== 'string' ||
    !new Set(['read', 'read_file']).has(input.tool_name.toLowerCase())
  ) {
    return {};
  }
  const requestedPath = readToolPath(input.tool_input);
  if (!requestedPath) return {};
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const absolutePath = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(cwd, requestedPath);

  let format: UnsafeClaudeImageFormat | undefined;
  try {
    format = await inspectClaudeImageFile(absolutePath);
  } catch {
    return denyClaudeImageRead('ClaudeEngine: Read target could not be inspected safely');
  }
  if (!format) return {};
  return denyClaudeImageRead(unsafeImageError(format).message);
}

function decodeBase64Header(value: string): {
  header?: Uint8Array;
  inspectable: boolean;
} {
  let encoded = value;
  if (/^data:/i.test(encoded)) {
    const comma = encoded.indexOf(',');
    if (comma <= 0 || comma > 256 || !/;base64$/i.test(encoded.slice(0, comma))) {
      return { inspectable: false };
    }
    encoded = encoded.slice(comma + 1);
  }

  let prefix = '';
  let examined = 0;
  for (const character of encoded) {
    examined += character.length;
    if (examined > 512) return { inspectable: false };
    if (/\s/.test(character)) continue;
    if (!/[A-Za-z0-9+/=]/.test(character)) {
      return { inspectable: false };
    }
    prefix += character;
    if (prefix.length >= BASE64_HEADER_CHARACTERS) break;
    if (character === '=') break;
  }
  if (prefix.length < 4) return { inspectable: false };
  return {
    header: Buffer.from(prefix, 'base64').subarray(0, HEADER_BYTES),
    inspectable: true,
  };
}

interface ClaudePostToolUseInput {
  hook_event_name?: unknown;
  tool_response?: unknown;
}

interface ToolResponseScan {
  format?: UnsafeClaudeImageFormat;
  exceededLimit: boolean;
}

function scanToolResponseForUnsafeImage(root: unknown): ToolResponseScan {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let exceededLimit = false;
  const visit = (value: unknown, depth: number): UnsafeClaudeImageFormat | undefined => {
    nodes += 1;
    if (nodes > MAX_TOOL_RESPONSE_NODES || depth > MAX_TOOL_RESPONSE_DEPTH) {
      exceededLimit = true;
      return undefined;
    }
    if (!value || typeof value !== 'object') return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
      if (value.length > MAX_TOOL_RESPONSE_KEYS) {
        exceededLimit = true;
        return undefined;
      }
      for (const item of value) {
        const format = visit(item, depth + 1);
        if (format) return format;
        if (nodes > MAX_TOOL_RESPONSE_NODES) return undefined;
      }
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > MAX_TOOL_RESPONSE_KEYS) {
      exceededLimit = true;
      return undefined;
    }
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    if ((type === 'image' || type === 'base64') && typeof record.data === 'string') {
      const decoded = decodeBase64Header(record.data);
      if (!decoded.inspectable) {
        exceededLimit = true;
        return undefined;
      }
      const format = decoded.header ? detectUnsafeClaudeImageFormat(decoded.header) : undefined;
      if (format) return format;
    }
    for (const key of keys) {
      const format = visit(record[key], depth + 1);
      if (format) return format;
      if (nodes > MAX_TOOL_RESPONSE_NODES) return undefined;
    }
    return undefined;
  };

  const format = visit(root, 0);
  return {
    ...(format ? { format } : {}),
    exceededLimit,
  };
}

/** Replace unsafe MCP image results before Claude Code sends them to the model. */
export async function enforceClaudeToolResultImageSafety(
  input: ClaudePostToolUseInput,
): Promise<Record<string, unknown>> {
  if (input.hook_event_name !== 'PostToolUse') return {};
  const scan = scanToolResponseForUnsafeImage(input.tool_response);
  if (!scan.format && !scan.exceededLimit) return {};
  const message = scan.format
    ? unsafeImageError(scan.format).message
    : 'ClaudeEngine: tool output exceeded image safety inspection limits';
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: {
        content: [{ type: 'text', text: message }],
        isError: true,
      },
    },
  };
}
