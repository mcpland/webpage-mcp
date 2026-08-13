#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyMcpBundleMetafile } from '../../../scripts/mcp-bundle-components.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const sourceScriptsDir = path.join(projectRoot, 'src', 'scripts');

const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

function copyIfExists(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    console.warn(`Skipping missing file: ${sourcePath}`);
    return;
  }

  fs.copyFileSync(sourcePath, targetPath);
}

function chmodIfExists(filePath, mode) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  fs.chmodSync(filePath, mode);
}

if (!fs.existsSync(distDir)) {
  throw new Error(`dist directory not found: ${distDir}`);
}

const bundleMetafile = path.join(distDir, 'metafile-cjs.json');
const bundleVerification = verifyMcpBundleMetafile({
  projectRoot,
  metafilePath: bundleMetafile,
});
fs.rmSync(bundleMetafile);

fs.mkdirSync(path.join(distDir, 'logs'), { recursive: true });

const readmeContent = `# ${packageJson.name}

This program is the Native Messaging host for Chrome extension.

## Installation Instructions

1. Make sure Node.js is installed
2. Install globally:
   \`\`\`
   npm install -g ${packageJson.name}
   \`\`\`
3. Register Native Messaging host:
   \`\`\`
   # User-level installation (recommended)
   ${packageJson.name} register

   # If user-level installation fails, try system-level installation
   ${packageJson.name} register --system
   # Or use admin privileges
   sudo ${packageJson.name} register
   \`\`\`

## Usage

This application is automatically started by the Chrome extension and does not need to be run manually.
`;

fs.writeFileSync(path.join(distDir, 'README.md'), readmeContent, 'utf8');

copyIfExists(path.join(sourceScriptsDir, 'run_host.sh'), path.join(distDir, 'run_host.sh'));
copyIfExists(path.join(sourceScriptsDir, 'run_host.bat'), path.join(distDir, 'run_host.bat'));

chmodIfExists(path.join(distDir, 'index.js'), 0o755);
chmodIfExists(path.join(distDir, 'cli.js'), 0o755);
chmodIfExists(path.join(distDir, 'mcp', 'mcp-server-http.js'), 0o755);
chmodIfExists(path.join(distDir, 'run_host.sh'), 0o755);

fs.writeFileSync(path.join(distDir, 'node_path.txt'), process.execPath, 'utf8');

console.log(
  `Postbuild completed; verified ${bundleVerification.components.size} bundled dependency components`,
);
