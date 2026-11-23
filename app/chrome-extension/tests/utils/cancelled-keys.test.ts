import { afterEach, expect, it, vi } from 'vitest';
import { guardNewKeyDocument, installKeyReleaseGuard, prepareNativeKeyRelease, trackChord } from '@/utils/cancelled-keys';

afterEach(() => vi.restoreAllMocks());

it.each(['original', 'adopted'])('balances a key in its original document with an %s target', placement => {
  const input = document.createElement('input');
  document.body.append(input);
  const child = document.implementation.createHTMLDocument();
  const onOriginal = vi.fn(), onChild = vi.fn();
  document.addEventListener('keyup', onOriginal);
  child.addEventListener('keyup', onChild);
  const listen = vi.spyOn(window, 'addEventListener');
  try {
    trackChord('test', ['KeyA'], null);
    const onDown = listen.mock.calls.find(([type]) => type === 'keydown')![1] as (event: unknown) => void;
    onDown({ isTrusted: true, type: 'keydown', code: 'KeyA', key: 'a', timeStamp: 40, composedPath: () => [input] });
    if (placement === 'adopted') child.body.append(input);
    trackChord('test', [], [{ code: 'KeyA', timestamp: performance.timeOrigin + 40, modifiers: 0 }]);
    expect(onOriginal).toHaveBeenCalledOnce();
    expect(onOriginal.mock.calls[0][0].target).toBe(placement === 'adopted' ? document : input);
    expect(onChild).not.toHaveBeenCalled();
  } finally {
    trackChord('test', [], []);
    input.remove();
    document.removeEventListener('keyup', onOriginal);
    child.removeEventListener('keyup', onChild);
  }
});

it('admits a matching native release only at its original target and avoids duplicate cleanup', () => {
  const input = document.createElement('input');
  const other = document.createElement('button');
  document.body.append(input, other);
  input.focus();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const listen = vi.spyOn(window, 'addEventListener');
  installKeyReleaseGuard();
  const guard = listen.mock.calls[0][1] as (event: unknown) => void;
  trackChord('test', ['KeyA'], null);
  const onDown = listen.mock.calls.find(([type]) => type === 'keydown')![1] as (event: unknown) => void;
  const origin = performance.timeOrigin;
  const key = { code: 'KeyA', timestamp: origin + 40, modifiers: 0 };
  const native = { isTrusted: true, code: 'KeyA', timeStamp: 70, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
  const duplicate = vi.fn();
  input.addEventListener('keyup', duplicate);
  try {
    onDown({ ...native, type: 'keydown', key: 'a', timeStamp: 40, composedPath: () => [input] });
    expect(prepareNativeKeyRelease('test', key, origin + 70)).toBe('focused');
    guard({ ...native, timeStamp: 20, composedPath: () => [other] });
    expect(native.stopImmediatePropagation).not.toHaveBeenCalled();
    guard({ ...native, composedPath: () => [other] });
    expect(native.stopImmediatePropagation).toHaveBeenCalledOnce();
    guard({ ...native, composedPath: () => [input] });
    expect(native.stopImmediatePropagation).toHaveBeenCalledOnce();
    trackChord('test', [], [key]);
    expect(duplicate).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keyup', guard, true);
    Reflect.deleteProperty(window, '__webpageMcpKeyReleases');
    trackChord('test', [], []);
    input.remove(); other.remove();
  }
});

it('rejects the in-flight up in a new document while allowing later input', () => {
  vi.useFakeTimers();
  const listen = vi.spyOn(window, 'addEventListener');
  try {
    guardNewKeyDocument(['KeyA'], performance.timeOrigin - 1, Date.now() + 1000);
    const guard = listen.mock.calls[0][1] as (event: unknown) => void;
    const event = { isTrusted: true, code: 'KeyA', timeStamp: 0, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    guard({ ...event, code: 'KeyB' });
    guard({ ...event, timeStamp: 0.5 });
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    guard(event);
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  } finally { vi.runAllTimers(); vi.useRealTimers(); }
});
