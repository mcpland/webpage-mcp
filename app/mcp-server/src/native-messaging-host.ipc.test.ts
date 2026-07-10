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

  setEncoding(): this {
    return this;
  }

  write(payload: string): boolean {
    this.writes.push(payload);
    return true;
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
  it('rejects every bridge method before authentication without echoing the credential', () => {
    const { credential, socket } = createHostAndSocket();

    socket.emit(
      'data',
      `${JSON.stringify({ id: 'request-1', method: 'mcp_call_tool', params: {} })}\n`,
    );

    expect(parseWrites(socket)).toEqual([
      { id: 'request-1', error: 'IPC authentication failed' },
    ]);
    expect(socket.writes.join('')).not.toContain(credential.token);
    expect(socket.destroyed).toBe(true);
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

  it('closes the connection when the bearer is wrong', () => {
    const { socket } = createHostAndSocket();

    socket.emit(
      'data',
      `${JSON.stringify({
        id: 'auth-1',
        method: 'authenticate',
        params: { token: 'x'.repeat(43) },
      })}\n`,
    );

    expect(parseWrites(socket)).toEqual([
      { id: 'auth-1', error: 'IPC authentication failed' },
    ]);
    expect(socket.destroyed).toBe(true);
  });
});
