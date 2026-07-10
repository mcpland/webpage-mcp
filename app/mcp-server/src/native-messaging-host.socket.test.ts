import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readNativeIpcCredential,
  removeNativeIpcCredential,
  type NativeIpcCredential,
} from './ipc/bridge-auth';
import { removeOwnedUnixSocket, type UnixSocketIdentity } from './ipc/socket-lifecycle';
import { NativeMessagingHost } from './native-messaging-host';

interface HostBridgeState {
  setupIpcServer: () => Promise<void>;
  ipcServer: net.Server | null;
  ipcSockets: Set<net.Socket>;
  ipcCredential: NativeIpcCredential | null;
  ipcSocketIdentity: UnixSocketIdentity | null;
  ipcSocketPath: string | null;
}

const originalSocketPath = process.env.WEBPAGE_MCP_NATIVE_SOCKET;
const originalAuthDir = process.env.WEBPAGE_MCP_NATIVE_AUTH_DIR;
const tempDirs: string[] = [];

function bridgeState(host: NativeMessagingHost): HostBridgeState {
  return host as unknown as HostBridgeState;
}

async function closeBridge(host: NativeMessagingHost): Promise<void> {
  const state = bridgeState(host);
  for (const socket of state.ipcSockets) {
    socket.destroy();
  }
  state.ipcSockets.clear();

  if (state.ipcServer?.listening) {
    await new Promise<void>((resolve) => state.ipcServer?.close(() => resolve()));
  }
  if (state.ipcCredential) {
    removeNativeIpcCredential(state.ipcCredential);
  }
  if (state.ipcSocketPath && state.ipcSocketIdentity) {
    removeOwnedUnixSocket(state.ipcSocketPath, state.ipcSocketIdentity);
  }
}

afterEach(() => {
  if (originalSocketPath === undefined) {
    delete process.env.WEBPAGE_MCP_NATIVE_SOCKET;
  } else {
    process.env.WEBPAGE_MCP_NATIVE_SOCKET = originalSocketPath;
  }
  if (originalAuthDir === undefined) {
    delete process.env.WEBPAGE_MCP_NATIVE_AUTH_DIR;
  } else {
    process.env.WEBPAGE_MCP_NATIVE_AUTH_DIR = originalAuthDir;
  }
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('NativeMessagingHost socket ownership', () => {
  it('does not replace a running host or overwrite its bridge credential', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webpage-mcp-host-socket-'));
    tempDirs.push(root);
    const socketPath = path.join(root, 'native.sock');
    const authDir = path.join(root, 'auth');
    process.env.WEBPAGE_MCP_NATIVE_SOCKET = socketPath;
    process.env.WEBPAGE_MCP_NATIVE_AUTH_DIR = authDir;

    const firstHost = new NativeMessagingHost();
    const secondHost = new NativeMessagingHost();
    try {
      await bridgeState(firstHost).setupIpcServer();
      const firstCredential = readNativeIpcCredential(socketPath, authDir);

      await expect(bridgeState(secondHost).setupIpcServer()).rejects.toThrow(
        'IPC socket is already owned by a running native host',
      );

      expect(readNativeIpcCredential(socketPath, authDir).token).toBe(firstCredential.token);
    } finally {
      await closeBridge(secondHost);
      await closeBridge(firstHost);
    }
  });
});
