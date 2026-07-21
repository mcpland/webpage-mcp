import { describe, expect, it, vi } from 'vitest';
import {
  SemanticSimilarityEngine,
  SemanticSimilarityEngineProxy,
  readPinnedModelResponse,
} from '@/utils/semantic-similarity-engine';
import { SEMANTIC_RESOURCE_LIMITS } from '@/utils/semantic-similarity-boundaries';

function fakeWorker(): Worker & {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
} {
  return {
    onmessage: null,
    onmessageerror: null,
    onerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as Worker & {
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };
}

describe('SemanticSimilarityEngine security boundaries', () => {
  it('constructs catalog-backed 384/768 configs and rejects tunable resource injection', () => {
    const small = new SemanticSimilarityEngine({
      modelPreset: 'multilingual-e5-small',
      modelVersion: 'quantized',
      dimension: 384,
      useLocalFiles: false,
      forceOffscreen: false,
    });
    const base = new SemanticSimilarityEngine({
      modelPreset: 'multilingual-e5-base',
      modelVersion: 'full',
      dimension: 768,
      useLocalFiles: false,
      forceOffscreen: false,
    });

    expect(small.config).toMatchObject({
      modelIdentifier: 'Xenova/multilingual-e5-small',
      dimension: 384,
      cacheSize: 500,
    });
    expect(base.config).toMatchObject({
      modelIdentifier: 'Xenova/multilingual-e5-base',
      dimension: 768,
      cacheSize: 500,
    });
    expect(
      () =>
        new SemanticSimilarityEngine({
          modelPreset: 'multilingual-e5-small',
          dimension: 384,
          cacheSize: 1_000_000,
        }),
    ).toThrow(/unsupported fields/i);
    expect(
      () =>
        new SemanticSimilarityEngine({
          modelPreset: 'multilingual-e5-small',
          dimension: 768,
        }),
    ).toThrow(/dimension/i);
    expect(
      () =>
        new SemanticSimilarityEngineProxy({
          modelPreset: 'multilingual-e5-small',
          dimension: 384,
          concurrentLimit: 100,
        }),
    ).toThrow(/unsupported fields/i);
  });

  it('rejects invalid input before attempting model initialization', async () => {
    const engine = new SemanticSimilarityEngine({
      modelPreset: 'multilingual-e5-small',
      modelVersion: 'quantized',
      dimension: 384,
    });

    await expect(
      engine.getEmbedding('a'.repeat(SEMANTIC_RESOURCE_LIMITS.maxTextBytes + 1)),
    ).rejects.toThrow(/UTF-8 byte limit/i);
    await expect(engine.getEmbedding('valid', { nested: {} })).rejects.toThrow(/JSON scalars/i);
    await expect(
      engine.getEmbeddingsBatch(
        Array.from({ length: SEMANTIC_RESOURCE_LIMITS.maxBatchTexts + 1 }, () => 'valid'),
      ),
    ).rejects.toThrow(/batch item limit/i);
  });

  it('times out worker messages and removes their pending callbacks', async () => {
    vi.useFakeTimers();
    try {
      const engine = new SemanticSimilarityEngine({
        modelPreset: 'multilingual-e5-small',
        modelVersion: 'quantized',
        dimension: 384,
      });
      const worker = fakeWorker();
      const internal = engine as unknown as {
        worker: Worker | null;
        pendingMessages: Map<number, unknown>;
        _sendMessageToWorker: (
          type: string,
          payload?: unknown,
          transferList?: Transferable[],
          timeoutMs?: number,
        ) => Promise<unknown>;
      };
      internal.worker = worker;

      const request = internal._sendMessageToWorker(
        'getStats',
        undefined,
        undefined,
        25,
      );
      const outcome = request.then(
        (value) => ({ status: 'resolved' as const, value }),
        (error) => ({ status: 'rejected' as const, error }),
      );

      expect(internal.pendingMessages.size).toBe(1);
      await vi.advanceTimersByTimeAsync(25);
      await expect(outcome).resolves.toMatchObject({
        status: 'rejected',
        error: {
          name: 'SemanticWorkerTimeoutError',
          message: expect.stringContaining('getStats'),
        },
      });
      expect(internal.pendingMessages.size).toBe(0);
      expect(worker.postMessage).toHaveBeenCalledOnce();

      worker.postMessage.mockImplementationOnce(() => {
        throw new Error('structured clone failed');
      });
      await expect(
        internal._sendMessageToWorker('infer', undefined, undefined, 25),
      ).rejects.toThrow('structured clone failed');
      expect(internal.pendingMessages.size).toBe(0);

      await engine.dispose();
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles worker requests and queued slot waiters during bounded disposal', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const engine = new SemanticSimilarityEngine({
        modelPreset: 'multilingual-e5-small',
        modelVersion: 'quantized',
        dimension: 384,
      });
      const worker = fakeWorker();
      const internal = engine as unknown as {
        worker: Worker | null;
        isInitialized: boolean;
        pendingMessages: Map<number, unknown>;
        workerTaskQueue: unknown[];
        _sendMessageToWorker: (
          type: string,
          payload?: unknown,
          transferList?: Transferable[],
          timeoutMs?: number,
        ) => Promise<unknown>;
        waitForWorkerSlot: () => Promise<void>;
      };
      internal.worker = worker;
      internal.isInitialized = true;

      const request = internal._sendMessageToWorker(
        'infer',
        undefined,
        undefined,
        60_000,
      );
      const slot = internal.waitForWorkerSlot();
      const requestOutcome = request.then(
        () => ({ status: 'resolved' as const }),
        (error) => ({ status: 'rejected' as const, error }),
      );
      const slotOutcome = slot.then(
        () => ({ status: 'resolved' as const }),
        (error) => ({ status: 'rejected' as const, error }),
      );
      const disposal = engine.dispose();

      await expect(requestOutcome).resolves.toMatchObject({
        status: 'rejected',
        error: { message: expect.stringMatching(/disposed/i) },
      });
      await expect(slotOutcome).resolves.toMatchObject({
        status: 'rejected',
        error: { message: expect.stringMatching(/disposed/i) },
      });
      expect(worker.terminate).not.toHaveBeenCalled();
      expect(worker.postMessage).toHaveBeenLastCalledWith({
        id: 1,
        type: 'clearBuffers',
        payload: undefined,
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await disposal;

      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(internal.pendingMessages.size).toBe(0);
      expect(internal.workerTaskQueue).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        'Failed to clear worker buffers:',
        expect.objectContaining({ name: 'SemanticWorkerTimeoutError' }),
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reserves a released worker slot before waking the queued task', async () => {
    const engine = new SemanticSimilarityEngine({
      modelPreset: 'multilingual-e5-small',
      modelVersion: 'quantized',
      dimension: 384,
    });
    const internal = engine as unknown as {
      config: { concurrentLimit: number };
      runningWorkerTasks: number;
      workerTaskQueue: unknown[];
      acquireWorkerSlot: () => Promise<void>;
      releaseWorkerSlot: () => void;
    };
    internal.config.concurrentLimit = 1;

    await internal.acquireWorkerSlot();
    const second = internal.acquireWorkerSlot();
    expect(internal.runningWorkerTasks).toBe(1);
    expect(internal.workerTaskQueue).toHaveLength(1);

    internal.releaseWorkerSlot();
    expect(internal.runningWorkerTasks).toBe(1);
    const third = internal.acquireWorkerSlot();
    expect(internal.runningWorkerTasks).toBe(1);
    expect(internal.workerTaskQueue).toHaveLength(1);

    await second;
    internal.releaseWorkerSlot();
    await third;
    expect(internal.runningWorkerTasks).toBe(1);
    internal.releaseWorkerSlot();
    expect(internal.runningWorkerTasks).toBe(0);

    await engine.dispose();
  });

  it('requires an exact Content-Length before allocating a pinned response', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { headers: { 'content-length': '4' } });

    await expect(readPinnedModelResponse(response, 3)).rejects.toThrow(/Content-Length/i);
    expect(cancelled).toBe(true);
  });

  it('cancels a streamed model response immediately when it exceeds the pinned size', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readPinnedModelResponse(new Response(body), 3)).rejects.toThrow(/exceeded/i);
    expect(cancelled).toBe(true);
  });

  it('accepts a streamed response that exactly matches the pinned size', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2, 3]));
        controller.close();
      },
    });

    const result = await readPinnedModelResponse(
      new Response(body, { headers: { 'content-length': '3' } }),
      3,
    );
    expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3]);
  });
});
