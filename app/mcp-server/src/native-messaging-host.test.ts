import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MCP_INSTANCE_ID, NativeMessageType } from 'webpage-mcp-shared';
import {
  CHROME_NATIVE_MESSAGE_MAX_OUTBOUND_BYTES,
  NativeMessageWriter,
} from './native-message-output';
import { NativeMessagingHost } from './native-messaging-host';
import type { RealtimeEvent } from './agent/types';

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

class ControlledWritable extends Writable {
  public readonly chunks: Buffer[] = [];
  private readonly completions: Array<(error?: Error | null) => void> = [];

  public constructor() {
    super({ highWaterMark: 1 });
  }

  public completeNext(error?: Error): void {
    const complete = this.completions.shift();
    if (!complete) throw new Error('No pending write');
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

  it('labels native agent subscriptions with their actual transport', async () => {
    const output = new CollectingWritable();
    const host = new NativeMessagingHost(new NativeMessageWriter(output));
    const subscribeAgentEvents = vi.fn(() => vi.fn());
    (
      host as unknown as {
        servers: Map<
          string,
          {
            isRunning: boolean;
            subscribeAgentEvents: typeof subscribeAgentEvents;
          }
        >;
        handleAgentStreamSubscribe: (message: unknown) => Promise<void>;
      }
    ).servers.set(DEFAULT_MCP_INSTANCE_ID, {
      isRunning: true,
      subscribeAgentEvents,
    });

    await (
      host as unknown as {
        handleAgentStreamSubscribe: (message: unknown) => Promise<void>;
      }
    ).handleAgentStreamSubscribe({
      requestId: 'subscribe-1',
      payload: { sessionId: 'session-1' },
    });

    await vi.waitFor(() => expect(output.chunks).toHaveLength(2));
    const connected = output.chunks.map(decodeFrame).find((message) => {
      return message.type === NativeMessageType.AGENT_STREAM_EVENT;
    });
    expect(connected).toMatchObject({
      payload: {
        event: {
          type: 'connected',
          data: { transport: 'native-messaging' },
        },
      },
    });
  });

  it('coalesces queued stream snapshots and preserves the final under backpressure', async () => {
    const output = new ControlledWritable();
    const host = new NativeMessagingHost(new NativeMessageWriter(output));
    let listener: ((event: RealtimeEvent) => void) | undefined;
    const subscribeAgentEvents = vi.fn(
      (_sessionId: string, callback: (event: RealtimeEvent) => void) => {
        listener = callback;
        return vi.fn();
      },
    );
    (
      host as unknown as {
        servers: Map<
          string,
          {
            isRunning: boolean;
            subscribeAgentEvents: typeof subscribeAgentEvents;
          }
        >;
        handleAgentStreamSubscribe: (message: unknown) => Promise<void>;
      }
    ).servers.set(DEFAULT_MCP_INSTANCE_ID, {
      isRunning: true,
      subscribeAgentEvents,
    });

    await (
      host as unknown as {
        handleAgentStreamSubscribe: (message: unknown) => Promise<void>;
      }
    ).handleAgentStreamSubscribe({
      requestId: 'subscribe-pressure',
      payload: { sessionId: 'session-pressure' },
    });

    expect(listener).toBeTypeOf('function');
    for (let index = 1; index <= 1_000; index++) {
      listener?.({
        type: 'message',
        data: {
          id: 'assistant-1',
          sessionId: 'session-pressure',
          role: 'assistant',
          content: `snapshot-${index}`,
          messageType: 'chat',
          isStreaming: true,
          isFinal: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      });
    }
    listener?.({
      type: 'message',
      data: {
        id: 'assistant-1',
        sessionId: 'session-pressure',
        role: 'assistant',
        content: 'final-snapshot',
        messageType: 'chat',
        isStreaming: false,
        isFinal: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });

    // Connected is active and the subscription response is non-stream traffic;
    // neither may be evicted by stream coalescing.
    expect(output.chunks).toHaveLength(1);
    output.completeNext();
    await vi.waitFor(() => expect(output.chunks).toHaveLength(2));
    output.completeNext();
    await vi.waitFor(() => expect(output.chunks).toHaveLength(3));
    output.completeNext();

    const decoded = output.chunks.map(decodeFrame);
    expect(decoded[1]).toMatchObject({ responseToRequestId: 'subscribe-pressure' });
    expect(decoded[2]).toMatchObject({
      type: NativeMessageType.AGENT_STREAM_EVENT,
      payload: {
        event: {
          type: 'message',
          data: { content: 'final-snapshot', isFinal: true },
        },
      },
    });
    expect(decoded).toHaveLength(3);
  });

  it('releases pending work, subscriptions, and servers exactly once during shutdown', async () => {
    const output = new CollectingWritable();
    const host = new NativeMessagingHost(new NativeMessageWriter(output));
    const stop = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();
    (
      host as unknown as {
        servers: Map<string, { stop: typeof stop }>;
        streamSubscriptions: Map<
          string,
          { subscriptionId: string; instanceId: string; sessionId: string; dispose: typeof dispose }
        >;
      }
    ).servers.set(DEFAULT_MCP_INSTANCE_ID, { stop });
    (
      host as unknown as {
        streamSubscriptions: Map<
          string,
          { subscriptionId: string; instanceId: string; sessionId: string; dispose: typeof dispose }
        >;
      }
    ).streamSubscriptions.set('subscription-1', {
      subscriptionId: 'subscription-1',
      instanceId: DEFAULT_MCP_INSTANCE_ID,
      sessionId: 'session-1',
      dispose,
    });

    const pending = host.sendRequestToExtensionAndWait(
      { query: 'wait forever' },
      'request_data',
      30_000,
    );
    await vi.waitFor(() => expect(output.chunks).toHaveLength(1));

    const firstShutdown = host.shutdown();
    await expect(pending).rejects.toThrow('Native host is shutting down');
    await expect(firstShutdown).resolves.toBeUndefined();
    await expect(host.shutdown()).resolves.toBeUndefined();

    expect(dispose).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
