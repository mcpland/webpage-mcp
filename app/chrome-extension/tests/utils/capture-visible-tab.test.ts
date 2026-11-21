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
    const second = captureVisibleTabPaced(undefined, { format: 'png' });
    await vi.runAllTimersAsync();
    await expect(first).resolves.toBe('data:image/png;base64,AA==');
    await expect(second).resolves.toBe('data:image/png;base64,AA==');

    expect(captureVisibleTab.mock.calls[0]).toEqual([3, { format: 'png' }]);
    expect(captureVisibleTab.mock.calls[1]).toEqual([{ format: 'png' }]);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(500);
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
});
