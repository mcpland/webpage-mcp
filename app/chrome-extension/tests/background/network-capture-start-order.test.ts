import { beforeEach, describe, expect, it, vi } from 'vitest';

const cdp = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: cdp,
}));

function installWebRequestEvents(): void {
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  chrome.webRequest = {
    onBeforeRequest: event(),
    onSendHeaders: event(),
    onHeadersReceived: event(),
    onCompleted: event(),
    onErrorOccurred: event(),
  } as unknown as typeof chrome.webRequest;
}

const TARGET = 'https://example.com/app';

describe('network capture start with a url', () => {
  let order: string[];
  let tabUrl: string;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installWebRequestEvents();
    order = [];
    tabUrl = 'about:blank';
    vi.mocked(chrome.tabs.query).mockResolvedValue([]);
    vi.mocked(chrome.tabs.create).mockImplementation(async (props) => {
      order.push(`create:${props.url}`);
      return { id: 9, windowId: 1, url: props.url, title: '' } as chrome.tabs.Tab;
    });
    vi.mocked(chrome.tabs.update).mockImplementation(async (_id, props) => {
      if (props?.url) {
        order.push(`load:${props.url}`);
        tabUrl = props.url;
      }
      return { id: 9, windowId: 1, url: tabUrl } as chrome.tabs.Tab;
    });
    vi.mocked(chrome.tabs.get).mockImplementation(
      async () => ({ id: 9, windowId: 1, url: tabUrl, title: tabUrl === TARGET ? 'App' : '' }) as chrome.tabs.Tab,
    );
    cdp.attach.mockImplementation(async () => {
      order.push('attach');
    });
    cdp.detach.mockResolvedValue(undefined);
    cdp.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Network.enable') order.push('listening');
      return {};
    });
  });

  it('webRequest: listens before the new tab loads the url and reports the url', async () => {
    const { networkCaptureStartTool } = await import(
      '@/entrypoints/background/tools/browser/network-capture-web-request'
    );
    // webRequest listeners are global; the capture listens once its tab is registered.
    const original = (networkCaptureStartTool as any).startCaptureForTab.bind(networkCaptureStartTool);
    vi.spyOn(networkCaptureStartTool as any, 'startCaptureForTab').mockImplementation(
      async (...args: unknown[]) => {
        await original(...args);
        order.push('listening');
      },
    );

    const result = await networkCaptureStartTool.execute({ url: TARGET, background: true });
    const payload = JSON.parse(String((result.content[0] as { text?: string }).text));

    expect(order).toEqual(['create:about:blank', 'listening', `load:${TARGET}`]);
    expect(payload.url).toBe(TARGET);
    expect(networkCaptureStartTool.captureData.get(9)?.tabUrl).toBe(TARGET);

    const stopped = await networkCaptureStartTool.stopCapture(9);
    expect(stopped.data).toMatchObject({ tabUrl: TARGET, tabTitle: 'App' });
  });

  it('debugger: attaches before the new tab loads the url', async () => {
    const { networkDebuggerStartTool } = await import(
      '@/entrypoints/background/tools/browser/network-capture-debugger'
    );

    const result = await networkDebuggerStartTool.execute({ url: TARGET, background: true });
    const payload = JSON.parse(String((result.content[0] as { text?: string }).text));

    expect(order).toEqual(['create:about:blank', 'attach', 'listening', `load:${TARGET}`]);
    expect(payload.url).toBe(TARGET);
    await networkDebuggerStartTool.stopCapture(9);
  });

  it('debugger: loads the url first when the explicit tab cannot take a debugger yet', async () => {
    tabUrl = 'chrome://newtab/';
    const { networkDebuggerStartTool } = await import(
      '@/entrypoints/background/tools/browser/network-capture-debugger'
    );

    await networkDebuggerStartTool.execute({ url: TARGET, tabId: 9, background: true });

    expect(order.slice(0, 2)).toEqual([`load:${TARGET}`, 'attach']);
    await networkDebuggerStartTool.stopCapture(9);
  });
});
