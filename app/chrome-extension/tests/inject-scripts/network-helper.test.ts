import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageListener = (
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

describe('network-helper', () => {
  let messageListener: RuntimeMessageListener | null = null;
  const fetchMock = vi.fn();
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

  async function loadHelper(pageUrl = 'https://example.com/page'): Promise<void> {
    messageListener = null;
    const location = new URL(pageUrl);

    vi.stubGlobal('window', { location });
    vi.stubGlobal('location', location);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: RuntimeMessageListener) => {
            messageListener = listener;
          }),
        },
      },
    });

    await import('@/inject-scripts/network-helper.js');
  }

  async function dispatchMessage(request: any): Promise<any> {
    if (!messageListener) {
      throw new Error('network-helper did not register a runtime message listener');
    }

    return await new Promise((resolve) => {
      const handled = messageListener!(request, {} as chrome.runtime.MessageSender, resolve);
      expect(handled).toBe(true);
    });
  }

  beforeEach(async () => {
    fetchMock.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    await loadHelper();
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = null;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([
    {
      name: 'object formData descriptors',
      formData: {
        fields: { kind: 'avatar' },
        files: [{ name: 'upload', filePath: '/tmp/secret.txt' }],
      },
    },
    {
      name: 'compact array formData descriptors',
      formData: [['upload', 'file:/tmp/secret.txt']],
    },
  ])('returns an error without sending the request for unsupported local paths in $name', async ({ formData }) => {
    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: 'https://example.com/upload',
      method: 'POST',
      formData,
      timeout: 1000,
    });

    expect(response).toEqual(
      expect.objectContaining({
        success: false,
      }),
    );
    expect(String(response.error || '')).toContain('Local file paths are not supported');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects requests from non-public page contexts before fetching relative URLs', async () => {
    vi.resetModules();
    await loadHelper('file:///tmp/secret.html');

    const response = await dispatchMessage({
      action: 'sendPureNetworkRequest',
      url: './relative-endpoint',
      method: 'GET',
      timeout: 1000,
    });

    expect(response).toEqual(
      expect.objectContaining({
        success: false,
      }),
    );
    expect(String(response.error || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_network_request',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
