import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CANCEL_REQUEST_METHOD } from '../ipc/bridge-protocol';
import { NativeIpcBridgeClient } from './native-ipc-bridge-client';

class FakeSocket extends EventEmitter {
  public readonly writes: string[] = [];
  public destroyed = false;

  write(payload: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(payload);
    queueMicrotask(() => callback?.());
    return true;
  }

  destroy(_error?: Error): this {
    this.destroyed = true;
    return this;
  }
}

interface BridgeClientInternals {
  socket: net.Socket | null;
  authenticated: boolean;
  sendRequest<T>(
    socket: net.Socket,
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
    sendCancellation?: boolean,
  ): Promise<T>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NativeIpcBridgeClient lifecycle and request cancellation', () => {
  it('cancels an in-flight connection and remains permanently closed', async () => {
    const socket = new FakeSocket();
    const createConnection = vi
      .spyOn(net, 'createConnection')
      .mockReturnValue(socket as unknown as net.Socket);
    const client = new NativeIpcBridgeClient();

    const request = client.request('ping');
    const rejection = expect(request).rejects.toThrow('IPC client closed');
    expect(createConnection).toHaveBeenCalledTimes(1);

    client.close();
    await rejection;
    expect(socket.destroyed).toBe(true);

    await expect(client.request('ping')).rejects.toThrow('IPC client closed');
    expect(createConnection).toHaveBeenCalledTimes(1);
  });

  it('interrupts the connection retry delay when closed', async () => {
    vi.useFakeTimers();
    const createConnection = vi.spyOn(net, 'createConnection').mockImplementation(() => {
      const socket = new FakeSocket();
      const error = Object.assign(new Error('Socket missing'), { code: 'ENOENT' });
      queueMicrotask(() => socket.emit('error', error));
      return socket as unknown as net.Socket;
    });
    const client = new NativeIpcBridgeClient();

    const request = client.request('ping');
    const rejection = expect(request).rejects.toThrow('IPC client closed');
    await vi.advanceTimersByTimeAsync(0);
    const attemptsBeforeClose = createConnection.mock.calls.length;
    expect(attemptsBeforeClose).toBeGreaterThan(0);

    client.close();
    await rejection;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(createConnection).toHaveBeenCalledTimes(attemptsBeforeClose);
  });

  it('cancels remote work when a written request times out locally', async () => {
    vi.useFakeTimers();
    const client = new NativeIpcBridgeClient();
    const socket = new FakeSocket();
    const internals = client as unknown as BridgeClientInternals;
    internals.socket = socket as unknown as net.Socket;
    internals.authenticated = true;

    const request = internals.sendRequest(
      socket as unknown as net.Socket,
      'mcp_call_tool',
      { name: 'long_running_tool' },
      100,
      undefined,
      true,
    );
    const timedOut = expect(request).rejects.toThrow('IPC request timed out after 100ms');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.writes).toHaveLength(1);
    const original = JSON.parse(socket.writes[0]) as { id: string; method: string };

    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
    await vi.advanceTimersByTimeAsync(0);

    expect(socket.writes).toHaveLength(2);
    expect(JSON.parse(socket.writes[1])).toEqual({
      id: expect.any(String),
      method: IPC_CANCEL_REQUEST_METHOD,
      params: { requestId: original.id },
    });

    client.close();
  });
});
