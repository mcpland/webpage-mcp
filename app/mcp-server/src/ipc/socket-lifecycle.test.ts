import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureUnixSocketIdentity,
  prepareUnixSocketPath,
  removeOwnedUnixSocket,
} from './socket-lifecycle';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;
const tempDirs: string[] = [];
const servers: net.Server[] = [];
const children: ChildProcess[] = [];

function createSocketPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webpage-mcp-socket-'));
  tempDirs.push(root);
  return path.join(root, 'native.sock');
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function createCrashedSocket(socketPath: string): Promise<void> {
  const script = [
    "const net = require('node:net');",
    'const server = net.createServer();',
    "server.listen(process.argv[1], () => process.stdout.write('ready\\n'));",
  ].join('');
  const child = spawn(process.execPath, ['-e', script, socketPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`Socket fixture exited before ready (${code ?? signal})`));
    });
    child.stdout?.once('data', () => resolve());
  });

  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  await Promise.all(servers.splice(0).map((server) => close(server)));
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describeUnix('Unix socket lifecycle', () => {
  it('preserves a socket owned by a running process', async () => {
    const socketPath = createSocketPath();
    await listen(net.createServer(), socketPath);

    await expect(prepareUnixSocketPath(socketPath)).resolves.toBe('active');
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
  });

  it('removes a stale socket left by a crashed process', async () => {
    const socketPath = createSocketPath();
    await createCrashedSocket(socketPath);
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);

    await expect(prepareUnixSocketPath(socketPath)).resolves.toBe('removed');
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('refuses to replace an ordinary filesystem entry', async () => {
    const socketPath = createSocketPath();
    fs.writeFileSync(socketPath, 'user data');

    await expect(prepareUnixSocketPath(socketPath)).rejects.toThrow(
      'Refusing to replace non-socket IPC path',
    );
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('user data');
  });

  it('does not delete a path that replaced the owned socket', async () => {
    const socketPath = createSocketPath();
    const server = net.createServer();
    await listen(server, socketPath);
    const identity = captureUnixSocketIdentity(socketPath);

    fs.unlinkSync(socketPath);
    fs.writeFileSync(socketPath, 'replacement');

    expect(removeOwnedUnixSocket(socketPath, identity)).toBe(false);
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('replacement');

    fs.unlinkSync(socketPath);
    await close(server);
  });
});
