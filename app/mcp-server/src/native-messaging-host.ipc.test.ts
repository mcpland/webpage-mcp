import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeIpcCredential } from './ipc/bridge-auth';
import { NativeMessagingHost } from './native-messaging-host';

class FakeSocket extends EventEmitter {
  public readonly writes: string[] = [];
  public destroyed = false;
  public paused = false;
  public pauseCalls = 0;
  public resumeCalls = 0;

  setEncoding(): this {
    return this;
  }

  write(payload: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(payload);
    queueMicrotask(() => callback?.());
    return true;
  }

  pause(): this {
    this.paused = true;
    this.pauseCalls += 1;
    return this;
  }

  resume(): this {
    this.paused = false;
    this.resumeCalls += 1;
    return this;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
    return this;
  }
}

const tempDirs: string[] = [];

function createHostAndSocket(): {
  credential: ReturnType<typeof createNativeIpcCredential>;
  host: NativeMessagingHost;
  socket: FakeSocket;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webpage-mcp-ipc-host-'));
  tempDirs.push(root);
  const credential = createNativeIpcCredential(
    path.join(root, 'native.sock'),
    path.join(root, 'auth'),
  );
  const host = new NativeMessagingHost();
  const socket = new FakeSocket();
  (host as unknown as { ipcCredential: typeof credential }).ipcCredential = credential;
  (
    host as unknown as {
      handleIpcSocket: (socket: net.Socket) => void;
    }
  ).handleIpcSocket(socket as unknown as net.Socket);
  return { credential, host, socket };
}

function parseWrites(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('NativeMessagingHost IPC authentication', () => {
  it('rejects every bridge method before authentication without echoing the credential', async () => {
    const { credential, socket } = createHostAndSocket();

    socket.emit(
      'data',
      `${JSON.stringify({ id: 'request-1', method: 'mcp_call_tool', params: {} })}\n`,
    );

    await vi.waitFor(() => {
      expect(parseWrites(socket)).toEqual([
        { id: 'request-1', error: 'IPC authentication failed' },
      ]);
      expect(socket.destroyed).toBe(true);
    });
    expect(socket.writes.join('')).not.toContain(credential.token);
  });

  it('accepts the process bearer once and allows later requests on that connection', async () => {
    const { credential, socket } = createHostAndSocket();

    socket.emit(
      'data',
      `${JSON.stringify({
        id: 'auth-1',
        method: 'authenticate',
        params: { token: credential.token },
      })}\n`,
    );
    socket.emit('data', `${JSON.stringify({ id: 'ping-1', method: 'ping' })}\n`);

    await vi.waitFor(() => {
      expect(parseWrites(socket)).toEqual([
        { id: 'auth-1', result: { authenticated: true } },
        { id: 'ping-1', result: { ok: true } },
      ]);
    });
    expect(socket.destroyed).toBe(false);
  });

  it('closes the connection when the bearer is wrong', async () => {
    const { socket } = createHostAndSocket();

    socket.emit(
      'data',
      `${JSON.stringify({
        id: 'auth-1',
        method: 'authenticate',
        params: { token: 'x'.repeat(43) },
      })}\n`,
    );

    await vi.waitFor(() => {
      expect(parseWrites(socket)).toEqual([
        { id: 'auth-1', error: 'IPC authentication failed' },
      ]);
      expect(socket.destroyed).toBe(true);
    });
  });
});

describe('NativeMessagingHost IPC resource limits', () => {
  async function authenticate(socket: FakeSocket, token: string): Promise<void> {
    socket.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          id: 'auth-1',
          method: 'authenticate',
          params: { token },
        })}\n`,
      ),
    );
    await vi.waitFor(() => {
      expect(parseWrites(socket)[0]).toEqual({
        id: 'auth-1',
        result: { authenticated: true },
      });
    });
  }

  it('closes a connection whose partial line exceeds the request limit', async () => {
    const { credential, socket } = createHostAndSocket();
    await authenticate(socket, credential.token);

    socket.emit('data', Buffer.alloc(1024 * 1024 + 1, 0x61));

    await vi.waitFor(() => {
      expect(parseWrites(socket).at(-1)).toEqual({
        id: null,
        error: 'IPC line exceeds the 1048576-byte limit',
      });
      expect(socket.destroyed).toBe(true);
    });
  });

  it('runs at most four requests and pauses input while the queue is full', async () => {
    const { credential, host, socket } = createHostAndSocket();
    const resolvers: Array<() => void> = [];
    let running = 0;
    let maxRunning = 0;
    const handleRequest = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          resolvers.push(() => {
            running -= 1;
            resolve({ ok: true });
          });
        }),
    );
    (
      host as unknown as {
        handleIpcRequest: typeof handleRequest;
      }
    ).handleIpcRequest = handleRequest;
    await authenticate(socket, credential.token);

    const requests = Array.from({ length: 8 }, (_, index) =>
      JSON.stringify({ id: `request-${index}`, method: 'ping' }),
    ).join('\n');
    socket.emit('data', Buffer.from(`${requests}\n`));

    expect(handleRequest).toHaveBeenCalledTimes(4);
    expect(socket.paused).toBe(true);
    expect(socket.pauseCalls).toBe(1);

    resolvers.splice(0, 4).forEach((resolve) => resolve());
    await vi.waitFor(() => {
      expect(handleRequest).toHaveBeenCalledTimes(8);
      expect(socket.resumeCalls).toBeGreaterThan(0);
    });
    expect(maxRunning).toBe(4);
    resolvers.splice(0).forEach((resolve) => resolve());
  });

  it('closes the connection instead of accepting more than sixteen pending requests', async () => {
    const { credential, host, socket } = createHostAndSocket();
    const handleRequest = vi.fn(
      (_request: unknown, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    (
      host as unknown as {
        handleIpcRequest: typeof handleRequest;
      }
    ).handleIpcRequest = handleRequest;
    await authenticate(socket, credential.token);

    const requests = Array.from({ length: 17 }, (_, index) =>
      JSON.stringify({ id: `request-${index}`, method: 'ping' }),
    ).join('\n');
    socket.emit('data', Buffer.from(`${requests}\n`));

    await vi.waitFor(() => {
      expect(parseWrites(socket).at(-1)).toEqual({
        id: 'request-16',
        error: 'IPC connection has too many pending requests',
      });
      expect(socket.destroyed).toBe(true);
    });
    expect(handleRequest).toHaveBeenCalledTimes(4);
  });

  it('aborts active request work when the client disconnects', async () => {
    const { credential, host, socket } = createHostAndSocket();
    let requestSignal: AbortSignal | undefined;
    (
      host as unknown as {
        handleIpcRequest: (_request: unknown, signal?: AbortSignal) => Promise<never>;
      }
    ).handleIpcRequest = (_request, signal) => {
      requestSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    };
    await authenticate(socket, credential.token);
    socket.emit('data', Buffer.from(`${JSON.stringify({ id: 'request-1', method: 'ping' })}\n`));
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    socket.destroy();

    expect(requestSignal?.aborted).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(parseWrites(socket)).toEqual([
      { id: 'auth-1', result: { authenticated: true } },
    ]);
  });

  it('removes a pending extension request as soon as its bridge signal aborts', async () => {
    const host = new NativeMessagingHost();
    vi.spyOn(host, 'sendMessage').mockImplementation(() => {});
    const controller = new AbortController();

    const pending = host.sendRequestToExtensionAndWait(
      { name: 'example' },
      'request_data',
      30_000,
      controller.signal,
    );
    expect(
      (host as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size,
    ).toBe(1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      (host as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size,
    ).toBe(0);
  });
});
