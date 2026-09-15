import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-lifecycle-'));
let sequence = 0;

beforeAll(async () => {
  // Exercise the actual entrypoint in another process: an in-process test
  // cannot time out a nextTick error loop that starves timers and signals.
  await build({
    entry: ['src/index.ts'],
    outDir: path.join(root, 'dist'),
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    noExternal: ['webpage-mcp-shared', '@modelcontextprotocol/sdk'],
    silent: true,
    config: false,
  });
}, 30_000);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function launch() {
  const directory = path.join(root, String(++sequence));
  fs.mkdirSync(directory);
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\wm-lifecycle-${process.pid}-${sequence}`
    : path.join(directory, 'host.sock');
  const child = spawn(process.execPath, [path.join(root, 'dist/index.js')], {
    env: {
      ...process.env,
      NODE_PATH: path.resolve('node_modules'),
      WEBPAGE_MCP_NATIVE_SOCKET: socket,
      WEBPAGE_MCP_NATIVE_AUTH_DIR: path.join(directory, 'auth'),
      WEBPAGE_MCP_AGENT_DATA_DIR: path.join(directory, 'data'),
      WEBPAGE_MCP_AGENT_DB_FILE: path.join(directory, 'agent.db'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics += String(chunk).slice(0, 4096); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const deadline = setTimeout(() => child.kill('SIGKILL'), 8_000);
  child.once('exit', () => clearTimeout(deadline));
  child.stdin.on('error', () => {});
  // A request/reply proves both startup and Native Messaging input are ready.
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('exit', () => reject(new Error(`Runtime exited before handshake: ${diagnostics}`)));
    sendUnknown(child);
  });
  return { child, exited, socket, directory };
}

function sendUnknown(child: ChildProcessWithoutNullStreams) {
  const body = Buffer.from('{"type":"lifecycle_probe"}');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header, body]));
}

describe('native runtime subprocess lifecycle', () => {
  it.each(['stdout', 'both'] as const)('exits on broken %s without EOF or a signal', async (mode) => {
    const { child, exited, socket, directory } = await launch();
    child.stdout.destroy();
    if (mode === 'both') child.stderr.destroy();
    sendUnknown(child);
    expect(await exited).toBe(1);
    if (process.platform !== 'win32') expect(fs.existsSync(socket)).toBe(false);
    expect(fs.readdirSync(path.join(directory, 'auth'))).toHaveLength(0);
  }, 12_000);

  it('exits cleanly when Chrome closes stdin', async () => {
    const { child, exited, socket } = await launch();
    child.stdin.end();
    expect(await exited).toBe(0);
    if (process.platform !== 'win32') expect(fs.existsSync(socket)).toBe(false);
  }, 12_000);

  it.skipIf(process.platform === 'win32')('handles SIGTERM after losing its log reader', async () => {
    const { child, exited } = await launch();
    child.stderr.destroy();
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 12_000);
});
