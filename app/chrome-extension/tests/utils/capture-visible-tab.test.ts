import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureVisibleTabPaced,
  resetCaptureVisibleTabPacerForTests,
} from '@/utils/capture-visible-tab';

describe('captureVisibleTabPaced', () => {
  let captureVisibleTab: ReturnType<typeof vi.fn>;
  const callTimes: number[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    resetCaptureVisibleTabPacerForTests();
    callTimes.length = 0;
    Object.assign(chrome.tabs, {
      get: vi.fn().mockResolvedValue({ active: true, windowId: 3 }),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
    });
    captureVisibleTab = vi.fn(async () => {
      callTimes.push(Date.now());
      return 'data:image/png;base64,AA==';
    });
    (globalThis.chrome as any).tabs.captureVisibleTab = captureVisibleTab;
    (globalThis.chrome as any).tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spaces consecutive captures by the per-second quota', async () => {
    const first = captureVisibleTabPaced(3, { format: 'png' });
    const second = captureVisibleTabPaced(5, { format: 'png' });
    await vi.runAllTimersAsync();
    await expect(first).resolves.toBe('data:image/png;base64,AA==');
    await expect(second).resolves.toBe('data:image/png;base64,AA==');

    expect(captureVisibleTab.mock.calls[0]).toEqual([3, { format: 'png' }]);
    expect(captureVisibleTab.mock.calls[1]).toEqual([3, { format: 'png' }]);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(500);
  });

  it('rejects a queued screenshot after the target loses focus', async () => {
    await captureVisibleTabPaced(5, {});
    const queued = expect(captureVisibleTabPaced(5, {})).rejects.toThrow('active tab');
    vi.mocked(chrome.tabs.get).mockResolvedValue({ active: false, windowId: 3 } as chrome.tabs.Tab);
    await vi.runAllTimersAsync();
    await queued;
    expect(captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it.each([5, 6])('discards pixels when tab %i was activated during capture', async (tabId) => {
    captureVisibleTab.mockImplementationOnce(async () => {
      vi.mocked(chrome.tabs.onActivated.addListener).mock.calls[0][0]({ windowId: 3, tabId });
      return 'other-tab-pixels';
    });
    await expect(captureVisibleTabPaced(5, {})).rejects.toThrow('active tab');
  });

  it('retries a quota rejection after waiting', async () => {
    captureVisibleTab.mockRejectedValueOnce(
      new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'),
    );
    const capture = captureVisibleTabPaced(3, { format: 'png' });
    await vi.runAllTimersAsync();
    await expect(capture).resolves.toBe('data:image/png;base64,AA==');
    expect(captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it('does not retry unrelated failures', async () => {
    captureVisibleTab.mockRejectedValueOnce(new Error('Cannot access contents of the page'));
    const capture = captureVisibleTabPaced(3, { format: 'png' });
    const assertion = expect(capture).rejects.toThrow('Cannot access contents of the page');
    await vi.runAllTimersAsync();
    await assertion;
    expect(captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it('times out a hung capture so subsequent captures are not deadlocked', async () => {
    captureVisibleTab.mockImplementationOnce(() => new Promise(() => {}));
    const first = captureVisibleTabPaced(3, { format: 'png' }, 100);
    const second = captureVisibleTabPaced(3, { format: 'png' }, 100);
    const firstRejection = expect(first).rejects.toThrow('timed out after 100ms');
    await vi.runAllTimersAsync();
    await firstRejection;
    await expect(second).resolves.toBe('data:image/png;base64,AA==');
    expect(captureVisibleTab).toHaveBeenCalledTimes(2);
  });
});
