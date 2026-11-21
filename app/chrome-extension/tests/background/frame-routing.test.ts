import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listMarkersForUrl: vi.fn() }));
vi.mock('@/entrypoints/background/element-marker/element-marker-storage', () => ({
  listMarkersForUrl: mocks.listMarkersForUrl,
}));

import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { readPageTool } from '@/entrypoints/background/tools/browser/read-page';
import {
  qualifyFrameRef,
  qualifyPageContentRefs,
  resolveRefTarget,
} from '@/entrypoints/background/tools/browser/target-resolution';

class ProbeTool extends BaseBrowserToolExecutor {
  name = 'probe';
  async execute() {
    return { content: [], isError: false };
  }
  send(...args: Parameters<BaseBrowserToolExecutor['sendMessageToTab']>) {
    return this.sendMessageToTab(...args);
  }
  ancestry(tabId: number, frameId: number) {
    return this.getFrameAncestry(tabId, frameId);
  }
}

describe('frame-qualified refs', () => {
  it('keeps bare refs in the top frame unless a frameId is given', () => {
    expect(resolveRefTarget('ref_4')).toEqual({ ref: 'ref_4' });
    expect(resolveRefTarget('ref_4', 9)).toEqual({ ref: 'ref_4', frameId: 9 });
  });

  it('routes qualified refs back to their frame', () => {
    expect(resolveRefTarget('f12:ref_3')).toEqual({ ref: 'ref_3', frameId: 12 });
    expect(resolveRefTarget('f12:ref_3', 12)).toEqual({ ref: 'ref_3', frameId: 12 });
  });

  it('rejects a qualified ref that contradicts an explicit frameId', () => {
    expect(() => resolveRefTarget('f12:ref_3', 4)).toThrow(/belongs to frame 12/);
  });

  it('qualifies only child-frame refs', () => {
    expect(qualifyFrameRef('ref_2', 0)).toBe('ref_2');
    expect(qualifyFrameRef('ref_2', undefined)).toBe('ref_2');
    expect(qualifyFrameRef('ref_2', 7)).toBe('f7:ref_2');
    expect(
      qualifyPageContentRefs('- textbox "A" [ref=ref_2] (x=1,y=2)\n- link [ref=ref_9]', 7),
    ).toBe('- textbox "A" [ref=f7:ref_2] (x=1,y=2)\n- link [ref=f7:ref_9]');
    expect(qualifyPageContentRefs('- link [ref=ref_9]', 0)).toBe('- link [ref=ref_9]');
  });
});

describe('BaseBrowserToolExecutor frame routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends to the top frame by default and broadcasts only on request', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    (globalThis.chrome as any).tabs.sendMessage = sendMessage;
    const tool = new ProbeTool();

    await tool.send(3, { action: 'x' });
    await tool.send(3, { action: 'x' }, 5);
    await tool.send(3, { action: 'x' }, 'all');

    expect(sendMessage.mock.calls[0]).toEqual([3, { action: 'x' }, { frameId: 0 }]);
    expect(sendMessage.mock.calls[1]).toEqual([3, { action: 'x' }, { frameId: 5 }]);
    expect(sendMessage.mock.calls[2]).toEqual([3, { action: 'x' }]);
  });

  it('resolves the ancestor chain of a nested frame', async () => {
    (globalThis.chrome as any).webNavigation.getAllFrames = vi.fn().mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: 'https://a.test/' },
      { frameId: 4, parentFrameId: 0, url: 'https://b.test/' },
      { frameId: 9, parentFrameId: 4, url: 'https://c.test/' },
    ]);
    const tool = new ProbeTool();
    await expect(tool.ancestry(1, 9)).resolves.toEqual([0, 4, 9]);
    await expect(tool.ancestry(1, 0)).resolves.toEqual([0]);
  });
});

describe('chrome_read_page frame scoping', () => {
  beforeEach(() => {
    mocks.listMarkersForUrl.mockReset();
    mocks.listMarkersForUrl.mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  function stubTab() {
    const tab = { id: 7, windowId: 2, url: 'https://example.com/', active: true } as chrome.tabs.Tab;
    vi.spyOn(readPageTool as any, 'tryGetTab').mockResolvedValue(tab);
    vi.spyOn(readPageTool as any, 'activateTabIfNeeded').mockResolvedValue(tab);
    vi.spyOn(readPageTool as any, 'injectAccessibilityHelper').mockResolvedValue(undefined);
    vi.spyOn(readPageTool as any, 'injectContentScript').mockResolvedValue(undefined);
  }

  const tree = (label: string) => ({
    success: true,
    pageContent: Array.from(
      { length: 12 },
      (_, i) => `- button "${label} ${i}" [ref=ref_${i + 1}] (x=1,y=${i})`,
    ).join('\n'),
    viewport: { width: 800, height: 600, dpr: 1 },
    stats: { processed: 12, included: 12, durationMs: 1 },
    refMap: Array.from({ length: 12 }, (_, i) => ({ ref: `ref_${i + 1}` })),
  });

  it('reads only the top frame and lists the other frames', async () => {
    stubTab();
    (globalThis.chrome as any).webNavigation.getAllFrames = vi.fn().mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: 'https://example.com/' },
      { frameId: 6, parentFrameId: 0, url: 'https://ads.test/frame' },
    ]);
    const send = vi.spyOn(readPageTool as any, 'sendMessageToTab').mockResolvedValue(tree('Main'));

    const result = await readPageTool.execute({ tabId: 7 });
    const payload = JSON.parse(String((result.content[0] as any).text));

    expect(send).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ action: 'generateAccessibilityTree' }),
      0,
    );
    expect(payload.pageContent).toContain('[ref=ref_1]');
    expect(payload.frames).toEqual([
      { frameId: 6, parentFrameId: 0, url: 'https://ads.test/frame' },
    ]);
  });

  it('qualifies refs when reading an iframe', async () => {
    stubTab();
    (globalThis.chrome as any).webNavigation.getAllFrames = vi.fn().mockResolvedValue([]);
    const send = vi.spyOn(readPageTool as any, 'sendMessageToTab').mockResolvedValue(tree('Child'));

    const result = await readPageTool.execute({ tabId: 7, frameId: 6 });
    const payload = JSON.parse(String((result.content[0] as any).text));

    expect(send).toHaveBeenCalledWith(7, expect.anything(), 6);
    expect(payload.frameId).toBe(6);
    expect(payload.pageContent).toContain('[ref=f6:ref_1]');
    expect(payload.pageContent).not.toContain('[ref=ref_1]');
  });

  it('reads the frame encoded in a qualified refId', async () => {
    stubTab();
    (globalThis.chrome as any).webNavigation.getAllFrames = vi.fn().mockResolvedValue([]);
    const send = vi.spyOn(readPageTool as any, 'sendMessageToTab').mockResolvedValue(tree('Child'));

    await readPageTool.execute({ tabId: 7, refId: 'f6:ref_3' });

    expect(send).toHaveBeenCalledWith(7, expect.objectContaining({ refId: 'ref_3' }), 6);
  });
});
