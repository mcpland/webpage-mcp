import { afterEach, describe, expect, it, vi } from 'vitest';
import { getInteractiveElementsTool } from '@/entrypoints/background/tools/browser/web-fetcher';

function makeTab(): chrome.tabs.Tab {
  return {
    id: 7,
    index: 0,
    windowId: 2,
    title: 'Example',
    url: 'https://example.com/',
    status: 'complete',
    active: true,
  } as chrome.tabs.Tab;
}

describe('getInteractiveElementsTool resource boundaries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects oversized and expensive selectors before touching a tab', async () => {
    const tryGetTab = vi
      .spyOn(getInteractiveElementsTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab());

    for (const selector of [`#${'a'.repeat(4097)}`, 'main:has(button)']) {
      const result = await getInteractiveElementsTool.execute({ selector });
      expect(result.isError).toBe(true);
    }

    expect(tryGetTab).not.toHaveBeenCalled();
  });

  it('rejects unknown or excessive type filters before injection', async () => {
    const injectContentScript = vi
      .spyOn(getInteractiveElementsTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    for (const types of [
      ['button', 'unknown'],
      Array.from({ length: 10 }, () => 'button'),
    ]) {
      const result = await getInteractiveElementsTool.execute({ types });
      expect(result.isError).toBe(true);
    }

    expect(injectContentScript).not.toHaveBeenCalled();
  });

  it('re-bounds a hostile content-script response before JSON serialization', async () => {
    vi.spyOn(getInteractiveElementsTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    vi.spyOn(getInteractiveElementsTool as any, 'injectContentScript').mockResolvedValue(
      undefined,
    );
    vi.spyOn(getInteractiveElementsTool as any, 'sendMessageToTab').mockResolvedValue({
      success: true,
      elements: Array.from({ length: 500 }, (_, index) => ({
        type: 'button'.repeat(100),
        selector: `#item-${index}${'a'.repeat(20_000)}`,
        text: '😀'.repeat(20_000),
        isInteractive: true,
        coordinates: {
          x: index,
          y: index,
          rect: { x: index, y: index, width: 1, height: 1 },
        },
      })),
    });

    const result = await getInteractiveElementsTool.execute({
      textQuery: 'action',
      types: ['button'],
    });
    const text = String((result.content[0] as { text?: string })?.text || '');
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(payload).toMatchObject({ success: true, truncated: true });
    expect(payload.count).toBe(payload.elements.length);
    expect(payload.elements.length).toBeGreaterThan(0);
    expect(payload.elements.length).toBeLessThanOrEqual(200);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(512 * 1024);
    expect(payload.elements[0].type.length).toBeLessThan(100);
    expect(new TextEncoder().encode(payload.elements[0].text).byteLength).toBeLessThanOrEqual(
      1024,
    );
  });
});
