import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveNodeTabId } from '@/entrypoints/background/record-replay/nodes/tab-context';
import { createMockExecCtx } from './_test-helpers';

describe('legacy node tab context contract', () => {
  const tabsGet = vi.fn();
  const tabsQuery = vi.fn();

  beforeEach(() => {
    tabsGet.mockReset();
    tabsQuery.mockReset();
    vi.stubGlobal('chrome', {
      tabs: {
        get: tabsGet,
        query: tabsQuery,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the workflow context tab without querying the active tab', async () => {
    tabsGet.mockResolvedValue({ id: 42, url: 'https://example.com/' });
    const ctx = createMockExecCtx({ tabId: 42 });

    await expect(resolveNodeTabId(ctx)).resolves.toBe(42);

    expect(tabsGet).toHaveBeenCalledWith(42);
    expect(tabsQuery).not.toHaveBeenCalled();
  });

  it('does not fall back to the active tab when the workflow tab is missing', async () => {
    tabsGet.mockRejectedValue(new Error('No tab'));
    tabsQuery.mockResolvedValue([{ id: 7, active: true }]);
    const ctx = createMockExecCtx({ tabId: 404 });

    await expect(resolveNodeTabId(ctx)).rejects.toThrow('Workflow tab 404 not found');

    expect(ctx.tabId).toBeUndefined();
    expect(tabsQuery).not.toHaveBeenCalled();
  });

  it('fails fast when the executor did not provide a workflow tab', async () => {
    tabsQuery.mockResolvedValue([{ id: 7, active: true }]);
    const ctx = createMockExecCtx();

    await expect(resolveNodeTabId(ctx)).rejects.toThrow(
      'Workflow tab is not set for legacy step execution',
    );

    expect(tabsGet).not.toHaveBeenCalled();
    expect(tabsQuery).not.toHaveBeenCalled();
  });
});
