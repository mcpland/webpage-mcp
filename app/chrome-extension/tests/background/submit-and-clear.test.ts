import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: mocks,
}));

import { computerTool } from '@/entrypoints/background/tools/browser/computer';
import { fillTool } from '@/entrypoints/background/tools/browser/interaction';

const httpTab = {
  id: 7,
  index: 0,
  windowId: 2,
  url: 'https://example.com/login',
  active: true,
} as chrome.tabs.Tab;

/** Key presses and inserted text sent over CDP, in order. */
function inputLog(): string[] {
  return mocks.sendCommand.mock.calls.flatMap(([, method, params]: any[]) => {
    if (method === 'Input.insertText') return [`text:${params.text}`];
    if (method === 'Input.dispatchKeyEvent' && /^(rawKeyDown|keyDown)$/.test(params.type)) {
      return [params.key];
    }
    return [];
  });
}

const payloadOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(String(result.content[0]?.text || '{}'));

describe('submit and clear options', () => {
  beforeEach(() => {
    mocks.attach.mockResolvedValue(undefined);
    mocks.detach.mockResolvedValue(undefined);
    mocks.sendCommand.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('chrome_fill_or_select presses Enter in the field after filling it', async () => {
    vi.spyOn(fillTool as any, 'tryGetTab').mockResolvedValue(httpTab);
    vi.spyOn(fillTool as any, 'injectContentScript').mockResolvedValue(undefined);
    const fillMessage = vi
      .spyOn(fillTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true, message: 'Filled' });

    const result = await fillTool.execute({
      tabId: 7,
      selector: '#q',
      value: 'webpage mcp',
      submit: true,
      background: true,
    });

    expect(result.isError).toBe(false);
    expect(payloadOf(result)).toMatchObject({ success: true, submitted: true });
    // The field must stay focused for Enter to land in it.
    expect(fillMessage.mock.calls[0][1]).toMatchObject({ action: 'fillElement', keepFocus: true });
    expect(inputLog()).toEqual(['Enter']);
    const enterCall = mocks.sendCommand.mock.calls.findIndex(
      ([, method]: any[]) => method === 'Input.dispatchKeyEvent',
    );
    expect(fillMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendCommand.mock.invocationCallOrder[enterCall],
    );
  });

  it('chrome_fill_or_select does not press Enter unless asked', async () => {
    vi.spyOn(fillTool as any, 'tryGetTab').mockResolvedValue(httpTab);
    vi.spyOn(fillTool as any, 'injectContentScript').mockResolvedValue(undefined);
    const fillMessage = vi
      .spyOn(fillTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true });

    const result = await fillTool.execute({ tabId: 7, selector: '#q', value: 'x', background: true });

    expect(payloadOf(result).submitted).toBeUndefined();
    expect(fillMessage.mock.calls[0][1]).not.toHaveProperty('keepFocus');
    expect(inputLog()).toEqual([]);
  });

  it('computer type clears the field, types, then submits in one input sequence', async () => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(httpTab);

    const result = await computerTool.execute({
      tabId: 7,
      action: 'type',
      text: 'hello',
      clear: true,
      submit: true,
      background: true,
    } as any);

    expect(result.isError).toBe(false);
    expect(payloadOf(result)).toMatchObject({ cleared: true, submitted: true, length: 5 });
    expect(inputLog()).toEqual(['Control', 'a', 'Backspace', 'text:hello', 'Enter']);
  });

  it('computer type with clear and no text just empties the field', async () => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(httpTab);

    const result = await computerTool.execute({
      tabId: 7,
      action: 'type',
      clear: true,
      background: true,
    } as any);

    expect(result.isError).toBe(false);
    expect(inputLog()).toEqual(['Control', 'a', 'Backspace']);
  });

  it('fill_form submits from the last field only when every field was filled', async () => {
    vi.spyOn(computerTool as any, 'tryGetTab').mockResolvedValue(httpTab);
    const ok = { content: [{ type: 'text', text: '{"success":true}' }], isError: false };
    const fill = vi.spyOn(fillTool, 'execute').mockResolvedValue(ok as any);
    const elements = [
      { ref: 'ref_1', value: 'ada' },
      { ref: 'ref_2', value: 'secret' },
    ];

    const sent = await computerTool.execute({
      tabId: 7,
      action: 'fill_form',
      elements,
      submit: true,
      background: true,
    } as any);
    expect(payloadOf(sent)).toMatchObject({ success: true, filled: 2, submitted: true });
    expect(inputLog()).toEqual(['Enter']);
    expect(fill.mock.calls.map(([args]) => (args as any).keepFocus)).toEqual([false, true]);

    mocks.sendCommand.mockClear();
    fill.mockResolvedValueOnce(ok as any).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Element not found' }],
      isError: true,
    });
    const halfFilled = await computerTool.execute({
      tabId: 7,
      action: 'fill_form',
      elements,
      submit: true,
      background: true,
    } as any);
    expect(payloadOf(halfFilled)).toMatchObject({
      success: false,
      filled: 1,
      submitted: false,
      submitError: 'not submitted because some fields could not be filled',
    });
    expect(inputLog()).toEqual([]);
  });
});
