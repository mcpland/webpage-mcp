// Keep a cancellation release outside the page even after iframe offsets and zoom.
// Chrome can still target a captured pointer and synthesize a click at that location.
export const CANCEL_MOUSE_COORDINATE = -1_000_000;

export function observeCancelledMouseRelease() {
  const documentWindow = window as Window & { __webpageMcpCancelMouseObserved?: boolean };
  if (documentWindow.__webpageMcpCancelMouseObserved) return;
  documentWindow.__webpageMcpCancelMouseObserved = true;
  const suppressActivation = (event: MouseEvent) => {
    if (event.isTrusted && event.screenX < CANCEL_MOUSE_COORDINATE / 2 &&
        event.screenY < CANCEL_MOUSE_COORDINATE / 2) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  for (const type of ['click', 'dblclick', 'auxclick', 'contextmenu'] as const) {
    window.addEventListener(type, suppressActivation, true);
  }
}
