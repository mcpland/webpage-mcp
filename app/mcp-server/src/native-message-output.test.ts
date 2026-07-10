import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CHROME_NATIVE_MESSAGE_MAX_OUTBOUND_BYTES,
  NativeMessageOutputError,
  NativeMessageWriter,
} from './native-message-output';

class ControlledWritable extends Writable {
  public readonly chunks: Buffer[] = [];
  private readonly completions: Array<(error?: Error | null) => void> = [];

  public constructor() {
    super({ highWaterMark: 1 });
  }

  public completeNext(error?: Error): void {
    const complete = this.completions.shift();
    if (!complete) {
      throw new Error('No pending write');
    }
    complete(error);
  }

  public _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    this.completions.push(callback);
  }
}

function decodeFrame(frame: Buffer): unknown {
  const length = frame.readUInt32LE(0);
  expect(length).toBe(frame.length - 4);
  return JSON.parse(frame.subarray(4).toString());
}

describe('NativeMessageWriter', () => {
  it('uses Chrome\'s 1 MiB outbound message limit', () => {
    expect(CHROME_NATIVE_MESSAGE_MAX_OUTBOUND_BYTES).toBe(1024 * 1024);
  });

  it('serializes writes and waits for backpressure to drain', async () => {
    const output = new ControlledWritable();
    const writer = new NativeMessageWriter(output);

    const first = writer.send({ order: 1 });
    const second = writer.send({ order: 2 });

    expect(output.chunks).toHaveLength(1);
    output.completeNext();
    await first;

    await vi.waitFor(() => expect(output.chunks).toHaveLength(2));
    output.completeNext();
    await second;

    expect(output.chunks.map(decodeFrame)).toEqual([{ order: 1 }, { order: 2 }]);
  });

  it('accepts exactly 1 MiB but rejects larger and unserializable messages before writing', async () => {
    const output = new ControlledWritable();
    const writer = new NativeMessageWriter(output);
    const exactlyAtLimit = 'x'.repeat(CHROME_NATIVE_MESSAGE_MAX_OUTBOUND_BYTES - 2);

    const accepted = writer.send(exactlyAtLimit);
    expect(output.chunks).toHaveLength(1);
    output.completeNext();
    await accepted;

    await expect(writer.send(`${exactlyAtLimit}x`)).rejects.toMatchObject<NativeMessageOutputError>({
      code: 'MESSAGE_TOO_LARGE',
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(writer.send(circular)).rejects.toMatchObject<NativeMessageOutputError>({
      code: 'SERIALIZATION_FAILED',
    });
    expect(output.chunks).toHaveLength(1);
  });

  it('rejects the active and queued writes after an output error', async () => {
    const output = new ControlledWritable();
    const writer = new NativeMessageWriter(output);
    const first = writer.send({ order: 1 });
    const second = writer.send({ order: 2 });

    output.completeNext(new Error('broken pipe'));

    await expect(first).rejects.toMatchObject<NativeMessageOutputError>({
      code: 'OUTPUT_WRITE_FAILED',
    });
    await expect(second).rejects.toMatchObject<NativeMessageOutputError>({
      code: 'OUTPUT_WRITE_FAILED',
    });
    await expect(writer.send({ order: 3 })).rejects.toMatchObject<NativeMessageOutputError>({
      code: 'OUTPUT_WRITE_FAILED',
    });
    expect(output.chunks).toHaveLength(1);
  });
});
