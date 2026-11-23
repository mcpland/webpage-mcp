// Keep a cancellation release outside the page even after iframe offsets and zoom.
// Chrome can still target a captured pointer and synthesize a click at that location.
export const CANCEL_MOUSE_COORDINATE = -1_000_000;

export function observeCancelledMouseRelease() {
  const documentWindow = window as Window & { __webpageMcpCancelMouseObserved?: boolean };
  if (documentWindow.__webpageMcpCancelMouseObserved) return;
  documentWindow.__webpageMcpCancelMouseObserved = true;
  let press: PointerEvent | undefined;
  window.addEventListener('pointerdown', event => {
    if (event.isTrusted && event.pointerType === 'mouse') press = event;
  }, true);

  const isCleanup = (event: MouseEvent) => event.isTrusted &&
    event.screenX < CANCEL_MOUSE_COORDINATE / 2 && event.screenY < CANCEL_MOUSE_COORDINATE / 2;
  const suppress = (event: MouseEvent) => {
    if (!isCleanup(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener('pointerup', event => {
    if (!event.isTrusted || event.pointerType !== 'mouse') return;
    const down = press;
    press = undefined;
    if (!isCleanup(event)) return;
    suppress(event);
    // A captured control must abandon its drag, not commit the cleanup coordinates.
    const target = event.composedPath()[0];
    target?.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: event.pointerId, pointerType: 'mouse', isPrimary: event.isPrimary,
      clientX: down?.clientX, clientY: down?.clientY, screenX: down?.screenX, screenY: down?.screenY,
      bubbles: true, composed: true,
    }));
  }, true);
  window.addEventListener('pointercancel', event => {
    if (event.isTrusted && event.pointerType === 'mouse') press = undefined;
  }, true);
  for (const type of ['mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'] as const) {
    window.addEventListener(type, suppress, true);
  }
}
