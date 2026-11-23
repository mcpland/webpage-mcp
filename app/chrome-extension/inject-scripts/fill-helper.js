// fill-helper.js
// This script is injected into the page to handle form filling operations

if (window.__FILL_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__FILL_HELPER_INITIALIZED__ = true;

  let pendingSubmit;
  // Shared only with the keyboard helper in this frame's isolated world.
  window.__webpageFocusFilledTarget = (token) => {
    if (!token || pendingSubmit?.token !== token) return false;
    const element = pendingSubmit.element.deref();
    if (!element?.isConnected) return false;
    element.focus({ preventScroll: true });
    // An inactive tab can receive tab-targeted CDP input. Verify DOM focus through
    // each shadow host, independently of whether the browser window has OS focus.
    let current = element;
    while (current) {
      const root = current.getRootNode();
      if (root.activeElement !== current) return false;
      if (root === document) return true;
      current = root.host;
    }
    return false;
  };

  const MAX_SHADOW_SEARCH_NODES = 2000;
  const MAX_SHADOW_SEARCH_DEPTH = 32;
  const MAX_SHADOW_SEARCH_MS = 100;
  const MAX_SHADOW_SEARCH_FRONTIER = 512;
  const MAX_SHADOW_SEARCH_ROOTS = 64;
  const FILL_READY_TIMEOUT_MS = 100;
  const FILL_READY_POLL_MS = 16;

  function findFillableInShadowRoot(root) {
    if (!(root instanceof ShadowRoot)) return null;
    const deadline = Date.now() + MAX_SHADOW_SEARCH_MS;
    const queue = [];
    let head = 0;
    let queued = 0;
    let visited = 0;
    let shadowRoots = 1;

    const enqueueChildren = (container, depth) => {
      let child = container.firstElementChild;
      while (child) {
        if (
          Date.now() > deadline ||
          queued >= MAX_SHADOW_SEARCH_NODES ||
          queue.length - head >= MAX_SHADOW_SEARCH_FRONTIER
        ) {
          return false;
        }
        queue.push({ element: child, depth });
        queued += 1;
        child = child.nextElementSibling;
      }
      return true;
    };

    enqueueChildren(root, 0);
    while (
      head < queue.length &&
      visited < MAX_SHADOW_SEARCH_NODES &&
      Date.now() <= deadline
    ) {
      const entry = queue[head];
      head += 1;
      visited += 1;
      const current = entry.element;
      if (
        current.tagName === 'INPUT' ||
        current.tagName === 'TEXTAREA' ||
        current.tagName === 'SELECT'
      ) {
        // The search returns at most one result.
        return current;
      }

      if (entry.depth >= MAX_SHADOW_SEARCH_DEPTH) continue;
      enqueueChildren(current, entry.depth + 1);

      const innerRoot = current.shadowRoot;
      if (innerRoot) {
        if (shadowRoots >= MAX_SHADOW_SEARCH_ROOTS) continue;
        shadowRoots += 1;
        enqueueChildren(innerRoot, entry.depth + 1);
      }
    }
    return null;
  }

  /**
   * Fill an input element with the specified value
   * @param {string} selector - CSS selector for the element to fill
   * @param {string} value - Value to fill into the element
   * @returns {Promise<Object>} - Result of the fill operation
   */
  /**
   * @param {boolean} [keepFocus] leave the field focused (no blur) so a
   *   following Enter key press lands in it, as when a user types and submits.
   */
  async function fillElement(selector, value, ref = null, keepFocus = false, submitToken, deadlineAt, permit) {
    try {
      const checkInput = async () => {
        if (permit && await chrome.runtime.sendMessage({ action: 'checkBrowserInput', permit }) !== true)
          throw new Error('Fill operation cancelled');
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new Error('Fill operation timed out');
      };
      await checkInput();
      // Find the element
      let element = null;
      if (ref && typeof ref === 'string') {
        try {
          const map = window.__claudeElementMap;
          const weak = map && map[ref];
          element = weak && typeof weak.deref === 'function' ? weak.deref() : null;
        } catch (e) {
          // ignore
        }
        if (!element || !(element instanceof Element)) {
          return {
            error: `Element ref "${ref}" not found. Please call chrome_read_page first and ensure the ref is still valid.`,
          };
        }
      } else {
        element = document.querySelector(selector);
      }
      if (!element) {
        return {
          error: selector
            ? `Element with selector "${selector}" not found`
            : `Element for ref not found`,
        };
      }

      // Get element information
      const targetLabel = selector || ref || 'unknown';
      const initialRect = element.getBoundingClientRect();
      // Check layout visibility (display/visibility/opacity/non-zero box) first,
      // then scroll offscreen elements into view before checking viewport hit-testing.
      const initiallyRendered = isElementRendered(element);
      const elementInfo = {
        tagName: element.tagName,
        id: element.id,
        className: element.className,
        type: element.type || null,
        isVisible: initiallyRendered,
        rect: {
          x: initialRect.x,
          y: initialRect.y,
          width: initialRect.width,
          height: initialRect.height,
          top: initialRect.top,
          right: initialRect.right,
          bottom: initialRect.bottom,
          left: initialRect.left,
        },
      };

      if (!initiallyRendered) {
        return {
          error: `Element "${targetLabel}" is not visible`,
          elementInfo,
        };
      }

      // Check if element is an input, textarea, or select
      const validTags = ['INPUT', 'TEXTAREA', 'SELECT'];
      // Keep a permissive list to allow type-specific branches below to handle behavior
      const validInputTypes = [
        'text',
        'email',
        'password',
        'number',
        'search',
        'tel',
        'url',
        'date',
        'datetime-local',
        'month',
        'time',
        'week',
        'color',
        'checkbox',
        'radio',
        'range',
      ];

      if (!validTags.includes(element.tagName)) {
        // If the element is a custom element with open shadow root, try to find a fillable inner control
        try {
          const anyEl = /** @type {any} */ (element);
          const sr = anyEl && anyEl.shadowRoot ? anyEl.shadowRoot : null;
          if (sr) {
            // Search common fillable targets inside shadow roots with strict BFS budgets.
            element = findFillableInShadowRoot(sr) || element;
            if (!validTags.includes(element.tagName)) {
              return {
                error: `Element "${targetLabel}" is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
                elementInfo,
              };
            }
          } else {
            return {
              error: `Element "${targetLabel}" is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
              elementInfo,
            };
          }
        } catch (_) {
          return {
            error: `Element "${targetLabel}" is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
            elementInfo,
          };
        }
      }

      // For input elements, check if the type is valid (allow type-specific branches below)
      if (
        element.tagName === 'INPUT' &&
        !validInputTypes.includes(element.type) &&
        element.type !== null
      ) {
        return {
          error: `Input element "${targetLabel}" has type "${element.type}" which is not fillable`,
          elementInfo,
        };
      }

      await checkInput();
      let blocker = getFillBlocker(element);
      if (blocker && element.isConnected) {
        if (blocker === 'not visible') {
          element.scrollIntoView?.({ behavior: 'instant', block: 'center', inline: 'center' });
        }
        const stopAt = performance.now() + FILL_READY_TIMEOUT_MS;
        // Recheck immediately after scrolling. Only poll while the field is blocked.
        for (;;) {
          await checkInput();
          blocker = getFillBlocker(element);
          const remaining = Math.min(stopAt - performance.now(), (deadlineAt ?? Infinity) - Date.now());
          if (!blocker || !element.isConnected || remaining <= 0) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(FILL_READY_POLL_MS, remaining)));
        }
      }

      if (!blocker) {
        element.focus();
        await checkInput();
        // Page focus handlers can replace, disable or cover the control.
        blocker = getFillBlocker(element);
      }
      const rect = element.getBoundingClientRect();
      elementInfo.rect = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      };
      elementInfo.isVisible = blocker !== 'not visible';
      if (blocker) {
        return { error: `Element "${targetLabel}" is ${blocker}`, elementInfo };
      }

      pendingSubmit = submitToken ? { token: submitToken, element: new WeakRef(element) } : undefined;

      const emit = async (type) => {
        await checkInput();
        element.dispatchEvent(new Event(type, { bubbles: true }));
      };
      // Type-specific handling for tricky inputs first
      if (element.tagName === 'INPUT' && element.type === 'checkbox') {
        // Accept boolean or string-like boolean
        let checkedVal;
        if (typeof value === 'boolean') {
          checkedVal = value;
        } else if (typeof value === 'string') {
          const v = value.trim().toLowerCase();
          if (['true', '1', 'yes', 'on'].includes(v)) checkedVal = true;
          else if (['false', '0', 'no', 'off'].includes(v)) checkedVal = false;
        }
        if (typeof checkedVal !== 'boolean') {
          return {
            error:
              'Checkbox requires a boolean (true/false) or a boolean-like string ("true"/"false"/"on"/"off").',
            elementInfo,
          };
        }
        const previous = element.checked;
        element.checked = checkedVal;
        element.focus();
        await emit('input');
        await emit('change');
        if (!keepFocus) { await checkInput(); element.blur(); }
        return {
          success: true,
          message: `Checkbox set to ${element.checked}`,
          elementInfo: { ...elementInfo, checked: element.checked, previousChecked: previous },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'radio') {
        // For radios, the selector/ref should target the specific input to select
        const previous = element.checked;
        element.checked = true;
        element.focus();
        await emit('input');
        await emit('change');
        if (!keepFocus) { await checkInput(); element.blur(); }
        return {
          success: true,
          message: 'Radio selected',
          elementInfo: {
            ...elementInfo,
            checked: element.checked,
            previousChecked: previous,
            name: element.name || null,
          },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'range') {
        const numericValue = typeof value === 'number' ? value : Number(value);
        if (Number.isNaN(numericValue)) {
          return { error: 'Range input requires a numeric value', elementInfo };
        }
        const previous = element.value;
        element.value = String(numericValue);
        element.focus();
        await emit('input');
        await emit('change');
        if (!keepFocus) { await checkInput(); element.blur(); }
        return {
          success: true,
          message: `Set range to ${element.value} (min: ${element.min}, max: ${element.max})`,
          elementInfo: { ...elementInfo, value: element.value },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'number') {
        if (value !== '' && value !== null && value !== undefined && Number.isNaN(Number(value))) {
          return { error: 'Number input requires a numeric value', elementInfo };
        }
        const previous = element.value;
        element.value = String(value ?? '');
        element.focus();
        await emit('input');
        await emit('change');
        if (!keepFocus) { await checkInput(); element.blur(); }
        return {
          success: true,
          message: `Set number input to ${element.value} (previous: ${previous})`,
          elementInfo: { ...elementInfo, value: element.value },
        };
      }

      // Fill the element based on its type
      if (element.tagName === 'SELECT') {
        // For select elements, find the option with matching value or text
        let optionFound = false;
        for (const option of element.options) {
          if (option.value === value || option.text === value) {
            element.value = option.value;
            optionFound = true;
            break;
          }
        }

        if (!optionFound) {
          return {
            error: `No option with value or text "${value}" found in select element`,
            elementInfo,
          };
        }

        // Trigger change event
        await emit('change');
      } else {
        // For input and textarea elements
        // Clear the current value then set new value
        element.value = '';
        await emit('input');

        await checkInput();
        element.value = String(value);

        await emit('input');
        await emit('change');
      }

      // Blur the element (like a user leaving the field) unless a submit follows
      if (!keepFocus) { await checkInput(); element.blur(); }

      return {
        success: true,
        message: 'Element filled successfully',
        elementInfo: {
          ...elementInfo,
          value: element.value, // Include the final value in the response
        },
      };
    } catch (error) {
      return {
        error: `Error filling element: ${error.message}`,
      };
    }
  }

  function getFillBlocker(element) {
    if (!isElementVisible(element)) return 'not visible';
    if (element.matches(':disabled')) return 'disabled';
    // For supported input types, readonly applies only to text-like controls.
    if (element.readOnly && !['checkbox', 'radio', 'range', 'color'].includes(element.type)) {
      return 'read-only';
    }
    return null;
  }

  /**
   * Check whether an element has rendered box geometry (may still be offscreen).
   * @param {Element} element
   * @returns {boolean}
   */
  function isElementRendered(element) {
    if (!element?.isConnected) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Check if an element is visible
   * @param {Element} element - The element to check
   * @returns {boolean} - Whether the element is visible
   */
  function isElementVisible(element) {
    if (!isElementRendered(element)) return false;

    const rect = element.getBoundingClientRect();

    // Check if element is within viewport
    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      return false;
    }

    // Check if element is actually visible at its center point
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const elementAtPoint = document.elementFromPoint(centerX, centerY);
    if (!elementAtPoint) return false;

    let current = element;
    while (current) {
      if (current === elementAtPoint || current.contains(elementAtPoint)) {
        return true;
      }
      const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
      if (root && root !== document && root.host) {
        if (typeof root.elementFromPoint === 'function') {
          const shadowHit = root.elementFromPoint(centerX, centerY);
          if (shadowHit && shadowHit !== current && !current.contains(shadowHit)) {
            return false;
          }
        }
        current = root.host;
      } else {
        break;
      }
    }
    return false;
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'fillElement') {
      fillElement(request.selector, request.value, request.ref, request.keepFocus === true, request.submitToken, request.deadlineAt, request.permit)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    } else if (request.action === 'focusFilledTarget') {
      sendResponse({ success: window.__webpageFocusFilledTarget(request.submitToken) });
      return false;
    } else if (request.action === 'chrome_fill_or_select_ping') {
      sendResponse({ status: 'pong' });
      return false;
    }
  });
}
