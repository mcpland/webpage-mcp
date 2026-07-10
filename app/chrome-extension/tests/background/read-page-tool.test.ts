import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listMarkersForUrl: vi.fn(),
}));

vi.mock(
  '@/entrypoints/background/element-marker/element-marker-storage',
  () => ({
    listMarkersForUrl: mocks.listMarkersForUrl,
  }),
);

import { readPageTool } from '@/entrypoints/background/tools/browser/read-page';

function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 7,
    index: 0,
    windowId: 2,
    title: 'Example',
    url: 'https://example.com/',
    status: 'complete',
    active: true,
    ...overrides,
  } as chrome.tabs.Tab;
}

describe('readPageTool', () => {
  beforeEach(() => {
    mocks.listMarkersForUrl.mockReset();
    mocks.listMarkersForUrl.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects file URL tabs before injecting content scripts', async () => {
    const tryGetTab = vi
      .spyOn(readPageTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const getActiveTabOrThrowInWindow = vi
      .spyOn(readPageTool as any, 'getActiveTabOrThrowInWindow')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const injectContentScript = vi
      .spyOn(readPageTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(readPageTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true, pageContent: 'secret' });

    const result = await readPageTool.execute({ tabId: 7 });

    expect(result.isError).toBe(true);
    expect(
      String((result.content[0] as { text?: string })?.text || ''),
    ).toContain(
      'Only http:// and https:// pages are supported by chrome_read_page',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(getActiveTabOrThrowInWindow).not.toHaveBeenCalled();
    expect(injectContentScript).not.toHaveBeenCalled();
    expect(sendMessageToTab).not.toHaveBeenCalled();
  });

  it('rejects unbounded filter and ref inputs before touching a tab', async () => {
    const tryGetTab = vi.spyOn(readPageTool as any, 'tryGetTab').mockResolvedValue(makeTab());

    const invalidFilter = await readPageTool.execute({ filter: 'all' as any });
    const oversizedRef = await readPageTool.execute({ refId: 'r'.repeat(129) });

    expect(invalidFilter.isError).toBe(true);
    expect(oversizedRef.isError).toBe(true);
    expect(tryGetTab).not.toHaveBeenCalled();
  });

  it('activates an inactive target tab before reading the page', async () => {
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue(makeTab({ active: true })),
        update: vi.fn().mockResolvedValue(makeTab({ active: true })),
        sendMessage: vi.fn(),
      },
      windows: {
        update: vi.fn().mockResolvedValue({}),
      },
      scripting: {
        executeScript: vi.fn(),
      },
    });

    const tryGetTab = vi
      .spyOn(readPageTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ active: false }));
    const injectContentScript = vi
      .spyOn(readPageTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(readPageTool as any, 'sendMessageToTab')
      .mockResolvedValue({
        success: true,
        pageContent: Array.from(
          { length: 10 },
          (_, index) => `- link "item ${index}"`,
        ).join('\n'),
        viewport: { width: 800, height: 600, dpr: 2 },
        stats: { processed: 10, included: 10, durationMs: 1 },
        refMap: [{ ref: 'ref_1' }, { ref: 'ref_2' }, { ref: 'ref_3' }],
      });

    const result = await readPageTool.execute({ tabId: 7 });

    expect(result.isError).toBe(false);
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(chrome.windows.update).toHaveBeenCalledWith(2, { focused: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(injectContentScript).toHaveBeenCalled();
    expect(sendMessageToTab).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ action: 'generateAccessibilityTree' }),
    );
  });

  it('re-bounds interactive fallback fields from the page before returning them', async () => {
    vi.spyOn(readPageTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    vi.spyOn(readPageTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(readPageTool as any, 'activateTabIfNeeded').mockResolvedValue(makeTab());
    vi.spyOn(readPageTool as any, 'sendMessageToTab')
      .mockResolvedValueOnce({
        success: true,
        pageContent: '',
        viewport: { width: 800, height: 600, dpr: 1 },
        stats: { processed: 0, included: 0, durationMs: 1 },
        refMap: [],
      })
      .mockResolvedValueOnce({
        success: true,
        elements: Array.from({ length: 300 }, (_, index) => ({
          type: 'button',
          selector: `#item-${index}${'a'.repeat(20_000)}`,
          text: '😀'.repeat(20_000),
          isInteractive: true,
        })),
      });

    const result = await readPageTool.execute({ tabId: 7, background: true });
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(result.isError).toBe(false);
    expect(payload).toMatchObject({
      fallbackUsed: true,
      fallbackSource: 'get_interactive_elements',
      truncated: true,
    });
    expect(payload.count).toBe(payload.elements.length);
    expect(payload.elements.length).toBeGreaterThan(0);
    expect(payload.elements.length).toBeLessThanOrEqual(150);
    expect(new TextEncoder().encode(payload.elements[0].text).byteLength).toBeLessThanOrEqual(
      1024,
    );
  });

  it('re-bounds the primary page tree and viewport at the background boundary', async () => {
    vi.spyOn(readPageTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    vi.spyOn(readPageTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(readPageTool as any, 'activateTabIfNeeded').mockResolvedValue(makeTab());
    vi.spyOn(readPageTool as any, 'sendMessageToTab').mockResolvedValue({
      success: true,
      pageContent: '😀'.repeat(200_000),
      viewport: { width: 'x'.repeat(100_000), height: Infinity, dpr: 2 },
      stats: { processed: Infinity, included: -1, durationMs: 2 },
      refMap: [{}, {}, {}],
    });

    const result = await readPageTool.execute({ tabId: 7 });
    const text = String((result.content[0] as { text?: string })?.text || '{}');
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(payload.truncated).toBe(true);
    expect(new TextEncoder().encode(payload.pageContent).byteLength).toBeLessThanOrEqual(
      384 * 1024,
    );
    expect(payload.viewport).toEqual({ width: 0, height: 0, dpr: 2 });
    expect(payload.stats).toEqual({ processed: 0, included: 0, durationMs: 2 });
  });
});
