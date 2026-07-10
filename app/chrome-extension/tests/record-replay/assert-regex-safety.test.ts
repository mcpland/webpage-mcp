import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';

import { WORKFLOW_REGEX_INPUT_MAX_UTF8_BYTES } from '@/entrypoints/background/record-replay/workflow-regex';

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
  resolveNodeTabId: vi.fn(),
  tabsSendMessage: vi.fn(),
  executeScript: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));

vi.mock('@/entrypoints/background/record-replay/nodes/tab-context', () => ({
  resolveNodeTabId: mocks.resolveNodeTabId,
}));

import { assertHandler } from '@/entrypoints/background/record-replay/actions/handlers/assert';
import { assertNode } from '@/entrypoints/background/record-replay/nodes/assert';

function createLegacyStep(matches: string, failStrategy: 'stop' | 'warn' = 'stop') {
  return {
    id: 'legacy-assert',
    type: 'assert',
    failStrategy,
    assert: {
      attribute: {
        selector: '#target',
        name: 'data-code',
        matches,
      },
    },
  } as any;
}

function createLegacyContext() {
  return {
    vars: {},
    frameId: 0,
    logger: vi.fn(),
  } as any;
}

function createHandlerAction(matches: string, timeoutMs = 1_000) {
  return {
    id: 'assert-handler',
    type: 'assert',
    params: {
      assert: {
        kind: 'attribute',
        selector: '#target',
        name: 'data-code',
        matches,
      },
      failStrategy: 'stop',
    },
    policy: { timeout: { ms: timeoutMs } },
  } as any;
}

function createHandlerContext() {
  return {
    tabId: 7,
    frameId: 0,
    vars: {},
    log: vi.fn(),
  } as any;
}

describe('assert regex execution safety', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.handleCallTool.mockResolvedValue({});
    mocks.resolveNodeTabId.mockResolvedValue(7);
    mocks.executeScript.mockImplementation(async (details: any) => {
      const serializedFunction = String(details.func);
      const reconstructed = runInNewContext(`(${serializedFunction})`, {
        document,
        window,
      }) as (...args: unknown[]) => unknown;
      return [{ result: reconstructed(...(details.args ?? [])) }];
    });
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: mocks.tabsSendMessage },
      scripting: { executeScript: mocks.executeScript },
    });
    document.body.innerHTML = '<div id="target" data-code="acct_123"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps ordinary legacy attribute regex assertions working', async () => {
    mocks.tabsSendMessage.mockResolvedValue({ success: true, value: 'acct_123' });
    await expect(
      assertNode.run(createLegacyContext(), createLegacyStep('^acct_[0-9]+$')),
    ).resolves.toEqual({});
  });

  it('rejects unsafe and oversized legacy attribute regex operands with bounded errors', async () => {
    mocks.tabsSendMessage.mockResolvedValue({ success: true, value: 'a'.repeat(32) + '!' });
    await expect(
      assertNode.run(createLegacyContext(), createLegacyStep('(a+)+$')),
    ).rejects.toThrow(/WORKFLOW_REGEX_UNSAFE/);

    mocks.tabsSendMessage.mockResolvedValue({
      success: true,
      value: 'a'.repeat(WORKFLOW_REGEX_INPUT_MAX_UTF8_BYTES + 1),
    });
    const oversized = assertNode.run(createLegacyContext(), createLegacyStep('^a+$'));
    await expect(oversized).rejects.toThrow(/WORKFLOW_REGEX_INPUT_TOO_LARGE/);
    await expect(oversized).rejects.not.toThrow('a'.repeat(1_024));
  });

  it('honors the legacy warn strategy for rejected regexes', async () => {
    const ctx = createLegacyContext();
    mocks.tabsSendMessage.mockResolvedValue({ success: true, value: 'aaaa!' });

    await expect(
      assertNode.run(ctx, createLegacyStep('(a|aa)+$', 'warn')),
    ).resolves.toEqual({ alreadyLogged: true });
    expect(ctx.logger).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'warning',
        message: expect.stringContaining('WORKFLOW_REGEX_UNSAFE'),
      }),
    );
  });

  it('rejects unsafe handler patterns before entering the page script', async () => {
    const result = await assertHandler.run(
      createHandlerContext(),
      createHandlerAction('(a+)+$'),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('WORKFLOW_REGEX_UNSAFE'),
      },
    });
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('reads in an isolated world but performs safe regex matching in the background', async () => {
    const result = await assertHandler.run(
      createHandlerContext(),
      createHandlerAction('^acct_[0-9]+$'),
    );

    expect(result).toEqual({ status: 'success' });
    const injection = mocks.executeScript.mock.calls[0]?.[0];
    expect(injection?.world).toBe('ISOLATED');
    const injectedFunction = injection?.func;
    expect(String(injectedFunction)).not.toContain('new RegExp');
    expect(String(injectedFunction)).not.toContain('testWorkflowRegex');
  });

  it('fails immediately when an isolated-world attribute exceeds the input byte cap', async () => {
    document.querySelector('#target')?.setAttribute(
      'data-code',
      'a'.repeat(WORKFLOW_REGEX_INPUT_MAX_UTF8_BYTES + 1),
    );

    const result = await assertHandler.run(
      createHandlerContext(),
      createHandlerAction('^a+$', 10_000),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'ASSERTION_FAILED',
        message: expect.stringContaining('WORKFLOW_REGEX_INPUT_TOO_LARGE'),
      },
    });
    if (result.status === 'failed') {
      const message = result.error?.message ?? '';
      expect(message).not.toContain('timeout:');
      expect(message.length).toBeLessThan(320);
    }
  });

  it('does not propagate oversized injected-script error messages', async () => {
    mocks.executeScript.mockResolvedValue([
      { result: { passed: false, message: 'x'.repeat(8 * 1024) } },
    ]);

    const result = await assertHandler.run(
      createHandlerContext(),
      createHandlerAction('^acct_[0-9]+$'),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        message: 'Assertion script returned an oversized error message',
      },
    });
  });
});
