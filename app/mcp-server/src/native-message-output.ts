import type { Writable } from 'node:stream';

export const CHROME_NATIVE_MESSAGE_MAX_OUTBOUND_BYTES = 1024 * 1024;
export const DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

type NativeMessageEncodingErrorCode = 'SERIALIZATION_FAILED' | 'MESSAGE_TOO_LARGE';
type NativeMessageOutputErrorCode =
  | NativeMessageEncodingErrorCode
  | 'OUTPUT_QUEUE_FULL'
  | 'OUTPUT_CLOSED'
  | 'OUTPUT_WRITE_FAILED';

export class NativeMessageOutputError extends Error {
  public constructor(
    public readonly code: NativeMessageOutputErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NativeMessageOutputError';
  }
}

export function isNativeMessageEncodingError(error: unknown): boolean {
  return (
    error instanceof NativeMessageOutputError &&
    (error.code === 'SERIALIZATION_FAILED' || error.code === 'MESSAGE_TOO_LARGE')
  );
}

interface QueuedWrite {
  frame: Buffer;
  resolve: () => void;
  reject: (error: Error) => void;
  coalesceKey?: string;
  terminal: boolean;
}

export interface NativeMessageSendOptions {
  /** Replace an older queued (not yet active) frame with the same logical key. */
  coalesceKey?: string;
  /** Preserve this frame by evicting stale coalescible frames when necessary. */
  terminal?: boolean;
}

function encodeNativeMessage(message: unknown, maximumMessageBytes: number): Buffer {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(message);
  } catch (error) {
    throw new NativeMessageOutputError(
      'SERIALIZATION_FAILED',
      'Failed to serialize native message',
      error,
    );
  }

  if (serialized === undefined) {
    throw new NativeMessageOutputError(
      'SERIALIZATION_FAILED',
      'Failed to serialize native message: JSON.stringify returned undefined',
    );
  }

  const body = Buffer.from(serialized);
  if (body.length > maximumMessageBytes) {
    throw new NativeMessageOutputError(
      'MESSAGE_TOO_LARGE',
      `Native message is ${body.length} bytes; Chrome accepts at most ${maximumMessageBytes} bytes from a native host`,
    );
  }

  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/**
 * Serializes writes to Chrome and honors Writable backpressure. A terminal
 * stream error rejects both the active write and everything queued behind it.
 */
export class NativeMessageWriter {
  private readonly queue: QueuedWrite[] = [];
  private activeWrite: QueuedWrite | null = null;
  private activeDrainListener: (() => void) | null = null;
  private queuedBytes = 0;
  private terminalError: Error | null = null;

  public constructor(
    private readonly output: Writable,
    private readonly maximumMessageBytes = CHROME_NATIVE_MESSAGE_MAX_OUTBOUND_BYTES,
    private readonly maximumQueuedBytes = DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_BYTES,
  ) {
    if (!Number.isSafeInteger(maximumMessageBytes) || maximumMessageBytes <= 0) {
      throw new RangeError('maximumMessageBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maximumQueuedBytes) || maximumQueuedBytes <= 4) {
      throw new RangeError('maximumQueuedBytes must be greater than the native message header');
    }

    output.on('error', this.handleOutputError);
    output.on('close', this.handleOutputClose);
  }

  public send(message: unknown, options: NativeMessageSendOptions = {}): Promise<void> {
    let frame: Buffer;
    try {
      frame = encodeNativeMessage(message, this.maximumMessageBytes);
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }

    const coalesceKey = options.coalesceKey?.trim() || undefined;
    const terminal = options.terminal === true;
    const matchingIndex = coalesceKey
      ? this.queue.findIndex((item) => item.coalesceKey === coalesceKey)
      : -1;
    const matching = matchingIndex >= 0 ? this.queue[matchingIndex] : undefined;

    // A late intermediate update cannot supersede an already queued final.
    if (matching?.terminal && !terminal) return Promise.resolve();

    const replacedBytes = matching?.frame.length ?? 0;
    // Every non-terminal producer observes the reserve. Request/response
    // frames are never evicted; they simply cannot consume the bytes reserved
    // for the final assistant snapshot and terminal status.
    const capacity = terminal
      ? this.maximumQueuedBytes
      : this.maximumQueuedBytes - this.terminalReserveBytes();
    const projectedBytes = this.queuedBytes - replacedBytes + frame.length;

    if (projectedBytes > capacity && terminal) {
      this.evictCoalescibleFrames(projectedBytes - capacity, matchingIndex);
    }

    if (this.queuedBytes - replacedBytes + frame.length > capacity) {
      return Promise.reject(
        new NativeMessageOutputError(
          'OUTPUT_QUEUE_FULL',
          `Native message output queue would exceed ${capacity} bytes`,
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      if (matching) {
        // The older frame is intentionally superseded and will never write.
        // Resolve it now so callback storage cannot grow with token count.
        matching.resolve();
        this.queuedBytes += frame.length - matching.frame.length;
        matching.frame = frame;
        matching.terminal = terminal;
        matching.resolve = resolve;
        matching.reject = reject;
      } else {
        this.queue.push({
          frame,
          resolve,
          reject,
          coalesceKey,
          terminal,
        });
        this.queuedBytes += frame.length;
      }
      this.pump();
    });
  }

  private terminalReserveBytes(): number {
    // Default configuration reserves one maximum-sized Chrome frame. For
    // deliberately tiny test/custom queues, reserve at most half the queue.
    return Math.min(this.maximumMessageBytes + 4, Math.floor(this.maximumQueuedBytes / 2));
  }

  private evictCoalescibleFrames(requiredBytes: number, excludedIndex: number): void {
    let releasedBytes = 0;
    for (let index = 0; index < this.queue.length && releasedBytes < requiredBytes; ) {
      if (index === excludedIndex) {
        index += 1;
        continue;
      }
      const item = this.queue[index];
      if (!item.coalesceKey || item.terminal) {
        index += 1;
        continue;
      }

      this.queue.splice(index, 1);
      this.queuedBytes -= item.frame.length;
      releasedBytes += item.frame.length;
      item.resolve();
      if (index < excludedIndex) excludedIndex -= 1;
    }
  }

  private readonly handleOutputError = (error: Error): void => {
    this.failTerminal(
      new NativeMessageOutputError('OUTPUT_WRITE_FAILED', 'Native message output failed', error),
    );
  };

  private readonly handleOutputClose = (): void => {
    this.failTerminal(
      new NativeMessageOutputError('OUTPUT_CLOSED', 'Native message output closed before write completed'),
    );
  };

  private pump(): void {
    if (this.activeWrite || this.terminalError) {
      return;
    }

    const item = this.queue.shift();
    if (!item) {
      return;
    }
    this.activeWrite = item;

    let callbackComplete = false;
    let drainComplete = true;
    let writeReturned = false;

    const completeIfReady = (): void => {
      if (!writeReturned || !callbackComplete || !drainComplete || this.activeWrite !== item) {
        return;
      }
      this.clearActiveDrainListener();
      this.activeWrite = null;
      this.queuedBytes -= item.frame.length;
      item.resolve();
      this.pump();
    };

    const onDrain = (): void => {
      this.activeDrainListener = null;
      drainComplete = true;
      completeIfReady();
    };

    try {
      const accepted = this.output.write(item.frame, (error?: Error | null) => {
        if (error) {
          this.failTerminal(
            new NativeMessageOutputError(
              'OUTPUT_WRITE_FAILED',
              'Native message output failed',
              error,
            ),
          );
          return;
        }
        callbackComplete = true;
        completeIfReady();
      });
      writeReturned = true;

      if (!accepted) {
        drainComplete = false;
        this.activeDrainListener = onDrain;
        this.output.once('drain', onDrain);
      }
      completeIfReady();
    } catch (error) {
      this.failTerminal(
        new NativeMessageOutputError('OUTPUT_WRITE_FAILED', 'Native message output failed', error),
      );
    }
  }

  private clearActiveDrainListener(): void {
    if (!this.activeDrainListener) {
      return;
    }
    this.output.removeListener('drain', this.activeDrainListener);
    this.activeDrainListener = null;
  }

  private failTerminal(error: Error): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    this.clearActiveDrainListener();

    if (this.activeWrite) {
      const active = this.activeWrite;
      this.activeWrite = null;
      this.queuedBytes -= active.frame.length;
      active.reject(error);
    }

    for (const item of this.queue.splice(0)) {
      this.queuedBytes -= item.frame.length;
      item.reject(error);
    }
  }
}
