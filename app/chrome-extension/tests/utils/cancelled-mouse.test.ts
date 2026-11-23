import { describe, expect, it, vi } from 'vitest';
import { CANCEL_MOUSE_COORDINATE, observeCancelledMouseRelease } from '@/utils/cancelled-mouse';

describe('cancelled native mouse input', () => {
  it('cancels the drag at the press position without delivering a cleanup pointerup or mouseup', () => {
    const listeners = new Map<string, (event: any) => void>();
    vi.stubGlobal('window', { addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn) });
    vi.stubGlobal('PointerEvent', class { constructor(public type: string, options: object) { Object.assign(this, options); } });
    try {
      observeCancelledMouseRelease();
      const target = { dispatchEvent: vi.fn() };
      const press = { isTrusted: true, pointerType: 'mouse', pointerId: 1, isPrimary: true, clientX: 42, clientY: 18 };
      listeners.get('pointerdown')!(press);
      const release = {
        ...press, screenX: CANCEL_MOUSE_COORDINATE, screenY: CANCEL_MOUSE_COORDINATE,
        composedPath: () => [target], preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
      };
      listeners.get('pointerup')!(release);
      listeners.get('mouseup')!(release);
      expect(release.stopImmediatePropagation).toHaveBeenCalledTimes(2);
      expect(target.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'pointercancel', pointerId: 1, clientX: 42, clientY: 18,
      }));
    } finally { vi.unstubAllGlobals(); }
  });
});
