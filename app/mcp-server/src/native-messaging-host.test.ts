import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CHROME_NATIVE_MESSAGE_MAX_OUTBOUND_BYTES,
  NativeMessageWriter,
} from './native-message-output';
import { NativeMessagingHost } from './native-messaging-host';

class FailingWritable extends Writable {
  public _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(new Error('broken pipe'));
  }
}

class CollectingWritable extends Writable {
  public readonly chunks: Buffer[] = [];

  public _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function decodeFrame(frame: Buffer): Record<string, unknown> {
  const length = frame.readUInt32LE(0);
  expect(length).toBe(frame.length - 4);
  return JSON.parse(frame.subarray(4).toString()) as Record<string, unknown>;
}

describe('NativeMessagingHost outbound requests', () => {
  it('rejects a pending request immediately when stdout fails', async () => {
    const host = new NativeMessagingHost(new NativeMessageWriter(new FailingWritable()));

    await expect(
      host.sendRequestToExtensionAndWait({ query: 'hello' }, 'request_data', 10_000),
    ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
  });

  it('rejects an oversized pending request instead of waiting for timeout', async () => {
    const host = new NativeMessagingHost(
      new NativeMessageWriter(new Writable({ write: (_chunk, _encoding, callback) => callback() })),
    );

    await expect(
      host.sendRequestToExtensionAndWait(
        { value: 'x'.repeat(1024 * 1024) },
        'request_data',
        10_000,
      ),
    ).rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' });
  });

  it('replaces an oversized response with a compact protocol error', async () => {
    const output = new CollectingWritable();
    const host = new NativeMessagingHost(new NativeMessageWriter(output));

    host.sendMessage({
      responseToRequestId: 'extension-request',
      payload: 'x'.repeat(CHROME_NATIVE_MESSAGE_MAX_OUTBOUND_BYTES),
    });

    await vi.waitFor(() => expect(output.chunks).toHaveLength(1));
    expect(decodeFrame(output.chunks[0])).toMatchObject({
      responseToRequestId: 'extension-request',
      error: expect.stringContaining('could not encode response'),
    });
  });
});
