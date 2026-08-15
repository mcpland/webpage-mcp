import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeBridgeRequestClient } from './native-ipc-bridge-client';
import { NativeBridgeRequestScheduler } from './native-bridge-request-scheduler';

interface ControlledCall {
  sessionId?: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

class ControlledBridge implements NativeBridgeRequestClient {
  public readonly calls: ControlledCall[] = [];

  public request<T = unknown>(
    _method: string,
    params?: Record<string, unknown>,
    _timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const call: ControlledCall = {
        sessionId: typeof params?.sessionId === 'string' ? params.sessionId : undefined,
        resolve,
        reject,
      };
      this.calls.push(call);
      signal?.addEventListener(
        'abort',
        () => {
          const error = new Error('delegate aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  }
}

class GatedBridge implements NativeBridgeRequestClient {
  public readonly calls: string[] = [];
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  public async request<T = unknown>(_method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push(String(params?.requestId));
    await this.gate;
    return { ok: true } as T;
  }

  public release(): void {
    this.releaseGate();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NativeBridgeRequestScheduler', () => {
  it('round-robins queued work while enforcing a per-session in-flight limit', async () => {
    const delegate = new ControlledBridge();
    const scheduler = new NativeBridgeRequestScheduler(delegate, {
      maxInFlight: 2,
      maxInFlightPerSession: 1,
      maxQueued: 8,
      maxQueuedPerSession: 4,
    });

    const requests = [
      scheduler.request('mcp_call_tool', { sessionId: 'session-a', requestId: 'a-1' }),
      scheduler.request('mcp_call_tool', { sessionId: 'session-a', requestId: 'a-2' }),
      scheduler.request('mcp_call_tool', { sessionId: 'session-a', requestId: 'a-3' }),
      scheduler.request('mcp_call_tool', { sessionId: 'session-b', requestId: 'b-1' }),
      scheduler.request('mcp_call_tool', { sessionId: 'session-b', requestId: 'b-2' }),
    ];

    await vi.waitFor(() => expect(delegate.calls).toHaveLength(2));
    expect(delegate.calls.map((call) => call.sessionId)).toEqual(['session-a', 'session-b']);

    delegate.calls[0]!.resolve({ ok: true });
    await vi.waitFor(() => expect(delegate.calls).toHaveLength(3));
    expect(delegate.calls[2]?.sessionId).toBe('session-a');

    delegate.calls[1]!.resolve({ ok: true });
    await vi.waitFor(() => expect(delegate.calls).toHaveLength(4));
    expect(delegate.calls[3]?.sessionId).toBe('session-b');

    delegate.calls[2]!.resolve({ ok: true });
    delegate.calls[3]!.resolve({ ok: true });
    await vi.waitFor(() => expect(delegate.calls).toHaveLength(5));
    delegate.calls[4]!.resolve({ ok: true });

    await expect(Promise.all(requests)).resolves.toHaveLength(5);
    scheduler.close();
  });

  it('queues more than sixteen requests from one session without overflowing the IPC client', async () => {
    const delegate = new GatedBridge();
    const scheduler = new NativeBridgeRequestScheduler(delegate);
    const requests = Array.from({ length: 17 }, (_, index) =>
      scheduler.request('mcp_call_tool', {
        sessionId: 'busy-session',
        requestId: `request-${index}`,
      }),
    );

    await vi.waitFor(() => expect(delegate.calls).toHaveLength(4));
    delegate.release();
    await expect(Promise.all(requests)).resolves.toHaveLength(17);
    expect(delegate.calls).toHaveLength(17);
    scheduler.close();
  });

  it('removes cancelled queued work and rejects bounded queue overflow', async () => {
    const delegate = new ControlledBridge();
    const scheduler = new NativeBridgeRequestScheduler(delegate, {
      maxInFlight: 1,
      maxInFlightPerSession: 1,
      maxQueued: 1,
      maxQueuedPerSession: 1,
    });
    const active = scheduler.request('mcp_call_tool', { sessionId: 'session-a' });
    const controller = new AbortController();
    const queued = scheduler.request(
      'mcp_call_tool',
      { sessionId: 'session-b' },
      30_000,
      controller.signal,
    );

    await vi.waitFor(() => expect(delegate.calls).toHaveLength(1));
    await expect(scheduler.request('mcp_call_tool', { sessionId: 'session-c' })).rejects.toThrow(
      'queue has reached its 1-request limit',
    );

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(delegate.calls).toHaveLength(1);

    delegate.calls[0]!.resolve({ ok: true });
    await expect(active).resolves.toEqual({ ok: true });
    scheduler.close();
  });

  it('includes time spent waiting in the request timeout', async () => {
    vi.useFakeTimers();
    const delegate = new ControlledBridge();
    const scheduler = new NativeBridgeRequestScheduler(delegate, {
      maxInFlight: 1,
      maxInFlightPerSession: 1,
      maxQueued: 2,
      maxQueuedPerSession: 2,
    });
    const active = scheduler.request('mcp_call_tool', { sessionId: 'session-a' });
    const queued = scheduler.request('mcp_call_tool', { sessionId: 'session-b' }, 50);
    const timeout = expect(queued).rejects.toThrow('timed out after 50ms');

    await vi.advanceTimersByTimeAsync(50);
    await timeout;
    expect(delegate.calls).toHaveLength(1);

    delegate.calls[0]!.resolve({ ok: true });
    await expect(active).resolves.toEqual({ ok: true });
    scheduler.close();
  });
});
