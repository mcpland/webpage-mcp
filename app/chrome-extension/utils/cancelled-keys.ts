export interface PendingKeyRelease {
  code: string;
  timestamp: number;
  modifiers: number;
}

// Chrome serializes this function into the isolated world of each accessible frame.
export function trackChord(token: string, codes: string[], releases: PendingKeyRelease[] | null) {
  type Finish = (keys: PendingKeyRelease[]) => void;
  const scope = window as Window & { __webpageMcpChords?: Map<string, Finish> };
  if (releases !== null) {
    scope.__webpageMcpChords?.get(token)?.(releases);
    return;
  }
  const chords = scope.__webpageMcpChords ??= new Map();
  const held = new Map<string, { event: KeyboardEvent; target: EventTarget }>();
  const onKey = (event: KeyboardEvent) => {
    if (!event.isTrusted || !codes.includes(event.code)) return;
    const target = event.composedPath()[0];
    if (event.type === 'keyup') held.delete(event.code);
    else if (target) held.set(event.code, { event, target });
  };
  const finish: Finish = keys => {
    clearTimeout(timer);
    chords.delete(token);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    for (const { code, timestamp, modifiers } of keys) {
      const press = held.get(code);
      if (!press || Math.abs(performance.timeOrigin + press.event.timeStamp - timestamp) >= 1) continue;
      const { event, target } = press;
      // The page can adopt or remove the pressed node before cancellation.
      const recipient = target === window || (target instanceof Node && target.isConnected &&
        (target === document || target.ownerDocument === document)) ? target : document;
      recipient.dispatchEvent(new KeyboardEvent('keyup', {
        key: event.key, code, location: event.location, keyCode: event.keyCode, which: event.which,
        altKey: !!(modifiers & 1), ctrlKey: !!(modifiers & 2), metaKey: !!(modifiers & 4),
        shiftKey: !!(modifiers & 8), bubbles: true, composed: true, cancelable: true,
      }));
    }
    held.clear();
  };
  // A service worker can restart while a chord is in flight.
  const timer = setTimeout(() => finish([]), 60_000);
  chords.set(token, finish);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
}
