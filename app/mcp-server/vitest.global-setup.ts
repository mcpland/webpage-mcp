import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GlobalSetupContext } from 'vitest/node';

const TEST_ENV_KEYS = [
  'MCP_ALLOWED_WORKSPACE_BASE',
  'WEBPAGE_MCP_AGENT_DATA_DIR',
  'WEBPAGE_MCP_AGENT_DB_FILE',
] as const;

export default function setup({ config }: GlobalSetupContext): () => void {
  const originalEnv = new Map(TEST_ENV_KEYS.map((key) => [key, process.env[key]] as const));
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webpage-mcp-vitest-'));
  const dataDir = path.join(testRoot, 'agent-data');
  fs.mkdirSync(dataDir, { recursive: true });

  // These values are inherited by Vitest workers before test modules load.
  // Individual tests may still override them with narrower temporary paths.
  process.env.MCP_ALLOWED_WORKSPACE_BASE = path.resolve(config.root);
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = path.join(dataDir, 'agent.db');

  return () => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
