import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Element Marker injected UI security', () => {
  afterEach(() => {
    document.querySelector('#__element_marker_overlay')?.remove();
    document.querySelector('#__element_marker_highlight')?.remove();
    document.querySelector('#__element_marker_rects')?.remove();
    document.querySelector('#marker-security-target')?.remove();
    delete (window as any).__ELEMENT_MARKER_INSTALLED__;
    vi.unstubAllGlobals();
  });

  it('does not execute an action for a synthetic host-page click', async () => {
    let messageListener: ((request: any, sender: any, respond: (value: any) => void) => any) | undefined;
    const sendMessage = vi.fn().mockResolvedValue({ tool: { ok: true } });
    const chromeMock = {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: vi.fn((listener) => {
            messageListener = listener;
          }),
        },
      },
    };
    vi.stubGlobal('chrome', chromeMock);
    Object.defineProperty(window, 'chrome', { configurable: true, value: chromeMock });

    const source = readFileSync(
      join(process.cwd(), 'inject-scripts/element-marker.js'),
      'utf8',
    );
    window.eval(source);
    expect(messageListener).toBeTypeOf('function');

    const respond = vi.fn();
    messageListener!(
      { action: 'element_marker_start', markerSessionId: 'marker-session' },
      {},
      respond,
    );
    expect(respond).toHaveBeenCalledWith({ ok: true });

    const target = document.createElement('button');
    target.id = 'marker-security-target';
    document.body.appendChild(target);

    const host = document.querySelector('#__element_marker_overlay') as HTMLElement | null;
    const shadow = host?.shadowRoot;
    expect(shadow).not.toBeNull();
    const selector = shadow?.querySelector('#__em_selector');
    expect(selector).not.toBeNull();
    if (selector) selector.textContent = '#marker-security-target';

    const execute = shadow?.querySelector('#__em_execute') as HTMLButtonElement | null;
    expect(execute).not.toBeNull();
    execute?.click();
    await Promise.resolve();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(shadow?.textContent).toContain('Execute requires a trusted user gesture');

    (shadow?.querySelector('#__em_close') as HTMLButtonElement | null)?.click();
  });
});
