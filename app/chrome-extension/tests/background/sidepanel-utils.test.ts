import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openAgentSetupSidepanel } from '@/entrypoints/background/utils/sidepanel';

describe('Agent Setup sidepanel navigation', () => {
  const setOptions = vi.fn();
  const open = vi.fn();

  beforeEach(() => {
    setOptions.mockReset().mockResolvedValue(undefined);
    open.mockReset().mockResolvedValue(undefined);
    (globalThis.chrome as unknown as { sidePanel: unknown }).sidePanel = {
      setOptions,
      open,
    };
  });

  it('opens Agent Setup and deep-links a valid session identifier', async () => {
    await openAgentSetupSidepanel(7, 3, ' session/with space ');

    expect(setOptions).toHaveBeenCalledWith({
      tabId: 7,
      path: 'sidepanel.html?tab=agent-setup&sessionId=session%2Fwith+space',
      enabled: true,
    });
    expect(open).toHaveBeenCalledWith({ tabId: 7 });
  });

  it('opens Agent Setup without preserving an empty session', async () => {
    await openAgentSetupSidepanel(9);

    expect(setOptions).toHaveBeenCalledWith({
      tabId: 9,
      path: 'sidepanel.html?tab=agent-setup',
      enabled: true,
    });
  });

  it('falls back to the sender window when tab-level opening fails', async () => {
    open.mockRejectedValueOnce(new Error('tab unavailable'));

    await openAgentSetupSidepanel(11, 4);

    expect(open).toHaveBeenNthCalledWith(1, { tabId: 11 });
    expect(open).toHaveBeenNthCalledWith(2, { windowId: 4 });
  });
});
