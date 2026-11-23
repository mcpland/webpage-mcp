// Keep cleanup outside page hit targets even after iframe offsets and zoom.
export const CANCEL_MOUSE_COORDINATE = -1_000_000;

type MouseDocument = Window & {
  __webpageMcpCancelMouseAt?: (timestamp: number, button: number) => void;
};

// Chrome serializes this function into each isolated frame. The press timestamp
// identifies its originating document even if a busy frame receives the call late.
export function cancelObservedMousePress(timestamp: number, button: number) {
  (window as MouseDocument).__webpageMcpCancelMouseAt?.(timestamp, button);
}

export function observeCancelledMouseRelease() {
  const scope = window as MouseDocument;
  if (scope.__webpageMcpCancelMouseAt) return;

  let pointerId: number | undefined;
  let press: { event: MouseEvent; target: EventTarget; capture?: Element; pointerId?: number; timestamp: number } | undefined;
  const rememberPointer = (event: PointerEvent) => {
    if (event.isTrusted && event.pointerType === 'mouse') pointerId = event.pointerId;
  };
  window.addEventListener('pointerover', rememberPointer, true);
  // An existing tab may already have the mouse over the target when the extension reloads.
  window.addEventListener('pointermove', rememberPointer, true);
  const rememberPress = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if ('pointerType' in event) {
      const pointer = event as PointerEvent;
      if (pointer.pointerType !== 'mouse') return;
      rememberPointer(pointer);
    }
    const timestamp = performance.timeOrigin + event.timeStamp;
    const target = event.composedPath()[0];
    if (!target) return;
    if (event.type !== 'mousedown' || press?.timestamp !== timestamp) {
      press = { event, target, pointerId, timestamp };
    }
  };
  // Either event may have been consumed by a listener registered before an upgrade.
  window.addEventListener('pointerdown', rememberPress, true);
  window.addEventListener('mousedown', rememberPress, true);

  window.addEventListener('gotpointercapture', event => {
    const target = event.composedPath()[0];
    if (event.isTrusted && press && press.pointerId === event.pointerId && target instanceof Element) {
      press.capture = target;
    }
  }, true);

  const finish = () => {
    if (!press) return;
    const { event, pointerId: id } = press;
    let target = press.target;
    if (id !== undefined && target instanceof Element) {
      // setPointerCapture takes effect before Chrome delivers gotpointercapture.
      // The pending owner can be a sibling, including inside a shadow tree.
      let owner = press.capture?.hasPointerCapture(id) ? press.capture : undefined;
      if (!owner && target.hasPointerCapture?.(id)) owner = target;
      if (!owner) {
        const roots: ParentNode[] = [target.getRootNode() as Document | ShadowRoot];
        if (roots[0] !== document) roots.push(document);
        const seen = new Set<ParentNode>();
        while (roots.length && !owner) {
          const root = roots.pop()!;
          if (seen.has(root)) continue;
          seen.add(root);
          const nodes = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
          for (let node = nodes.nextNode() as Element | null; node; node = nodes.nextNode() as Element | null) {
            if (node.hasPointerCapture(id)) { owner = node; break; }
            const shadow = node.shadowRoot || (node instanceof HTMLElement && chrome.dom?.openOrClosedShadowRoot?.(node));
            if (shadow) roots.push(shadow);
          }
        }
      }
      if (owner) { owner.releasePointerCapture(id); target = owner; }
    }
    press = undefined;
    const position = { clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY };
    target.dispatchEvent(new PointerEvent('pointercancel', {
      ...position, pointerId: id, pointerType: 'mouse', isPrimary: true, bubbles: true, composed: true,
    }));
  };
  scope.__webpageMcpCancelMouseAt = (timestamp, button) => {
    // DOMHighResTimeStamp has reduced precision relative to the supplied CDP timestamp.
    if (press && press.event.button === button && Math.abs(press.timestamp - timestamp) < 1) finish();
  };

  const isCleanup = (event: MouseEvent) => event.isTrusted &&
    event.screenX < CANCEL_MOUSE_COORDINATE / 2 && event.screenY < CANCEL_MOUSE_COORDINATE / 2;
  const suppress = (event: MouseEvent) => {
    if (isCleanup(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  window.addEventListener('pointerup', event => {
    if (!event.isTrusted || event.pointerType !== 'mouse') return;
    if (isCleanup(event)) { suppress(event); finish(); } else press = undefined;
  }, true);
  window.addEventListener('mouseup', event => {
    if (!event.isTrusted) return;
    if (isCleanup(event)) suppress(event);
    else press = undefined;
  }, true);
  window.addEventListener('pointercancel', event => {
    if (event.isTrusted && event.pointerType === 'mouse') press = undefined;
  }, true);
  for (const type of ['click', 'dblclick', 'auxclick', 'contextmenu'] as const) {
    window.addEventListener(type, suppress, true);
  }
}
