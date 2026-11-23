// click-helper.js
// This script is injected into the page to handle click operations

if (window.__CLICK_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__CLICK_HELPER_INITIALIZED__ = true;

  const MAX_TEXT_SCAN_NODES = 512;
  const MAX_TEXT_SCAN_MS = 25;
  const MAX_TEXT_BYTES = 512;
  const MAX_TEXT_LENGTH = 100;

  function utf8BytesForCodePoint(codePoint) {
    if (codePoint <= 0x7f) return 1;
    if (codePoint <= 0x7ff) return 2;
    if (codePoint <= 0xffff) return 3;
    return 4;
  }

  function truncateUtf8(value, maximumBytes) {
    if (typeof value !== 'string') return '';
    let bytes = 0;
    let end = 0;
    for (const character of value) {
      const nextBytes = utf8BytesForCodePoint(character.codePointAt(0) || 0);
      if (bytes + nextBytes > maximumBytes) break;
      bytes += nextBytes;
      end += character.length;
    }
    return value.slice(0, end);
  }

  function utf8ByteLength(value) {
    let bytes = 0;
    for (const character of typeof value === 'string' ? value : '') {
      bytes += utf8BytesForCodePoint(character.codePointAt(0) || 0);
    }
    return bytes;
  }

  function collectBoundedText(element) {
    if (!(element instanceof Element)) return '';
    try {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL);
      const deadline = Date.now() + MAX_TEXT_SCAN_MS;
      let visited = 0;
      let output = '';
      let outputBytes = 0;

      while (visited < MAX_TEXT_SCAN_NODES && Date.now() <= deadline) {
        const node = walker.nextNode();
        if (!node) break;
        visited += 1;
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const parentTag = node.parentElement?.tagName?.toLowerCase() || '';
        if (parentTag === 'script' || parentTag === 'style' || parentTag === 'noscript') continue;

        const separator = output ? ' ' : '';
        const remaining = MAX_TEXT_BYTES - outputBytes - separator.length;
        if (remaining <= 0) break;
        const part = truncateUtf8(
          typeof node.nodeValue === 'string' ? node.nodeValue : '',
          remaining,
        );
        if (!part) continue;
        output += separator + part;
        outputBytes += separator.length + utf8ByteLength(part);
      }

      return truncateUtf8(output, MAX_TEXT_BYTES)
        .trim()
        .replace(/\s+/g, ' ')
        .substring(0, MAX_TEXT_LENGTH);
    } catch {
      return '';
    }
  }

  /**
   * Click on an element matching the selector or at specific coordinates
   * @param {string} selector - CSS selector for the element to click
   * @param {boolean} waitForNavigation - Whether to wait for navigation to complete after click
   * @param {number} timeout - Timeout in milliseconds for waiting for the element or navigation
   * @param {Object} coordinates - Optional coordinates for clicking at a specific position
   * @param {number} coordinates.x - X coordinate relative to the viewport
   * @param {number} coordinates.y - Y coordinate relative to the viewport
   * @returns {Promise<Object>} - Result of the click operation
   */
  async function clickElement(
    selector,
    waitForNavigation = false,
    timeout = 5000,
    coordinates = null,
    ref = null,
    double = false,
    options = {},
  ) {
    try {
      let element = null;
      let elementInfo = null;
      let clickX, clickY;

      if (ref && typeof ref === 'string') {
        // Resolve element from weak map
        let target = null;
        try {
          const map = window.__claudeElementMap;
          const weak = map && map[ref];
          target = weak && typeof weak.deref === 'function' ? weak.deref() : null;
        } catch (e) {
          // ignore
        }

        if (!target || !(target instanceof Element)) {
          return {
            error: `Element ref "${ref}" not found. Please call chrome_read_page first and ensure the ref is still valid.`,
          };
        }

        element = target;
        element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
        await new Promise((resolve) => setTimeout(resolve, 80));

        const rect = element.getBoundingClientRect();
        clickX = rect.left + rect.width / 2;
        clickY = rect.top + rect.height / 2;
        elementInfo = {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          text: collectBoundedText(element),
          href: element.href || null,
          type: element.type || null,
          isVisible: true,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          },
          clickMethod: 'ref',
          ref,
        };
      } else if (
        coordinates &&
        typeof coordinates.x === 'number' &&
        typeof coordinates.y === 'number'
      ) {
        clickX = coordinates.x;
        clickY = coordinates.y;

        element = document.elementFromPoint(clickX, clickY);

        if (element) {
          const rect = element.getBoundingClientRect();
          elementInfo = {
            tagName: element.tagName,
            id: element.id,
            className: element.className,
            text: collectBoundedText(element),
            href: element.href || null,
            type: element.type || null,
            isVisible: true,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
            },
            clickMethod: 'coordinates',
            clickPosition: { x: clickX, y: clickY },
          };
        } else {
          elementInfo = {
            clickMethod: 'coordinates',
            clickPosition: { x: clickX, y: clickY },
            warning: 'No element found at the specified coordinates',
          };
        }
      } else {
        element = document.querySelector(selector);
        if (!element) {
          return {
            error: `Element with selector "${selector}" not found`,
          };
        }

        const rect = element.getBoundingClientRect();
        elementInfo = {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          text: collectBoundedText(element),
          href: element.href || null,
          type: element.type || null,
          isVisible: true,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          },
          clickMethod: 'selector',
        };

        // First sroll so that the element is in view, then check visibility.
        element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        elementInfo.isVisible = isElementVisible(element);
        if (!elementInfo.isVisible) {
          return {
            error: `Element with selector "${selector}" is not visible`,
            elementInfo,
          };
        }

        const updatedRect = element.getBoundingClientRect();
        clickX = updatedRect.left + updatedRect.width / 2;
        clickY = updatedRect.top + updatedRect.height / 2;
      }

      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
        return { error: 'Workflow click timed out' };
      }
      let navigationPromise;
      if (waitForNavigation) {
        navigationPromise = new Promise((resolve) => {
          const beforeUnloadListener = () => {
            window.removeEventListener('beforeunload', beforeUnloadListener);
            resolve(true);
          };
          window.addEventListener('beforeunload', beforeUnloadListener);

          setTimeout(() => {
            window.removeEventListener('beforeunload', beforeUnloadListener);
            resolve(false);
          }, timeout);
        });
      }

      if (element) await dispatchClickSequence(element, clickX, clickY, options, double);

      // Wait for navigation if needed
      let navigationOccurred = false;
      if (waitForNavigation) {
        navigationOccurred = await navigationPromise;
      }

      return {
        success: true,
        message: 'Element clicked successfully',
        elementInfo,
        navigationOccurred,
      };
    } catch (error) {
      return {
        error: `Error clicking element: ${error.message}`,
      };
    }
  }

  function normalizeMouseOpts(x, y, options = {}) {
    const bubbles = options.bubbles !== false; // default true
    const cancelable = options.cancelable !== false; // default true
    const altKey = !!(options.modifiers && options.modifiers.altKey);
    const ctrlKey = !!(options.modifiers && options.modifiers.ctrlKey);
    const metaKey = !!(options.modifiers && options.modifiers.metaKey);
    const shiftKey = !!(options.modifiers && options.modifiers.shiftKey);
    const btn = String(options.button || 'left');
    const button = btn === 'right' ? 2 : btn === 'middle' ? 1 : 0;
    const buttons = btn === 'right' ? 2 : btn === 'middle' ? 4 : 1;
    return {
      bubbles,
      cancelable,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      button,
      buttons,
      clientX: x,
      clientY: y,
      view: window,
    };
  }

  async function dispatchClickSequence(element, x, y, options, isDouble) {
    const base = normalizeMouseOpts(x, y, options);
    const checkInput = async () => {
      if (options.permit && await chrome.runtime.sendMessage({
        action: 'checkBrowserInput', permit: options.permit,
      }) !== true) throw new Error('Click cancelled');
      if (Date.now() >= options.deadlineAt) throw new Error('Workflow click timed out');
    };
    const dispatch = (type) => element.dispatchEvent(new MouseEvent(type, {
      ...base, buttons: type === 'mousedown' ? base.buttons : 0,
    }));
    const click = async () => {
      await checkInput();
      dispatch('mousedown');
      try {
        await checkInput();
      } catch (error) {
        // Balance only the press already delivered to this element. A synthetic
        // mouseup does not synthesize a click. Suppress its default action as well.
        const release = new MouseEvent('mouseup', { ...base, buttons: 0, cancelable: true });
        release.preventDefault();
        element.dispatchEvent(release);
        throw error;
      }
      dispatch('mouseup');
      await checkInput();
      dispatch('click');
    };
    await click();
    if (base.button === 2) {
      await checkInput();
      dispatch('contextmenu');
    }
    if (isDouble) {
      await new Promise(resolve => setTimeout(resolve, 30));
      await click();
      await checkInput();
      dispatch('dblclick');
    }
  }

  /**
   * Check if an element is visible
   * @param {Element} element - The element to check
   * @returns {boolean} - Whether the element is visible
   */
  function isElementVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      return false;
    }

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const elementAtPoint = document.elementFromPoint(centerX, centerY);
    if (!elementAtPoint) return false;

    return element === elementAtPoint || element.contains(elementAtPoint);
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'clickElement') {
      clickElement(
        request.selector,
        request.waitForNavigation,
        request.timeout,
        request.coordinates,
        request.ref,
        !!request.double,
        {
          deadlineAt: request.deadlineAt,
          permit: request.permit,
          button: request.button,
          bubbles: request.bubbles,
          cancelable: request.cancelable,
          modifiers: request.modifiers,
        },
      )
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    } else if (request.action === 'chrome_click_element_ping') {
      sendResponse({ status: 'pong' });
      return false;
    }
  });
}
