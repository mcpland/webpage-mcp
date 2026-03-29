import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

const originalAllowedWorkspaceBase = process.env.MCP_ALLOWED_WORKSPACE_BASE;
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createSuccessfulSpawn() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const child = {
    once(event: string, handler: (...args: unknown[]) => void) {
      listeners.set(event, handler);
      return child;
    },
    removeAllListeners(event?: string) {
      if (event) {
        listeners.delete(event);
      } else {
        listeners.clear();
      }
      return child;
    },
    unref: vi.fn(),
  };

  queueMicrotask(() => {
    const exitHandler = listeners.get('exit');
    exitHandler?.(0, null);
  });

  return child;
}

async function loadOpenProject(allowedBase: string) {
  process.env.MCP_ALLOWED_WORKSPACE_BASE = allowedBase;
  vi.resetModules();
  return import('./open-project');
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => createSuccessfulSpawn());
});

afterEach(async () => {
  process.env.MCP_ALLOWED_WORKSPACE_BASE = originalAllowedWorkspaceBase;
  vi.resetModules();

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('openFileInVSCode', () => {
  it('opens files that stay within the project root', async () => {
    const allowedBase = await createTempDir('open-project-allowed-');
    const projectRoot = path.join(allowedBase, 'project');
    const srcDir = path.join(projectRoot, 'src');
    const filePath = path.join(srcDir, 'main.ts');
    await mkdir(srcDir, { recursive: true });
    await writeFile(filePath, 'export const value = 1;\n');

    const { openFileInVSCode } = await loadOpenProject(allowedBase);
    const result = await openFileInVSCode(projectRoot, '/src/main.ts', 12, 3);

    expect(result).toEqual({ success: true });
    expect(spawnMock).toHaveBeenCalledWith(
      'code',
      ['-r', projectRoot, '-g', `${filePath}:12:3`],
      expect.objectContaining({ shell: false, stdio: 'ignore', detached: true }),
    );
  });

  it('rejects files that escape the project root through a symlink', async () => {
    const allowedBase = await createTempDir('open-project-root-');
    const outsideDir = await createTempDir('open-project-outside-');
    const projectRoot = path.join(allowedBase, 'project');
    const secretFile = path.join(outsideDir, 'secret.txt');
    const escapeLink = path.join(projectRoot, 'escape');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(secretFile, 'secret\n');
    await symlink(outsideDir, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');

    const { openFileInVSCode } = await loadOpenProject(allowedBase);
    const result = await openFileInVSCode(projectRoot, 'escape/secret.txt');

    expect(result.success).toBe(false);
    expect(result.error).toContain('within project directory');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
