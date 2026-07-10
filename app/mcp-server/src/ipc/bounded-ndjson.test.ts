import { describe, expect, it } from 'vitest';
import { BoundedNdjsonDecoder, IpcLineTooLargeError } from './bounded-ndjson';

describe('BoundedNdjsonDecoder', () => {
  it('decodes fragmented UTF-8 lines and preserves a partial trailing line', () => {
    const decoder = new BoundedNdjsonDecoder(64);
    const encoded = Buffer.from('{"value":"你好"}\n{"next":true}\npartial', 'utf8');

    expect(decoder.push(encoded.subarray(0, 11))).toEqual([]);
    expect(decoder.push(encoded.subarray(11, 23))).toEqual(['{"value":"你好"}']);
    expect(decoder.push(encoded.subarray(23))).toEqual(['{"next":true}']);
    expect(decoder.bufferedBytes).toBe(Buffer.byteLength('partial'));
  });

  it('rejects an oversized line even when it arrives in fragments', () => {
    const decoder = new BoundedNdjsonDecoder(8);
    expect(decoder.push('1234')).toEqual([]);
    expect(() => decoder.push('56789')).toThrow(IpcLineTooLargeError);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('allows many bounded lines without retaining completed data', () => {
    const decoder = new BoundedNdjsonDecoder(8);
    expect(decoder.push('a\nbb\nccc\n')).toEqual(['a', 'bb', 'ccc']);
    expect(decoder.bufferedBytes).toBe(0);
  });
});
