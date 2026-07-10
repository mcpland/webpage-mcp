export const CHROME_NATIVE_MESSAGE_MAX_INBOUND_BYTES = 64 * 1024 * 1024;

const NATIVE_MESSAGE_HEADER_BYTES = 4;

export class NativeMessageFramingError extends Error {
  public constructor(
    public readonly declaredLength: number,
    public readonly maximumLength: number,
  ) {
    super(`Invalid native message length: ${declaredLength} (maximum ${maximumLength})`);
    this.name = 'NativeMessageFramingError';
  }
}

/**
 * Incrementally decodes Chrome Native Messaging frames without repeatedly
 * concatenating all bytes received so far. At most one declared message body
 * and the four-byte header are retained between writes.
 */
export class NativeMessageFrameDecoder {
  private readonly header = Buffer.allocUnsafe(NATIVE_MESSAGE_HEADER_BYTES);
  private headerBytes = 0;
  private body: Buffer | null = null;
  private bodyBytes = 0;
  private failed = false;

  public constructor(
    private readonly maximumMessageBytes = CHROME_NATIVE_MESSAGE_MAX_INBOUND_BYTES,
  ) {
    if (!Number.isSafeInteger(maximumMessageBytes) || maximumMessageBytes <= 0) {
      throw new RangeError('maximumMessageBytes must be a positive safe integer');
    }
  }

  public write(chunk: Buffer, onFrame: (frame: Buffer) => void): void {
    if (this.failed) {
      throw new Error('Native message decoder cannot be reused after a framing error');
    }

    let offset = 0;
    while (offset < chunk.length) {
      if (this.body === null) {
        const headerBytesNeeded = NATIVE_MESSAGE_HEADER_BYTES - this.headerBytes;
        const headerBytesAvailable = Math.min(headerBytesNeeded, chunk.length - offset);
        chunk.copy(
          this.header,
          this.headerBytes,
          offset,
          offset + headerBytesAvailable,
        );
        this.headerBytes += headerBytesAvailable;
        offset += headerBytesAvailable;

        if (this.headerBytes < NATIVE_MESSAGE_HEADER_BYTES) {
          continue;
        }

        const declaredLength = this.header.readUInt32LE(0);
        this.headerBytes = 0;
        if (declaredLength <= 0 || declaredLength > this.maximumMessageBytes) {
          this.failed = true;
          throw new NativeMessageFramingError(declaredLength, this.maximumMessageBytes);
        }

        this.body = Buffer.allocUnsafe(declaredLength);
        this.bodyBytes = 0;
      }

      const bodyBytesNeeded = this.body.length - this.bodyBytes;
      const bodyBytesAvailable = Math.min(bodyBytesNeeded, chunk.length - offset);
      chunk.copy(this.body, this.bodyBytes, offset, offset + bodyBytesAvailable);
      this.bodyBytes += bodyBytesAvailable;
      offset += bodyBytesAvailable;

      if (this.bodyBytes === this.body.length) {
        const completeFrame = this.body;
        this.body = null;
        this.bodyBytes = 0;
        onFrame(completeFrame);
      }
    }
  }
}
