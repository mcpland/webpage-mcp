// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface PostedMessage {
  message: Record<string, any>;
  transfer?: Transferable[];
}

interface WorkerHarness {
  createSession: ReturnType<typeof vi.fn>;
  importScripts: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  posted: PostedMessage[];
  runSession: ReturnType<typeof vi.fn>;
  send: (type: string, payload?: Record<string, any>, id?: string) => Promise<void>;
}

const scriptPath = join(process.cwd(), 'workers', 'similarity.worker.js');
const scriptSource = readFileSync(scriptPath, 'utf8');

function createHarness(inputNames = ['input_ids', 'attention_mask', 'token_type_ids']): WorkerHarness {
  const posted: PostedMessage[] = [];
  const postMessage = vi.fn((message: Record<string, any>, transfer?: Transferable[]) => {
    posted.push({ message: structuredClone(message), transfer });
  });
  const importScripts = vi.fn();
  const runSession = vi.fn(async () => ({
    last_hidden_state: {
      data: new Float32Array([0.25, 0.75]),
      dims: [1, 2],
    },
  }));
  const createSession = vi.fn(async () => ({ inputNames, run: runSession }));
  class Tensor {
    constructor(
      public readonly type: string,
      public readonly data: BigInt64Array,
      public readonly dims: number[],
    ) {}
  }
  const workerGlobal: Record<string, any> = { postMessage };
  const context = createContext({
    BigInt64Array,
    Float32Array,
    ArrayBuffer,
    BigInt,
    Error,
    Object,
    console,
    importScripts,
    performance: { now: vi.fn().mockReturnValueOnce(10).mockReturnValue(15) },
    ort: {
      env: { wasm: {} },
      InferenceSession: { create: createSession },
      Tensor,
    },
    self: workerGlobal,
  });
  runInContext(scriptSource, context, { filename: scriptPath });

  return {
    createSession,
    importScripts,
    postMessage,
    posted,
    runSession,
    send: async (type, payload = {}, id = `request-${type}`) => {
      await workerGlobal.onmessage({ data: { id, type, payload } });
    },
  };
}

describe('similarity worker protocol', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('initializes local ORT and runs inference with transferable output', async () => {
    const harness = createHarness();
    expect(harness.importScripts).toHaveBeenCalledWith('../libs/ort.min.js');

    await harness.send('init', {
      modelPath: 'chrome-extension://id/models/model.onnx',
      numThreads: 2,
      executionProviders: ['wasm'],
    });
    expect(harness.createSession).toHaveBeenCalledWith(
      'chrome-extension://id/models/model.onnx',
      expect.objectContaining({ executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
    );

    await harness.send('infer', {
      input_ids: [101, 102],
      attention_mask: [1, 1],
      dims: { input_ids: [1, 2], attention_mask: [1, 2] },
    });

    const feeds = harness.runSession.mock.calls[0]?.[0] as Record<string, any>;
    expect(Array.from(feeds.input_ids.data)).toEqual([101n, 102n]);
    expect(Array.from(feeds.attention_mask.data)).toEqual([1n, 1n]);
    expect(Array.from(feeds.token_type_ids.data)).toEqual([0n, 0n]);
    const messages = harness.posted;
    expect(messages[0]?.message).toMatchObject({ type: 'init_complete', status: 'success' });
    expect(messages[1]?.message).toMatchObject({
      type: 'infer_complete',
      status: 'success',
      payload: { dims: [1, 2] },
      stats: { totalInferences: 1, memoryAllocations: 3 },
    });
    expect(messages[1]?.transfer).toHaveLength(1);
  });

  it('tracks batch statistics and clears reusable buffers', async () => {
    const harness = createHarness();
    await harness.send('init', { modelPath: '/model.onnx' });
    await harness.send('batchInfer', {
      input_ids: [1, 2, 3, 4],
      attention_mask: [1, 1, 1, 1],
      token_type_ids: [0, 0, 1, 1],
      dims: {
        input_ids: [2, 2],
        attention_mask: [2, 2],
        token_type_ids: [2, 2],
      },
    });
    await harness.send('getStats');
    await harness.send('clearBuffers');
    await harness.send('getStats', {}, 'after-clear');

    const messages = harness.posted.map(({ message }) => message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'batchInfer_complete',
          stats: expect.objectContaining({ totalInferences: 2, batchSize: 2 }),
        }),
        expect.objectContaining({
          id: 'request-getStats',
          payload: expect.objectContaining({ totalInferences: 2, memoryAllocations: 3 }),
        }),
        expect.objectContaining({ type: 'clear_complete', status: 'success' }),
        expect.objectContaining({
          id: 'after-clear',
          payload: expect.objectContaining({ memoryAllocations: 0 }),
        }),
      ]),
    );
  });

  it('returns structured errors for invalid ordering, missing models, and unknown messages', async () => {
    const harness = createHarness();

    await harness.send('infer', {
      input_ids: [1],
      attention_mask: [1],
      dims: { input_ids: [1, 1], attention_mask: [1, 1] },
    });
    await harness.send('init');
    await harness.send('unknown');

    const messages = harness.posted.map(({ message }) => message);
    expect(messages[0]).toMatchObject({
      type: 'infer_error',
      status: 'error',
      payload: { message: expect.stringContaining('Session not initialized') },
    });
    expect(messages[1]).toMatchObject({
      type: 'init_error',
      status: 'error',
      payload: { message: expect.stringContaining('Model path or data is not provided') },
    });
    expect(messages[2]).toMatchObject({
      type: 'error',
      status: 'error',
      payload: { message: expect.stringContaining('Unknown message type') },
    });
  });
});
