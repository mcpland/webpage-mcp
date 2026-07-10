export const DEFAULT_NATIVE_DIRECTIVE_MAX_QUEUED_BYTES = 32 * 1024 * 1024;

export class NativeDirectiveQueueOverflowError extends Error {
  public constructor(public readonly maximumPending: number) {
    super(`Native directive queue exceeds the ${maximumPending}-message limit`);
    this.name = 'NativeDirectiveQueueOverflowError';
  }
}

export class NativeDirectiveQueueByteOverflowError extends Error {
  public constructor(
    public readonly itemBytes: number,
    public readonly pendingBytes: number,
    public readonly maximumQueuedBytes: number,
  ) {
    super(
      `Native directive queue cannot retain ${itemBytes} more bytes ` +
        `(${pendingBytes} of ${maximumQueuedBytes} bytes already pending)`,
    );
    this.name = 'NativeDirectiveQueueByteOverflowError';
  }
}

export class NativeDirectiveQueueEncodingError extends Error {
  public constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NativeDirectiveQueueEncodingError';
  }
}

export class NativeDirectiveQueueClosedError extends Error {
  public constructor() {
    super('Native directive queue is closed');
    this.name = 'NativeDirectiveQueueClosedError';
  }
}

interface PendingDirective<T> {
  item: T;
  byteLength: number;
}

function serializedByteLength(item: unknown): number {
  if (Buffer.isBuffer(item)) {
    return item.byteLength;
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(item);
  } catch (error) {
    throw new NativeDirectiveQueueEncodingError('Failed to serialize native directive for queue accounting', error);
  }

  if (serialized === undefined) {
    throw new NativeDirectiveQueueEncodingError(
      'Failed to serialize native directive for queue accounting: JSON.stringify returned undefined',
    );
  }

  return Buffer.byteLength(serialized, 'utf8');
}

/** A count- and byte-bounded, serial async queue for state-mutating native directives. */
export class NativeDirectiveQueue<T> {
  private readonly queue: Array<PendingDirective<T>> = [];
  private active: PendingDirective<T> | null = null;
  private retainedBytes = 0;
  private closed = false;

  public constructor(
    private readonly maximumPending: number,
    private readonly handler: (item: T) => Promise<void>,
    private readonly onHandlerError: (error: unknown) => void,
    private readonly maximumQueuedBytes = DEFAULT_NATIVE_DIRECTIVE_MAX_QUEUED_BYTES,
  ) {
    if (!Number.isSafeInteger(maximumPending) || maximumPending <= 0) {
      throw new RangeError('maximumPending must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maximumQueuedBytes) || maximumQueuedBytes <= 0) {
      throw new RangeError('maximumQueuedBytes must be a positive safe integer');
    }
  }

  /** Includes the directive currently being handled because it is still retained in memory. */
  public get pendingCount(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  /** Includes the directive currently being handled until its handler settles. */
  public get pendingBytes(): number {
    return this.retainedBytes;
  }

  public enqueue(item: T): void {
    if (this.closed) {
      throw new NativeDirectiveQueueClosedError();
    }
    if (this.pendingCount >= this.maximumPending) {
      throw new NativeDirectiveQueueOverflowError(this.maximumPending);
    }

    const byteLength = serializedByteLength(item);
    if (byteLength > this.maximumQueuedBytes - this.retainedBytes) {
      throw new NativeDirectiveQueueByteOverflowError(byteLength, this.retainedBytes, this.maximumQueuedBytes);
    }

    this.queue.push({ item, byteLength });
    this.retainedBytes += byteLength;
    this.drain();
  }

  /**
   * Stop accepting work and discard directives that have not started. An
   * active directive remains counted until its handler settles because its
   * memory cannot be released or cancelled by this queue.
   */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      this.retainedBytes -= item.byteLength;
    }
  }

  private drain(): void {
    if (this.closed || this.active) return;
    const next = this.queue.shift();
    if (!next) return;

    this.active = next;
    let handling: Promise<void>;
    try {
      handling = this.handler(next.item);
    } catch (error) {
      this.reportHandlerError(error);
      this.complete(next);
      return;
    }

    void Promise.resolve(handling)
      .catch((error) => {
        this.reportHandlerError(error);
      })
      .finally(() => {
        this.complete(next);
      });
  }

  private reportHandlerError(error: unknown): void {
    try {
      this.onHandlerError(error);
    } catch {
      // Error reporting must not stall the queue.
    }
  }

  private complete(item: PendingDirective<T>): void {
    if (this.active === item) {
      this.active = null;
      this.retainedBytes -= item.byteLength;
    }
    this.drain();
  }
}
