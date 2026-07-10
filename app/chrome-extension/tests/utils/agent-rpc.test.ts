import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { requestAgentRpcBlobInChunks, requestAgentRpcCollection } from '@/utils/agent-rpc';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readBlob(blob: Blob): Promise<Uint8Array> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error || new Error('Failed to read Blob'));
    reader.readAsArrayBuffer(blob);
  });
}

function rangedResponse(start: number, bytes: Uint8Array, total: number, type = 'image/png') {
  return {
    success: true,
    payload: {
      ok: true,
      statusCode: 206,
      headers: {
        'content-type': type,
        'content-length': String(bytes.length),
        'content-range': `bytes ${start}-${start + bytes.length - 1}/${total}`,
      },
      body: '',
      json: null,
      isBinary: true,
      base64Body: toBase64(bytes),
    },
  };
}

describe('agent attachment RPC ranges', () => {
  const sendMessage = globalThis.chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMessage.mockReset();
  });

  it('assembles contiguous chunks and preserves request query fields and MIME type', async () => {
    const chunks = new Map<number, Uint8Array>([
      [0, new Uint8Array([1, 2])],
      [2, new Uint8Array([3, 4])],
      [4, new Uint8Array([5])],
    ]);
    sendMessage.mockImplementation(async (message) => {
      expect(message.type).toBe(BACKGROUND_MESSAGE_TYPES.AGENT_RPC_FETCH);
      expect(message.payload.query.scope).toBe('preview');
      const offset = message.payload.query.offset as number;
      return rangedResponse(offset, chunks.get(offset) || new Uint8Array(), 5);
    });

    const blob = await requestAgentRpcBlobInChunks({
      operation: 'agent.attachments.get',
      params: { projectId: 'project-1', filename: 'image.png' },
      query: { scope: 'preview' },
    });

    expect(blob.type).toBe('image/png');
    expect(Array.from(await readBlob(blob))).toEqual([1, 2, 3, 4, 5]);
    expect(sendMessage.mock.calls.map(([message]) => message.payload.query.offset)).toEqual([0, 2, 4]);
  });

  it('accepts a legacy host one-shot response for a small attachment', async () => {
    sendMessage.mockResolvedValue({
      success: true,
      payload: {
        ok: true,
        statusCode: 200,
        headers: { 'content-type': 'image/webp' },
        body: '',
        json: null,
        isBinary: true,
        base64Body: toBase64(new Uint8Array([9, 8, 7])),
      },
    });

    const blob = await requestAgentRpcBlobInChunks({
      operation: 'agent.attachments.get',
    });

    expect(blob.type).toBe('image/webp');
    expect(Array.from(await readBlob(blob))).toEqual([9, 8, 7]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects discontinuous ranges instead of returning corrupt data', async () => {
    sendMessage.mockResolvedValue(rangedResponse(1, new Uint8Array([1, 2]), 3));

    await expect(requestAgentRpcBlobInChunks({ operation: 'agent.attachments.get' })).rejects.toThrow(
      'discontinuous range',
    );
  });

  it('rejects a changing total size across chunks', async () => {
    sendMessage
      .mockResolvedValueOnce(rangedResponse(0, new Uint8Array([1, 2]), 4))
      .mockResolvedValueOnce(rangedResponse(2, new Uint8Array([3, 4]), 5));

    await expect(requestAgentRpcBlobInChunks({ operation: 'agent.attachments.get' })).rejects.toThrow('size changed');
  });
});

describe('agent RPC collection pagination', () => {
  const sendMessage = globalThis.chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMessage.mockReset();
  });

  it('walks bounded pages while preserving params and query fields', async () => {
    const pages = new Map<number, Array<{ id: string }>>([
      [0, [{ id: 'session-1' }, { id: 'session-2' }]],
      [2, [{ id: 'session-3' }, { id: 'session-4' }]],
      [4, [{ id: 'session-5' }]],
    ]);
    sendMessage.mockImplementation(async (message) => {
      const offset = message.payload.query.offset as number;
      const sessions = pages.get(offset) ?? [];
      const nextOffset = offset + sessions.length;
      const hasMore = nextOffset < 5;
      return {
        success: true,
        payload: {
          ok: true,
          statusCode: 200,
          body: '',
          json: {
            sessions,
            pagination: {
              count: sessions.length,
              hasMore,
              nextOffset: hasMore ? nextOffset : null,
            },
          },
        },
      };
    });

    await expect(
      requestAgentRpcCollection<{ id: string }>(
        {
          operation: 'agent.projects.sessions.list',
          params: { projectId: 'project-1' },
          query: { view: 'setup' },
        },
        'sessions',
      ),
    ).resolves.toEqual([
      { id: 'session-1' },
      { id: 'session-2' },
      { id: 'session-3' },
      { id: 'session-4' },
      { id: 'session-5' },
    ]);
    expect(sendMessage.mock.calls.map(([message]) => message.payload.query)).toEqual([
      { view: 'setup', limit: 500, offset: 0 },
      { view: 'setup', limit: 500, offset: 2 },
      { view: 'setup', limit: 500, offset: 4 },
    ]);
    expect(
      sendMessage.mock.calls.every(
        ([message]) => message.payload.params.projectId === 'project-1',
      ),
    ).toBe(true);
  });

  it('accepts legacy one-shot collections and rejects non-advancing pages', async () => {
    sendMessage.mockResolvedValueOnce({
      success: true,
      payload: {
        ok: true,
        statusCode: 200,
        body: '',
        json: { projects: [{ id: 'legacy-project' }] },
      },
    });
    await expect(
      requestAgentRpcCollection<{ id: string }>({ operation: 'agent.projects.list' }, 'projects'),
    ).resolves.toEqual([{ id: 'legacy-project' }]);

    sendMessage.mockResolvedValueOnce({
      success: true,
      payload: {
        ok: true,
        statusCode: 200,
        body: '',
        json: {
          projects: [],
          pagination: { count: 0, hasMore: true, nextOffset: 0 },
        },
      },
    });
    await expect(
      requestAgentRpcCollection<{ id: string }>({ operation: 'agent.projects.list' }, 'projects'),
    ).rejects.toThrow('did not advance');
  });
});
