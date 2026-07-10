import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

const storageMocks = vi.hoisted(() => ({
  deleteMarker: vi.fn(),
  listAllMarkersWithMetadata: vi.fn(),
  listMarkersForUrlWithMetadata: vi.fn(),
  saveMarker: vi.fn(),
  updateMarker: vi.fn(),
}));

const toolMocks = vi.hoisted(() => ({
  computerExecute: vi.fn(),
  clickExecute: vi.fn(),
  keyboardExecute: vi.fn(),
}));

vi.mock('@/entrypoints/background/element-marker/element-marker-storage', () => storageMocks);
vi.mock('@/entrypoints/background/tools/browser/computer', () => ({
  computerTool: { execute: toolMocks.computerExecute },
}));
vi.mock('@/entrypoints/background/tools/browser/interaction', () => ({
  clickTool: { execute: toolMocks.clickExecute },
}));
vi.mock('@/entrypoints/background/tools/browser/keyboard', () => ({
  keyboardTool: { execute: toolMocks.keyboardExecute },
}));

type RuntimeListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | undefined;

describe('Element Marker target authorization', () => {
  let runtimeListener: RuntimeListener;
  let committedListener: (details: { tabId: number; frameId: number }) => void;
  let removedListener: (tabId: number) => void;
  let markerSessionId: string;
  let documents: Map<number, string>;
  let tabsSendMessage: ReturnType<typeof vi.fn>;
  let tabsQuery: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    markerSessionId = '';
    documents = new Map([
      [7, 'document-a'],
      [8, 'document-b'],
      [99, 'document-active'],
    ]);

    tabsQuery = vi.fn().mockResolvedValue([{ id: 99, active: true }]);
    tabsSendMessage = vi.fn().mockImplementation(async (tabId: number, message: any) => {
      if (message?.action === 'element_marker_ping') return { status: 'pong' };
      if (message?.action === 'element_marker_start') {
        markerSessionId = message.markerSessionId;
        return { ok: true };
      }
      if (message?.action === 'ensureRefForSelector') {
        return { success: true, ref: 'ref-1', center: { x: 10, y: 20 } };
      }
      throw new Error(`unexpected message for tab ${tabId}: ${message?.action}`);
    });

    toolMocks.computerExecute.mockResolvedValue({ isError: false, content: [] });
    toolMocks.clickExecute.mockResolvedValue({ isError: false, content: [] });
    toolMocks.keyboardExecute.mockResolvedValue({ isError: false, content: [] });
    storageMocks.listAllMarkersWithMetadata.mockResolvedValue({
      markers: [],
      truncated: false,
    });
    storageMocks.listMarkersForUrlWithMetadata.mockResolvedValue({
      markers: [],
      truncated: false,
    });
    storageMocks.saveMarker.mockResolvedValue({ id: 'saved-marker' });
    storageMocks.updateMarker.mockResolvedValue(undefined);
    storageMocks.deleteMarker.mockResolvedValue(undefined);

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension-id',
        getURL: vi.fn((path = '') => `chrome-extension://test-extension-id/${path}`),
        onMessage: {
          addListener: vi.fn((listener: RuntimeListener) => {
            runtimeListener = listener;
          }),
        },
      },
      contextMenus: {
        create: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        onClicked: { addListener: vi.fn() },
      },
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
      tabs: {
        query: tabsQuery,
        sendMessage: tabsSendMessage,
        onRemoved: {
          addListener: vi.fn((listener: (tabId: number) => void) => {
            removedListener = listener;
          }),
        },
      },
      webNavigation: {
        getAllFrames: vi.fn(async ({ tabId }: { tabId: number }) => {
          const documentId = documents.get(tabId);
          return documentId ? [{ tabId, frameId: 0, documentId }] : [];
        }),
        onCommitted: {
          addListener: vi.fn(
            (listener: (details: { tabId: number; frameId: number }) => void) => {
              committedListener = listener;
            },
          ),
        },
      },
    });

    const { initElementMarkerListeners } = await import(
      '@/entrypoints/background/element-marker'
    );
    initElementMarkerListeners();
  });

  async function dispatch(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
    return new Promise((resolve) => {
      const keepChannelOpen = runtimeListener(message, sender, resolve);
      if (keepChannelOpen !== true) queueMicrotask(() => resolve(undefined));
    });
  }

  async function startMarker(tabId = 7): Promise<void> {
    const response = await dispatch(
      { type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_START, tabId },
      extensionSender(),
    );
    expect(response).toMatchObject({ success: true });
    expect(markerSessionId).not.toBe('');
  }

  function markerSender(tabId = 7, documentId = 'document-a'): chrome.runtime.MessageSender {
    return {
      id: 'test-extension-id',
      tab: { id: tabId } as chrome.tabs.Tab,
      frameId: 0,
      documentId,
      url: `https://tab-${tabId}.example/`,
      origin: `https://tab-${tabId}.example`,
    };
  }

  function extensionSender(): chrome.runtime.MessageSender {
    return {
      id: 'test-extension-id',
      url: 'chrome-extension://test-extension-id/popup.html',
      origin: 'chrome-extension://test-extension-id',
    };
  }

  it('restricts marker management to extension pages', async () => {
    const sender = markerSender();
    const messages = [
      { type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_LIST_ALL },
      { type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_LIST_FOR_URL, url: sender.url },
      {
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_UPDATE,
        marker: { id: 'marker-id' },
      },
      { type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_DELETE, id: 'marker-id' },
    ];

    for (const message of messages) {
      await expect(dispatch(message, sender)).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('extension page'),
      });
    }

    expect(storageMocks.listAllMarkersWithMetadata).not.toHaveBeenCalled();
    expect(storageMocks.listMarkersForUrlWithMetadata).not.toHaveBeenCalled();
    expect(storageMocks.updateMarker).not.toHaveBeenCalled();
    expect(storageMocks.deleteMarker).not.toHaveBeenCalled();
  });

  it('allows extension pages to manage markers', async () => {
    const sender = extensionSender();

    await expect(
      dispatch({ type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_LIST_ALL }, sender),
    ).resolves.toMatchObject({ success: true, markers: [] });
    await expect(
      dispatch(
        {
          type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE,
          marker: { url: 'https://example.test/', name: 'Example', selector: '#example' },
        },
        sender,
      ),
    ).resolves.toMatchObject({ success: true });
    await expect(
      dispatch(
        {
          type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_UPDATE,
          marker: { id: 'marker-id' },
        },
        sender,
      ),
    ).resolves.toMatchObject({ success: true });
    await expect(
      dispatch({ type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_DELETE, id: 'marker-id' }, sender),
    ).resolves.toMatchObject({ success: true });

    expect(storageMocks.listAllMarkersWithMetadata).toHaveBeenCalledOnce();
    expect(storageMocks.saveMarker).toHaveBeenCalledOnce();
    expect(storageMocks.updateMarker).toHaveBeenCalledOnce();
    expect(storageMocks.deleteMarker).toHaveBeenCalledOnce();
  });

  it('requires a document-bound session and URL for in-page saves', async () => {
    const marker = {
      url: 'https://tab-7.example/',
      name: 'Transfer',
      selector: '#transfer',
    };

    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE, marker },
        markerSender(),
      ),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('session') });

    await startMarker(7);
    await expect(
      dispatch(
        {
          type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE,
          markerSessionId,
          marker: { ...marker, url: 'https://other.example/' },
        },
        markerSender(),
      ),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('URL') });
    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE, markerSessionId, marker },
        markerSender(),
      ),
    ).resolves.toMatchObject({ success: true });

    expect(storageMocks.saveMarker).toHaveBeenCalledOnce();
    expect(storageMocks.saveMarker).toHaveBeenCalledWith(marker);
  });

  it('keeps validation on the sender tab when another tab becomes active', async () => {
    await startMarker(7);

    const response = await dispatch(
      {
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_VALIDATE,
        markerSessionId,
        selector: '#transfer',
        action: 'left_click',
      },
      markerSender(),
    );

    expect(response.tool).toMatchObject({ name: 'interaction.click', ok: true });
    expect(tabsQuery).not.toHaveBeenCalled();
    expect(toolMocks.clickExecute).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7, ref: 'ref-1' }),
    );
    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ action: 'ensureRefForSelector' }),
      { documentId: 'document-a' },
    );
  });

  it('rejects a forged validation from a different tab', async () => {
    await startMarker(7);

    const response = await dispatch(
      {
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_VALIDATE,
        markerSessionId,
        selector: '#transfer',
        action: 'left_click',
      },
      markerSender(8, 'document-b'),
    );

    expect(response).toMatchObject({
      success: false,
      error: expect.stringContaining('session'),
    });
    expect(toolMocks.clickExecute).not.toHaveBeenCalled();
  });

  it('rejects validation from the wrong frame or document', async () => {
    await startMarker(7);
    const request = {
      type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_VALIDATE,
      markerSessionId,
      selector: '#transfer',
      action: 'left_click',
    };

    const wrongFrame = await dispatch(request, { ...markerSender(), frameId: 4 });
    const wrongDocument = await dispatch(request, markerSender(7, 'document-stale'));

    expect(wrongFrame).toMatchObject({ success: false });
    expect(wrongDocument).toMatchObject({ success: false });
    expect(toolMocks.clickExecute).not.toHaveBeenCalled();
  });

  it('invalidates the session after a top-frame navigation or tab close', async () => {
    await startMarker(7);
    committedListener({ tabId: 7, frameId: 0 });

    const afterNavigation = await dispatch(
      {
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_VALIDATE,
        markerSessionId,
        selector: '#transfer',
        action: 'left_click',
      },
      markerSender(),
    );
    expect(afterNavigation).toMatchObject({ success: false });

    await startMarker(7);
    removedListener(7);
    const afterClose = await dispatch(
      {
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_VALIDATE,
        markerSessionId,
        selector: '#transfer',
        action: 'left_click',
      },
      markerSender(),
    );
    expect(afterClose).toMatchObject({ success: false });
    expect(toolMocks.clickExecute).not.toHaveBeenCalled();
  });

  it('passes the bound tab to every downstream input tool', async () => {
    await startMarker(7);

    const actions = [
      { action: 'hover' },
      { action: 'left_click' },
      { action: 'double_click' },
      { action: 'right_click' },
      { action: 'scroll' },
      { action: 'type_text', text: 'safe text' },
      { action: 'press_keys', keys: 'Enter' },
    ];

    for (const action of actions) {
      const response = await dispatch(
        {
          type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_VALIDATE,
          markerSessionId,
          selector: '#target',
          ...action,
        },
        markerSender(),
      );
      expect(response.tool?.ok).toBe(true);
    }

    for (const [args] of toolMocks.computerExecute.mock.calls) {
      expect(args).toMatchObject({ tabId: 7 });
    }
    for (const [args] of toolMocks.clickExecute.mock.calls) {
      expect(args).toMatchObject({ tabId: 7 });
    }
    for (const [args] of toolMocks.keyboardExecute.mock.calls) {
      expect(args).toMatchObject({ tabId: 7 });
    }
    expect(toolMocks.computerExecute).toHaveBeenCalled();
    expect(toolMocks.clickExecute).toHaveBeenCalled();
    expect(toolMocks.keyboardExecute).toHaveBeenCalled();
  });
});
