export const DIAGNOSTIC_REDACTED = '[REDACTED]';
export const DIAGNOSTIC_CHUNK_MAX_BYTES = 32 * 1024;
export const DIAGNOSTIC_LINE_MAX_BYTES = 8 * 1024;
export const DIAGNOSTIC_ERROR_MAX_BYTES = 32 * 1024;
export const DIAGNOSTIC_BUFFER_MAX_BYTES = 64 * 1024;
export const DIAGNOSTIC_BUFFER_MAX_LINES = 64;
export const DIAGNOSTIC_CHUNK_MAX_LINES = 64;

const TRUNCATION_MARKER = ' … [truncated]';
const OUTPUT_TRUNCATION_MARKER = '[diagnostic output truncated]';
const MAX_REDACTION_INPUT_BYTES = 64 * 1024;

interface BoundedText {
  text: string;
  bytes: number;
  truncated: boolean;
}

function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function boundString(value: string, maximumBytes: number): BoundedText {
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const codePoint = value.codePointAt(end) ?? 0xfffd;
    const width = utf8Width(codePoint);
    if (bytes + width > maximumBytes) {
      return { text: value.slice(0, end), bytes, truncated: true };
    }
    bytes += width;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return { text: value, bytes, truncated: false };
}

function boundBuffer(value: Buffer, maximumBytes: number): BoundedText {
  if (value.length <= maximumBytes) {
    const text = value.toString('utf8');
    return { text, bytes: value.length, truncated: false };
  }
  let text = value.subarray(0, maximumBytes).toString('utf8');
  if (text.endsWith('\uFFFD')) {
    text = text.slice(0, -1);
  }
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    truncated: true,
  };
}

function coerceBoundedText(value: unknown, maximumBytes: number): BoundedText {
  if (Buffer.isBuffer(value)) return boundBuffer(value, maximumBytes);
  if (value instanceof Error) {
    try {
      return boundString(value.message, maximumBytes);
    } catch {
      return boundString('[unreadable diagnostic error]', maximumBytes);
    }
  }
  if (typeof value === 'string') return boundString(value, maximumBytes);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return boundString(String(value), maximumBytes);
  }
  if (value === null || value === undefined) {
    return boundString(String(value), maximumBytes);
  }
  return boundString('[non-string diagnostic]', maximumBytes);
}

function sanitizeControls(value: string): string {
  const output: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 13 && value.charCodeAt(index + 1) === 10) {
      output.push('\n');
      index += 1;
    } else if (code === 10 || code === 9) {
      output.push(value[index]);
    } else if (
      code === 13 ||
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    ) {
      output.push('\uFFFD');
    } else {
      output.push(value[index]);
    }
  }
  return output.join('');
}

const SENSITIVE_ASSIGNMENT = new RegExp(
  String.raw`(\b(?:[a-z0-9_.-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd)|cookie|set-cookie)\b\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&\]]+)`,
  'gi',
);

const SENSITIVE_CLI_ARGUMENT = new RegExp(
  String.raw`((?:--)(?:api[_-]?key|access[_-]?key|auth[_-]?token|token|secret|password|cookie)\s+)(?:"[^"]*"|'[^']*'|\S+)`,
  'gi',
);

const KNOWN_SECRET =
  /\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{8,}|github_pat_[a-z0-9_]{8,}|gh[pousr]_[a-z0-9]{8,}|xox[baprs]-[a-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/gi;
const JWT_SECRET = /\b[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/gi;

function redactPatterns(value: string): string {
  let redacted = value;
  redacted = redacted.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi,
    `$1${DIAGNOSTIC_REDACTED}@`,
  );
  redacted = redacted.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s@:]+):([^/\s@]+)$/gi,
    (match, scheme: string, _user: string, password: string) =>
      /^\d{1,5}$/.test(password) ? match : `${scheme}${DIAGNOSTIC_REDACTED}`,
  );
  redacted = redacted.replace(
    /(\bAuthorization\b\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,}]*?)(?=\s+\|\s+|$|[\r\n,}])/gi,
    `$1${DIAGNOSTIC_REDACTED}`,
  );
  redacted = redacted.replace(
    /(\b(?:Set-Cookie|Cookie)\b\s*:\s*)[^\r\n]*?(?=\s+\|\s+|$|[\r\n])/gi,
    `$1${DIAGNOSTIC_REDACTED}`,
  );
  redacted = redacted.replace(
    /(\bBearer\s+)[^\s,"'}]+/gi,
    `$1${DIAGNOSTIC_REDACTED}`,
  );
  redacted = redacted.replace(SENSITIVE_ASSIGNMENT, `$1${DIAGNOSTIC_REDACTED}`);
  redacted = redacted.replace(SENSITIVE_CLI_ARGUMENT, `$1${DIAGNOSTIC_REDACTED}`);
  redacted = redacted.replace(KNOWN_SECRET, DIAGNOSTIC_REDACTED);
  redacted = redacted.replace(JWT_SECRET, DIAGNOSTIC_REDACTED);
  redacted = redacted.replace(/\[REDACTED\]\]+/g, DIAGNOSTIC_REDACTED);
  return redacted;
}

/** Bound before regex work, redact, sanitize controls, then enforce the output bound again. */
export function redactDiagnosticText(
  value: unknown,
  maximumBytes = DIAGNOSTIC_LINE_MAX_BYTES,
): string {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= Buffer.byteLength(TRUNCATION_MARKER, 'utf8') ||
    maximumBytes > MAX_REDACTION_INPUT_BYTES
  ) {
    throw new RangeError('maximumBytes is outside the diagnostic redaction range');
  }

  const bounded = coerceBoundedText(value, maximumBytes);
  let redacted = redactPatterns(sanitizeControls(bounded.text));
  if (bounded.truncated) {
    const prefix = boundString(
      redacted,
      maximumBytes - Buffer.byteLength(TRUNCATION_MARKER, 'utf8'),
    );
    redacted = `${prefix.text}${TRUNCATION_MARKER}`;
  }
  return boundString(redacted, maximumBytes).text;
}

export function createRedactedDiagnosticError(
  value: unknown,
  maximumBytes = DIAGNOSTIC_ERROR_MAX_BYTES,
): Error {
  const message = redactDiagnosticText(value, maximumBytes);
  const error = new Error(message || 'Diagnostic error');
  if (value instanceof Error) {
    try {
      error.name = redactDiagnosticText(value.name, 256) || 'Error';
    } catch {
      error.name = 'Error';
    }
  }
  return error;
}

/**
 * Incrementally stage a bounded raw stderr line, then retain only redacted
 * lines. The raw staging area never exceeds DIAGNOSTIC_LINE_MAX_BYTES.
 */
export class BoundedDiagnosticBuffer {
  private pending = '';
  private pendingBytes = 0;
  private lineTruncated = false;
  private discardingLine = false;
  private readonly retainedLines: string[] = [];
  private retainedBytes = 0;

  push(value: string | Buffer): string[] {
    const bounded = coerceBoundedText(value, DIAGNOSTIC_CHUNK_MAX_BYTES);
    const emitted: string[] = [];
    let offset = 0;

    while (offset < bounded.text.length) {
      if (emitted.length >= DIAGNOSTIC_CHUNK_MAX_LINES - 1) {
        this.pending = '';
        this.pendingBytes = 0;
        this.lineTruncated = false;
        this.discardingLine = true;
        this.storeLine(OUTPUT_TRUNCATION_MARKER);
        emitted.push(OUTPUT_TRUNCATION_MARKER);
        return emitted;
      }

      const newline = bounded.text.indexOf('\n', offset);
      const end = newline === -1 ? bounded.text.length : newline;
      this.appendSegment(bounded.text.slice(offset, end));
      if (newline === -1) break;

      const line = this.consumePendingLine();
      if (line) emitted.push(line);
      offset = newline + 1;
    }

    if (bounded.truncated) {
      this.lineTruncated = true;
      this.discardingLine = true;
    }
    return emitted;
  }

  flush(): string[] {
    const line = this.consumePendingLine();
    return line ? [line] : [];
  }

  snapshot(): string[] {
    const pending = this.renderPendingLine();
    return this.fitLines(pending ? [...this.retainedLines, pending] : [...this.retainedLines]);
  }

  private appendSegment(segment: string): void {
    if (!segment || this.discardingLine) return;
    const remaining = DIAGNOSTIC_LINE_MAX_BYTES - this.pendingBytes;
    const bounded = boundString(segment, remaining);
    this.pending += bounded.text;
    this.pendingBytes += bounded.bytes;
    if (bounded.truncated) {
      this.lineTruncated = true;
      this.discardingLine = true;
    }
  }

  private renderPendingLine(): string | null {
    const raw = this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending;
    if (!raw && !this.lineTruncated) return null;
    let line = redactDiagnosticText(raw, DIAGNOSTIC_LINE_MAX_BYTES).trimEnd();
    if (this.lineTruncated) {
      const prefix = boundString(
        line,
        DIAGNOSTIC_LINE_MAX_BYTES - Buffer.byteLength(TRUNCATION_MARKER, 'utf8'),
      );
      line = `${prefix.text}${TRUNCATION_MARKER}`;
    }
    return line || (this.lineTruncated ? TRUNCATION_MARKER.trim() : null);
  }

  private consumePendingLine(): string | null {
    const line = this.renderPendingLine();
    this.pending = '';
    this.pendingBytes = 0;
    this.lineTruncated = false;
    this.discardingLine = false;
    if (line) this.storeLine(line);
    return line;
  }

  private storeLine(line: string): void {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.retainedLines.length > 0) this.retainedBytes += 1;
    this.retainedLines.push(line);
    this.retainedBytes += bytes;
    while (
      this.retainedLines.length > DIAGNOSTIC_BUFFER_MAX_LINES ||
      this.retainedBytes > DIAGNOSTIC_BUFFER_MAX_BYTES
    ) {
      const removed = this.retainedLines.shift();
      if (!removed) break;
      this.retainedBytes -= Buffer.byteLength(removed, 'utf8');
      if (this.retainedLines.length > 0) this.retainedBytes -= 1;
    }
  }

  private fitLines(lines: string[]): string[] {
    let bytes =
      lines.reduce((total, line) => total + Buffer.byteLength(line, 'utf8'), 0) +
      Math.max(0, lines.length - 1);
    while (lines.length > DIAGNOSTIC_BUFFER_MAX_LINES || bytes > DIAGNOSTIC_BUFFER_MAX_BYTES) {
      const removed = lines.shift();
      if (!removed) break;
      bytes -= Buffer.byteLength(removed, 'utf8');
      if (lines.length > 0) bytes -= 1;
    }
    return lines;
  }
}
