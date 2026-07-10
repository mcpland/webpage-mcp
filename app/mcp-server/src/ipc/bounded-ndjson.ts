export class IpcLineTooLargeError extends Error {
  constructor(maxLineBytes: number) {
    super(`IPC line exceeds the ${maxLineBytes}-byte limit`);
    this.name = 'IpcLineTooLargeError';
  }
}

/**
 * Incrementally decodes newline-delimited UTF-8 without repeatedly copying the
 * full partial line. Each retained segment is copied once so a small slice does
 * not keep an arbitrarily large socket chunk alive.
 */
export class BoundedNdjsonDecoder {
  private readonly segments: Buffer[] = [];
  private lineBytes = 0;

  constructor(private readonly maxLineBytes: number) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new Error('maxLineBytes must be a positive safe integer');
    }
  }

  get bufferedBytes(): number {
    return this.lineBytes;
  }

  push(chunk: Buffer | string): string[] {
    const input = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    const lines: string[] = [];
    let offset = 0;

    while (offset < input.length) {
      const newlineIndex = input.indexOf(0x0a, offset);
      const segmentEnd = newlineIndex === -1 ? input.length : newlineIndex;
      this.append(input.subarray(offset, segmentEnd));

      if (newlineIndex === -1) {
        break;
      }

      lines.push(this.consumeLine());
      offset = newlineIndex + 1;
    }

    return lines;
  }

  reset(): void {
    this.segments.length = 0;
    this.lineBytes = 0;
  }

  private append(segment: Buffer): void {
    if (segment.length === 0) {
      return;
    }
    if (this.lineBytes + segment.length > this.maxLineBytes) {
      this.reset();
      throw new IpcLineTooLargeError(this.maxLineBytes);
    }
    this.segments.push(Buffer.from(segment));
    this.lineBytes += segment.length;
  }

  private consumeLine(): string {
    const line =
      this.segments.length === 0
        ? Buffer.alloc(0)
        : this.segments.length === 1
          ? this.segments[0]
          : Buffer.concat(this.segments, this.lineBytes);
    this.reset();
    return line.toString('utf8').trim();
  }
}
