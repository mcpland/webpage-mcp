import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

const SRC_DIR = path.resolve(__dirname, 'src');

function collectTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!fullPath.endsWith('.ts')) {
      continue;
    }

    if (
      fullPath.endsWith('.d.ts') ||
      fullPath.endsWith('.test.ts') ||
      fullPath.endsWith('.spec.ts')
    ) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

const transpileEntries = Object.fromEntries(
  collectTsFiles(SRC_DIR).map((absPath) => {
    const rel = path.relative(SRC_DIR, absPath).replace(/\.ts$/, '');
    return [rel, absPath];
  }),
);

// These phases intentionally run through separate CLI invocations. tsup executes
// config arrays concurrently, but the bundled entries must overwrite matching
// transpiled entries only after the first phase has finished.
export const transpileConfig = {
  entry: transpileEntries,
  outDir: 'dist',
  format: ['cjs'] as const,
  platform: 'node' as const,
  target: 'node22',
  bundle: false,
  sourcemap: true,
  clean: true,
  dts: false,
};

export const bundleConfig = {
  entry: {
    index: path.join(SRC_DIR, 'index.ts'),
    'agent/attachment-service': path.join(SRC_DIR, 'agent/attachment-service.ts'),
    'agent/engines/codex': path.join(SRC_DIR, 'agent/engines/codex.ts'),
    'agent/rpc-dispatcher': path.join(SRC_DIR, 'agent/rpc-dispatcher.ts'),
    'agent/types': path.join(SRC_DIR, 'agent/types.ts'),
    'mcp/mcp-server-stdio': path.join(SRC_DIR, 'mcp/mcp-server-stdio.ts'),
    'mcp/mcp-server-http': path.join(SRC_DIR, 'mcp/mcp-server-http.ts'),
    'mcp/register-tools': path.join(SRC_DIR, 'mcp/register-tools.ts'),
    'native-messaging-host': path.join(SRC_DIR, 'native-messaging-host.ts'),
    'server/index': path.join(SRC_DIR, 'server/index.ts'),
  },
  outDir: 'dist',
  format: ['cjs'] as const,
  platform: 'node' as const,
  target: 'node22',
  bundle: true,
  splitting: false,
  sourcemap: true,
  metafile: true,
  clean: false,
  dts: false,
  noExternal: ['webpage-mcp-shared', '@modelcontextprotocol/sdk'],
  alias: {
    'webpage-mcp-shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
  },
};

export default defineConfig(transpileConfig);
