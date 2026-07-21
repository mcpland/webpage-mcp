import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WEB_EDITOR_COLORS,
  WEB_EDITOR_HOST_ID,
  WEB_EDITOR_OVERLAY_ID,
  WEB_EDITOR_UI_ID,
  WEB_EDITOR_Z_INDEX,
} from '@/entrypoints/web-editor/constants';
import { mountShadowHost } from '@/entrypoints/web-editor/ui/shadow-host';

afterEach(() => {
  document.getElementById(WEB_EDITOR_HOST_ID)?.remove();
});

describe('Web Editor shadow host', () => {
  it('mounts a closed, styled root and releases every exposed element', () => {
    const manager = mountShadowHost();
    const elements = manager.getElements();

    expect(elements).not.toBeNull();
    expect(elements?.host.isConnected).toBe(true);
    expect(elements?.host.shadowRoot).toBeNull();
    expect(elements?.overlayRoot.id).toBe(WEB_EDITOR_OVERLAY_ID);
    expect(elements?.uiRoot.id).toBe(WEB_EDITOR_UI_ID);
    expect(elements?.host.style.getPropertyValue('z-index')).toBe(String(WEB_EDITOR_Z_INDEX));
    expect(elements?.host.style.getPropertyPriority('z-index')).toBe('important');

    const styles = elements?.shadowRoot.querySelector('style')?.textContent ?? '';
    expect(styles).toContain(`#${WEB_EDITOR_OVERLAY_ID}`);
    expect(styles).toContain(`#${WEB_EDITOR_UI_ID}`);
    expect(styles).toContain(WEB_EDITOR_COLORS.selectionBorder);

    manager.dispose();

    expect(manager.getElements()).toBeNull();
    expect(elements?.host.isConnected).toBe(false);
  });

  it('replaces stale hosts and prevents editor events from reaching the page', () => {
    const staleHost = document.createElement('div');
    staleHost.id = WEB_EDITOR_HOST_ID;
    document.documentElement.append(staleHost);
    const pageClick = vi.fn();
    document.addEventListener('click', pageClick);

    const manager = mountShadowHost();
    const elements = manager.getElements();
    const control = document.createElement('button');
    elements?.uiRoot.append(control);
    control.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(staleHost.isConnected).toBe(false);
    expect(pageClick).not.toHaveBeenCalled();
    expect(manager.isOverlayElement(control)).toBe(true);
    expect(manager.isOverlayElement(document.body)).toBe(false);

    document.removeEventListener('click', pageClick);
    manager.dispose();
  });
});
