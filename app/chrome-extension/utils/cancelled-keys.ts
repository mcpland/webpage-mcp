export interface PendingKeyRelease {
  code: string;
  timestamp: number;
  modifiers: number;
  awaitingNativeAck?: boolean;
}

type NativeRelease = { code: string; timestamp: number; accept: (target: EventTarget) => boolean; timer: ReturnType<typeof setTimeout> };
type ChordTracker = {
  original(key: PendingKeyRelease): EventTarget | undefined;
  delivered(key: PendingKeyRelease): void;
  finish(keys: PendingKeyRelease[]): void;
};
type ChordWindow = Window & {
  __webpageMcpChords?: Map<string, ChordTracker>;
  __webpageMcpKeyReleases?: Map<string, NativeRelease>;
};

// Install at document_start so a focus change between the focus check and CDP
// delivery cannot expose a compensating keyup to an earlier page listener.
export function installKeyReleaseGuard() {
  const scope = window as ChordWindow;
  if (scope.__webpageMcpKeyReleases) return;
  const releases = scope.__webpageMcpKeyReleases = new Map<string, NativeRelease>();
  window.addEventListener('keyup', event => {
    if (!event.isTrusted || !releases.size) return;
    const timestamp = performance.timeOrigin + event.timeStamp;
    for (const release of releases.values()) {
      if (event.code !== release.code || Math.abs(timestamp - release.timestamp) >= 1) continue;
      if (!release.accept(event.composedPath()[0])) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
  }, true);
}

// Page.addScriptToEvaluateOnNewDocument installs this in new documents in the
// inspected tab before page scripts. Such a document cannot own an earlier down.
export function guardNewKeyDocument(codes: string[], timestamp: number, expires: number) {
  if (Date.now() >= expires) return;
  const expected = Math.max(0, timestamp - performance.timeOrigin);
  const block = (event: KeyboardEvent) => {
    if (Date.now() < expires && event.isTrusted && codes.includes(event.code) &&
        (expected === 0 ? event.timeStamp === 0 : Math.abs(event.timeStamp - expected) < 1)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  window.addEventListener('keyup', block, true);
  setTimeout(() => window.removeEventListener('keyup', block, true), expires - Date.now());
}

// Chrome serializes this function. Arm every frame for the same native command,
// including frames that did not receive the down (no authorized recipient).
export function prepareNativeKeyRelease(token: string, key: PendingKeyRelease, timestamp: number) {
  const scope = window as ChordWindow;
  const guard = scope.__webpageMcpKeyReleases;
  const chord = scope.__webpageMcpChords?.get(token);
  if (!guard || !chord) return 'unavailable';
  const target = chord.original(key);
  const id = token + ':' + key.code;
  const release: NativeRelease = {
    code: key.code, timestamp,
    accept: recipient => {
      const current = scope.__webpageMcpChords?.get(token);
      if (!current || current.original(key) !== recipient) return false;
      current.delivered(key);
      return true;
    },
    // A submitted command can arrive after its acknowledgement times out.
    timer: setTimeout(() => { if (guard.get(id) === release) guard.delete(id); }, 60_000),
  };
  guard.set(id, release);
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  return target && document.hasFocus() && focused === target ? 'focused' : 'guarded';
}

// Chrome serializes this function into the isolated world of each accessible frame.
export function trackChord(token: string, codes: string[], releases: PendingKeyRelease[] | null) {
  const scope = window as ChordWindow;
  if (releases !== null) {
    scope.__webpageMcpChords?.get(token)?.finish(releases);
    return;
  }
  const chords = scope.__webpageMcpChords ??= new Map<string, ChordTracker>();
  const held = new Map<string, { event: KeyboardEvent; target: EventTarget }>();
  const onKey = (event: KeyboardEvent) => {
    if (!event.isTrusted || !codes.includes(event.code)) return;
    const target = event.composedPath()[0];
    if (event.type === 'keyup') held.delete(event.code);
    else if (target) held.set(event.code, { event, target });
  };
  const original = (key: PendingKeyRelease) => {
    const press = held.get(key.code);
    return press && Math.abs(performance.timeOrigin + press.event.timeStamp - key.timestamp) < 1 ? press.target : undefined;
  };
  const finish = (keys: PendingKeyRelease[]) => {
    clearTimeout(timer);
    chords.delete(token);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    for (const { code, timestamp, modifiers, awaitingNativeAck } of keys) {
      const id = token + ':' + code;
      const guard = scope.__webpageMcpKeyReleases?.get(id);
      if (guard && !awaitingNativeAck) {
        clearTimeout(guard.timer);
        scope.__webpageMcpKeyReleases?.delete(id);
      }
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
  chords.set(token, { original, finish, delivered: key => held.delete(key.code) });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
}
