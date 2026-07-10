/**
 * Screenshot helper content script
 * Handles page preparation, scrolling, element positioning, etc.
 */

if (window.__SCREENSHOT_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__SCREENSHOT_HELPER_INITIALIZED__ = true;

  const MAX_DOM_SCAN_ELEMENTS = 12000;
  const MAX_DOM_SCAN_DEPTH = 128;
  const MAX_DOM_SCAN_MS = 250;
  const MAX_HIDDEN_FIXED_ELEMENTS = 512;
  const MAX_PAGE_PREPARATION_MS = 2 * 60 * 1000;

  // Save original styles
  let originalOverflowStyle = null;
  let hiddenFixedElements = [];
  let cleanupTimer = null;

  /**
   * Get fixed/sticky positioned elements
   * @returns {{items: Array, visited: number, truncated: boolean}}
   */
  function getFixedElements() {
    const fixed = [];
    const root = document.documentElement;
    if (!root) return { items: fixed, visited: 0, truncated: false };

    const stack = [{ element: root, depth: 0 }];
    const deadline = Date.now() + MAX_DOM_SCAN_MS;
    let visited = 0;
    let truncated = false;

    while (stack.length > 0) {
      if (visited >= MAX_DOM_SCAN_ELEMENTS || Date.now() > deadline) {
        truncated = true;
        break;
      }

      const frame = stack.pop();
      if (!frame) break;
      const htmlEl = frame.element;
      visited += 1;

      const sibling = htmlEl.nextElementSibling;
      if (sibling) stack.push({ element: sibling, depth: frame.depth });
      const child = htmlEl.firstElementChild;
      if (child) {
        if (frame.depth < MAX_DOM_SCAN_DEPTH) {
          stack.push({ element: child, depth: frame.depth + 1 });
        } else {
          truncated = true;
        }
      }

      try {
        const style = window.getComputedStyle(htmlEl);
        if (style.position !== 'fixed' && style.position !== 'sticky') continue;
        // Filter out tiny or invisible elements, and elements that are part of the extension UI.
        if (
          htmlEl.offsetWidth > 1 &&
          htmlEl.offsetHeight > 1 &&
          !htmlEl.id.startsWith('webpage-mcp-')
        ) {
          fixed.push({
            element: htmlEl,
            originalDisplay: htmlEl.style.display,
          });
          if (fixed.length >= MAX_HIDDEN_FIXED_ELEMENTS) {
            truncated = truncated || stack.length > 0;
            break;
          }
        }
      } catch {
        // A hostile element must not abort cleanup for the rest of the page.
      }
    }

    return { items: fixed, visited, truncated };
  }

  /**
   * Hide fixed/sticky elements
   */
  function hideFixedElements() {
    const result = getFixedElements();
    hiddenFixedElements = [];
    for (const item of result.items) {
      try {
        item.element.style.display = 'none';
        hiddenFixedElements.push(item);
      } catch {
        // Continue so every successfully hidden element remains tracked for cleanup.
      }
    }
    return {
      hidden: hiddenFixedElements.length,
      visited: result.visited,
      truncated: result.truncated,
    };
  }

  /**
   * Restore fixed/sticky elements
   */
  function showFixedElements() {
    const items = hiddenFixedElements;
    hiddenFixedElements = [];
    for (const item of items) {
      try {
        item.element.style.display = item.originalDisplay || '';
      } catch {
        // Continue restoring the remaining bounded set.
      }
    }
  }

  function restorePageStyles() {
    if (cleanupTimer !== null) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
    showFixedElements();
    if (originalOverflowStyle !== null) {
      try {
        document.documentElement.style.overflow = originalOverflowStyle;
      } catch {
        // Best effort.
      }
      originalOverflowStyle = null;
    }
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    // Respond to ping message
    if (request.action === 'chrome_screenshot_ping') {
      sendResponse({ status: 'pong' });
      return false; // Synchronous response
    }

    // Prepare page for capture
    else if (request.action === 'preparePageForCapture') {
      // A superseding preparation must first undo any styles left by the prior capture.
      restorePageStyles();
      let fixedElementScan = { hidden: 0, visited: 0, truncated: false };
      try {
        originalOverflowStyle = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden'; // Hide main scrollbar
        if (request.options?.fullPage) {
          // Only hide fixed elements for full page to avoid flicker
          fixedElementScan = hideFixedElements();
        }
        // If the caller disappears before reset, do not leave the page modified indefinitely.
        cleanupTimer = setTimeout(restorePageStyles, MAX_PAGE_PREPARATION_MS);
      } catch {
        restorePageStyles();
        sendResponse({ success: false, error: 'Unable to prepare page styles for capture.' });
        return false;
      }
      // Give styles a moment to apply
      setTimeout(() => {
        sendResponse({ success: true, fixedElementScan });
      }, 50);
      return true; // Async response
    }

    // Get page details
    else if (request.action === 'getPageDetails') {
      const body = document.body;
      const html = document.documentElement;
      sendResponse({
        totalWidth: Math.max(
          body.scrollWidth,
          body.offsetWidth,
          html.clientWidth,
          html.scrollWidth,
          html.offsetWidth,
        ),
        totalHeight: Math.max(
          body.scrollHeight,
          body.offsetHeight,
          html.clientHeight,
          html.scrollHeight,
          html.offsetHeight,
        ),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        currentScrollX: window.scrollX,
        currentScrollY: window.scrollY,
      });
    }

    // Get element details
    else if (request.action === 'getElementDetails') {
      const element = document.querySelector(request.selector);
      if (element) {
        element.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
        setTimeout(() => {
          // Wait for scroll
          const rect = element.getBoundingClientRect();
          sendResponse({
            rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            devicePixelRatio: window.devicePixelRatio || 1,
          });
        }, 200); // Increased delay for scrollIntoView
        return true; // Async response
      } else {
        sendResponse({ error: `Element with selector "${request.selector}" not found.` });
      }
      return true; // Async response
    }

    // Scroll page
    else if (request.action === 'scrollPage') {
      window.scrollTo({ left: request.x, top: request.y, behavior: 'instant' });
      // Wait for scroll and potential reflows/lazy-loading
      setTimeout(() => {
        sendResponse({
          success: true,
          newScrollX: window.scrollX,
          newScrollY: window.scrollY,
        });
      }, request.scrollDelay || 300); // Configurable delay
      return true; // Async response
    }

    // Reset page
    else if (request.action === 'resetPageAfterCapture') {
      restorePageStyles();
      if (typeof request.scrollX !== 'undefined' && typeof request.scrollY !== 'undefined') {
        window.scrollTo({ left: request.scrollX, top: request.scrollY, behavior: 'instant' });
      }
      sendResponse({ success: true });
    }

    return false; // Synchronous response
  });
}
