import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readCiJob(jobName: string): string {
  const workflowPath = path.resolve(__dirname, '../../../../.github/workflows/ci.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const jobStart = workflow.indexOf(`  ${jobName}:`);
  expect(jobStart).toBeGreaterThanOrEqual(0);
  const nextJob = workflow.slice(jobStart + 2).search(/^ {2}[a-z0-9_-]+:\s*$/m);
  return nextJob < 0
    ? workflow.slice(jobStart)
    : workflow.slice(jobStart, jobStart + 2 + nextJob);
}

function readMacosNativeRegistrationJob(): string {
  return readCiJob('verify-macos-native-registration');
}

function readMacosNativeRegistrationVerifier(): string {
  const verifierPath = path.resolve(
    __dirname,
    '../../../../scripts/verify-macos-native-registration-smoke.mjs',
  );
  return fs.readFileSync(verifierPath, 'utf8');
}

describe('macOS native registration CI smoke', () => {
  it('runs the packed Node 24 host through install, registration, and doctor', () => {
    const job = readMacosNativeRegistrationJob();

    expect(job).toMatch(/runs-on:\s*macos-latest/);
    expect(job).toMatch(
      /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e[\s\S]*?node-version:\s*24/,
    );
    expect(job).toMatch(/pnpm --dir app\/mcp-server pack --pack-destination/);
    expect(job).toMatch(/npm install --global --foreground-scripts "\$PACKAGE_TGZ"/);
    expect(job).toMatch(/"\$CLI" register --browser chrome --force/);
    expect(job).toMatch(/"\$CLI" doctor --json --browser chrome/);
    expect(job).toContain('node scripts/verify-macos-native-registration-smoke.mjs');
  });

  it('fails closed unless every user-writable path is rooted in an isolated HOME', () => {
    const job = readMacosNativeRegistrationJob();

    expect(job).toContain('ORIGINAL_HOME="$HOME"');
    expect(job).toContain('SMOKE_ROOT="$(mktemp -d "$RUNNER_TEMP/');
    expect(job).toContain('export HOME="$SMOKE_ROOT/home"');
    expect(job).toContain('export npm_config_prefix="$SMOKE_ROOT/npm-prefix"');
    expect(job).toContain('export npm_config_cache="$SMOKE_ROOT/npm-cache"');
    expect(job).toContain('export npm_config_userconfig="$SMOKE_ROOT/npmrc"');
    expect(job).toContain('case "$HOME" in');
    expect(job).toContain('"$RUNNER_TEMP"/*) ;;');
    expect(job).toContain('trap \'rm -rf "$SMOKE_ROOT"\' EXIT');

    const verifier = readMacosNativeRegistrationVerifier();
    expect(verifier).toContain('assertPathInside(smokeRoot, home, "HOME")');
    expect(verifier).toContain('assertPathInside(smokeRoot, prefix, "npm prefix")');
    expect(verifier).toContain('fs.realpathSync(manifest.path)');
    expect(verifier).toContain('dangerousOriginalConfigRoot');
  });

  it('keeps the real browser handshake in a dedicated Linux job', () => {
    const registrationJob = readMacosNativeRegistrationJob();
    const browserJob = readCiJob('verify-browser-native-handshake');

    expect(registrationJob).not.toContain('verify-browser-native-handshake.mjs');
    expect(browserJob).toMatch(/runs-on:\s*ubuntu-latest/);
    expect(browserJob).toContain('browser-actions/setup-chrome@');
    expect(browserJob).toContain('node scripts/verify-browser-native-handshake.mjs');
  });
});
