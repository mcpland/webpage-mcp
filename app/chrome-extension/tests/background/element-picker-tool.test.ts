import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ELEMENT_PICKER_MAX_DESCRIPTION_JSON_BYTES,
  ELEMENT_PICKER_MAX_ID_JSON_BYTES,
  ELEMENT_PICKER_MAX_NAME_JSON_BYTES,
  ELEMENT_PICKER_MAX_REF_JSON_BYTES,
  ELEMENT_PICKER_MAX_REQUESTS,
  ELEMENT_PICKER_MAX_RESULT_UTF8_BYTES,
  ELEMENT_PICKER_MAX_SELECTOR_JSON_BYTES,
  ELEMENT_PICKER_MAX_TAG_JSON_BYTES,
  ELEMENT_PICKER_MAX_TEXT_JSON_BYTES,
  elementPickerTool,
} from '@/entrypoints/background/tools/browser/element-picker';
import {
  measureJsonBytes,
  measureUtf8Bytes,
} from '@/entrypoints/background/tools/browser/bounded-tool-output';
import {
  BACKGROUND_MESSAGE_TYPES,
  TOOL_MESSAGE_TYPES,
} from '@/common/message-types';

function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 7,
    index: 0,
    windowId: 2,
    title: 'Secret',
    url: 'file:///tmp/secret.txt',
    status: 'complete',
    active: true,
    ...overrides,
  } as chrome.tabs.Tab;
}

describe('elementPickerTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects file URL tabs before starting element selection', async () => {
    const tryGetTab = vi
      .spyOn(elementPickerTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab());
    const ensureFocus = vi
      .spyOn(elementPickerTool as any, 'ensureFocus')
      .mockResolvedValue(undefined);

    const result = await elementPickerTool.execute({
      tabId: 7,
      requests: [{ name: 'Primary button' }],
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_request_element_selection',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(ensureFocus).not.toHaveBeenCalled();
  });

  it('rejects oversized request counts and fields before resolving a tab', async () => {
    const tryGetTab = vi.spyOn(elementPickerTool as any, 'tryGetTab');

    const countResult = await elementPickerTool.execute({
      requests: Array.from({ length: ELEMENT_PICKER_MAX_REQUESTS + 1 }, () => ({
        name: 'Target',
      })),
    });
    const fieldResult = await elementPickerTool.execute({
      requests: [
        {
          id: 'i'.repeat(ELEMENT_PICKER_MAX_ID_JSON_BYTES + 1),
          name: 'n'.repeat(ELEMENT_PICKER_MAX_NAME_JSON_BYTES + 1),
          description: 'd'.repeat(
            ELEMENT_PICKER_MAX_DESCRIPTION_JSON_BYTES + 1,
          ),
        },
      ],
    });

    expect(countResult.isError).toBe(true);
    expect(fieldResult.isError).toBe(true);
    expect(tryGetTab).not.toHaveBeenCalled();
  });

  it('sanitizes picked element fields and bounds the final result', async () => {
    vi.spyOn(elementPickerTool as any, 'tryGetTab').mockResolvedValue(
      makeTab({ url: 'https://example.com/', title: 'Example' }),
    );
    vi.spyOn(elementPickerTool as any, 'ensureFocus').mockResolvedValue(
      undefined,
    );
    vi.spyOn(elementPickerTool as any, 'injectPickerScripts').mockResolvedValue(
      undefined,
    );
    vi.spyOn(elementPickerTool as any, 'callPickerApi').mockResolvedValue(
      undefined,
    );

    let sessionId = '';
    vi.spyOn(elementPickerTool as any, 'sendMessageToTab').mockImplementation(
      async (...args: unknown[]) => {
        const message = (args[1] || {}) as {
          action?: string;
          sessionId?: string;
        };
        if (message.action === TOOL_MESSAGE_TYPES.ELEMENT_PICKER_UI_SHOW) {
          sessionId = message.sessionId || '';
        }
        return { success: true };
      },
    );
    let runtimeListener:
      | Parameters<typeof chrome.runtime.onMessage.addListener>[0]
      | undefined;
    const addListener = vi
      .spyOn(chrome.runtime.onMessage, 'addListener')
      .mockImplementation((listener) => {
        runtimeListener = listener;
      });
    const removeListener = vi.spyOn(
      chrome.runtime.onMessage,
      'removeListener',
    );

    const pending = elementPickerTool.execute({
      tabId: 7,
      requests: [{ id: 'target', name: 'Target element' }],
    });
    await vi.waitFor(() => expect(runtimeListener).toBeDefined());
    expect(sessionId).not.toBe('');

    const huge = 'x'.repeat(50_000);
    runtimeListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_PICKER_FRAME_EVENT,
        sessionId,
        event: 'selected',
        requestId: 'target',
        element: {
          ref: huge,
          selector: huge,
          text: huge,
          tagName: huge,
          rect: {
            x: Number.POSITIVE_INFINITY,
            y: Number.NEGATIVE_INFINITY,
            width: { nested: huge },
            height: 1e20,
            extra: huge,
          },
          center: { x: 12, y: 'invalid', extra: huge },
        },
      },
      { tab: makeTab(), frameId: 2 },
      vi.fn(),
    );
    runtimeListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_PICKER_UI_EVENT,
        sessionId,
        event: 'confirm',
      },
      { tab: makeTab(), frameId: 0 },
      vi.fn(),
    );

    const result = await pending;
    const text = String((result.content[0] as { text?: string })?.text || '');
    const payload = JSON.parse(text);
    const element = payload.results[0].element;

    expect(result.isError).toBe(false);
    expect(payload.truncated).toBe(true);
    expect(measureUtf8Bytes(text)).toBeLessThanOrEqual(
      ELEMENT_PICKER_MAX_RESULT_UTF8_BYTES,
    );
    expect(measureJsonBytes(element.ref)).toBeLessThanOrEqual(
      ELEMENT_PICKER_MAX_REF_JSON_BYTES,
    );
    expect(measureJsonBytes(element.selector)).toBeLessThanOrEqual(
      ELEMENT_PICKER_MAX_SELECTOR_JSON_BYTES,
    );
    expect(measureJsonBytes(element.text)).toBeLessThanOrEqual(
      ELEMENT_PICKER_MAX_TEXT_JSON_BYTES,
    );
    expect(measureJsonBytes(element.tagName)).toBeLessThanOrEqual(
      ELEMENT_PICKER_MAX_TAG_JSON_BYTES,
    );
    expect(element.rect).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 10_000_000,
    });
    expect(element.center).toEqual({ x: 12, y: 0 });
    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith(runtimeListener);
  });
});
