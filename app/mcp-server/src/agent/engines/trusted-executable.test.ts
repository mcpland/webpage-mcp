import { describe, expect, it, vi } from 'vitest';
import { resolveTrustedExecutable } from './trusted-executable';

describe('resolveTrustedExecutable', () => {
  it('pins the SDK node command to the current runtime', () => {
    const isRunnableFile = vi.fn(() => true);

    expect(
      resolveTrustedExecutable('node', {
        processExecPath: '/trusted/runtime/node',
        platform: 'linux',
        untrustedCwd: '/workspace/project',
        isRunnableFile,
        canonicalize: (candidate) => candidate,
      }),
    ).toBe('/trusted/runtime/node');
    expect(isRunnableFile).toHaveBeenCalledWith('/trusted/runtime/node', 'linux');
  });

  it('skips the project, empty PATH entries, and relative PATH entries', () => {
    const runnable = new Set([
      '/workspace/project/codex',
      '/trusted/bin/codex',
    ]);

    expect(
      resolveTrustedExecutable('codex', {
        env: { PATH: '/workspace/project::relative/bin:/trusted/bin' },
        platform: 'linux',
        untrustedCwd: '/workspace/project',
        isRunnableFile: (candidate) => runnable.has(candidate),
        canonicalize: (candidate) => candidate,
      }),
    ).toBe('/trusted/bin/codex');
  });

  it('does not let a Windows project-local cmd shim win executable lookup', () => {
    const runnable = new Set([
      'C:\\repo\\codex.CMD',
      'C:\\Trusted\\bin\\codex.CMD',
    ]);

    expect(
      resolveTrustedExecutable('codex', {
        env: {
          Path: 'C:\\repo;.\\bin;C:\\Trusted\\bin',
          PATHEXT: '.CMD;.EXE',
        },
        platform: 'win32',
        untrustedCwd: 'C:\\repo',
        isRunnableFile: (candidate) => runnable.has(candidate),
        canonicalize: (candidate) => candidate,
      }),
    ).toBe('C:\\Trusted\\bin\\codex.CMD');
  });

  it('rejects relative executable paths and absolute project executables', () => {
    const options = {
      platform: 'linux' as const,
      untrustedCwd: '/workspace/project',
      isRunnableFile: () => true,
      canonicalize: (candidate: string) => candidate,
    };

    expect(() => resolveTrustedExecutable('./codex', options)).toThrow(
      'Relative executable paths are not allowed',
    );
    expect(() =>
      resolveTrustedExecutable('/workspace/project/codex', options),
    ).toThrow('inside the project');
  });

  it('fails closed when PATH only contains current-directory candidates', () => {
    expect(() =>
      resolveTrustedExecutable('codex', {
        env: { PATH: ':relative/bin' },
        platform: 'linux',
        untrustedCwd: '/workspace/project',
        isRunnableFile: () => true,
        canonicalize: (candidate) => candidate,
      }),
    ).toThrow('Unable to resolve a trusted absolute executable');
  });
});
