import { describe, expect, it, vi } from 'vitest';
import {
  CHROME_NATIVE_MESSAGE_MAX_INBOUND_BYTES,
  NativeMessageFrameDecoder,
  NativeMessageFramingError,
} from './native-message-framing';

function frame(body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

describe('NativeMessageFrameDecoder', () => {
  it('uses Chrome\'s 64 MiB inbound message limit', () => {
    expect(CHROME_NATIVE_MESSAGE_MAX_INBOUND_BYTES).toBe(64 * 1024 * 1024);
  });

  it('decodes fragmented headers and bodies in order', () => {
    const decoder = new NativeMessageFrameDecoder();
    const onFrame = vi.fn();
    const input = Buffer.concat([
      frame(Buffer.from('{"first":true}')),
      frame(Buffer.from('{"second":true}')),
    ]);

    for (const byte of input) {
      decoder.write(Buffer.from([byte]), onFrame);
    }

    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame.mock.calls.map(([body]) => body.toString())).toEqual([
      '{"first":true}',
      '{"second":true}',
    ]);
  });

  it('accepts a frame exactly at the configured limit', () => {
    const decoder = new NativeMessageFrameDecoder(8);
    const onFrame = vi.fn();

    decoder.write(frame(Buffer.from('12345678')), onFrame);

    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame.mock.calls[0][0].toString()).toBe('12345678');
  });

  it.each([0, 9])('rejects declared length %i and permanently fails closed', (length) => {
    const decoder = new NativeMessageFrameDecoder(8);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(length, 0);

    expect(() => decoder.write(header, vi.fn())).toThrowError(NativeMessageFramingError);
    expect(() => decoder.write(frame(Buffer.from('ok')), vi.fn())).toThrow(
      'cannot be reused after a framing error',
    );
  });
});
