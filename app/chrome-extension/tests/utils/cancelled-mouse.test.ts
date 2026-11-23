import { describe, expect, it, vi } from 'vitest';
import { CANCEL_MOUSE_COORDINATE, cancelObservedMousePress, observeCancelledMouseRelease } from '@/utils/cancelled-mouse';

describe('cancelled native mouse input', () => {
  it('recovers the pointer ID when an upgraded tab consumes pointerdown under a stationary mouse', () => {
    const listeners = new Map<string, (event: any) => void>();
    vi.stubGlobal('window', { addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn) });
    vi.stubGlobal('PointerEvent', class { constructor(public type: string, options: object) { Object.assign(this, options); } });
    try {
      observeCancelledMouseRelease();
      const target = { dispatchEvent: vi.fn() };
      listeners.get('pointermove')!({ isTrusted: true, pointerType: 'mouse', pointerId: 7 });
      listeners.get('mousedown')!({ type: 'mousedown', isTrusted: true, timeStamp: 50, button: 0, composedPath: () => [target] });
      cancelObservedMousePress(performance.timeOrigin + 50, 0);
      expect(target.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'pointercancel', pointerId: 7 }));
    } finally { vi.unstubAllGlobals(); }
  });

  it('cancels the drag at the press position without delivering a cleanup pointerup or mouseup', () => {
    const listeners = new Map<string, (event: any) => void>();
    vi.stubGlobal('window', { addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn) });
    vi.stubGlobal('PointerEvent', class { constructor(public type: string, options: object) { Object.assign(this, options); } });
    try {
      observeCancelledMouseRelease();
      const target = { dispatchEvent: vi.fn() };
      const press = { isTrusted: true, pointerType: 'mouse', pointerId: 1, target, isPrimary: true, clientX: 42, clientY: 18 };
      const down = { ...press, timeStamp: 50, button: 0, composedPath: () => [target] };
      listeners.get('pointerdown')!(down);
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
      listeners.get('mousedown')!({ ...down, type: 'mousedown', timeStamp: 60 });
      cancelObservedMousePress(performance.timeOrigin + 50, 0);
      expect(target.dispatchEvent).toHaveBeenCalledTimes(1);
      cancelObservedMousePress(performance.timeOrigin + 60, 0);
      expect(target.dispatchEvent).toHaveBeenCalledTimes(2);
      expect(target.dispatchEvent).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'pointercancel', clientX: 42, clientY: 18,
      }));
    } finally { vi.unstubAllGlobals(); }
  });
});
