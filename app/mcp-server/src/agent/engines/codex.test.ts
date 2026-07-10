import { describe, expect, it } from 'vitest';
import { CODEX_AUTO_INSTRUCTIONS } from 'webpage-mcp-shared';
import { buildCodexSandboxArgs } from './codex';

describe('buildCodexSandboxArgs', () => {
  it.each(['read-only', 'workspace-write'] as const)(
    'keeps the %s sandbox enabled for non-interactive execution',
    (sandboxMode) => {
      const args = buildCodexSandboxArgs({ sandboxMode });

      expect(args).toEqual(['--sandbox', sandboxMode, '--ask-for-approval', 'never']);
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    },
  );

  it('only bypasses approvals and sandbox for explicit danger-full-access mode', () => {
    expect(buildCodexSandboxArgs({ sandboxMode: 'danger-full-access' })).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('does not promise full permissions in the default prompt', () => {
    expect(CODEX_AUTO_INSTRUCTIONS).toContain('Respect the configured sandbox');
    expect(CODEX_AUTO_INSTRUCTIONS).not.toContain('You have full permissions');
  });
});
