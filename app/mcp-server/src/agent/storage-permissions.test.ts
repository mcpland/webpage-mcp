import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.WEBPAGE_MCP_AGENT_DATA_DIR;
const originalDbFile = process.env.WEBPAGE_MCP_AGENT_DB_FILE;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  try {
    const { closeDb } = await import('./db/client');
    closeDb();
  } catch {
    // The database may not have been initialized.
  }
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = originalDataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = originalDbFile;
  vi.resetModules();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === 'win32')('private agent storage permissions', () => {
  it('repairs directory modes and creates databases, sidecars, and attachments privately', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webpage-mcp-private-storage-'));
    temporaryDirectories.push(root);
    const dataDir = path.join(root, 'agent-data');
    const dbFile = path.join(dataDir, 'agent.db');
    await fs.mkdir(dataDir, { recursive: true, mode: 0o755 });
    await fs.chmod(dataDir, 0o755);

    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;
    vi.resetModules();

    const [{ getDb }, { AttachmentService }] = await Promise.all([
      import('./db/client'),
      import('./attachment-service'),
    ]);
    getDb();
    const saved = await new AttachmentService().saveAttachment({
      projectId: 'project-1',
      messageId: 'message-1',
      index: 0,
      attachment: {
        type: 'image',
        name: 'private.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('private-image').toString('base64'),
      },
    });

    const privateDirectoryPaths = [
      dataDir,
      path.join(dataDir, 'attachments'),
      path.dirname(saved.absolutePath),
    ];
    for (const directory of privateDirectoryPaths) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }

    const privateFilePaths = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, saved.absolutePath];
    for (const file of privateFilePaths) {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('creates wrapper logs under a private umask and restores it before exec', async () => {
    const script = await fs.readFile(
      path.join(process.cwd(), 'src', 'scripts', 'run_host.sh'),
      'utf8',
    );
    expect(script).toContain('umask 077');
    expect(script).toContain('chmod 600 "${WRAPPER_LOG}" "${STDERR_LOG}"');
    expect(script.indexOf('umask "${ORIGINAL_UMASK}"')).toBeLessThan(
      script.indexOf('exec "${NODE_EXEC}"'),
    );
  });
});
