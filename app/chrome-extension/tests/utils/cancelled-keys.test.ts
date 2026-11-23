import { afterEach, expect, it, vi } from 'vitest';
import { trackChord } from '@/utils/cancelled-keys';

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
