/* eslint-disable */
// wait-helper.js
// Listen for text appearance/disappearance in the current document using MutationObserver.
// Returns a stable ref (compatible with accessibility-tree-helper) for the first matching element.

(function () {
  if (window.__WAIT_HELPER_INITIALIZED__) return;
  window.__WAIT_HELPER_INITIALIZED__ = true;

  // Ensure ref mapping infra exists (compatible with accessibility-tree-helper.js)
  if (!window.__claudeElementMap) window.__claudeElementMap = {};
  if (!window.__claudeRefCounter) window.__claudeRefCounter = 0;

  const WAIT_LIMITS = Object.freeze({
    maxTimeoutMs: 120000,
    maxTextLength: 4096,
    maxSelectorLength: 16384,
    maxScannedElements: 5000,
    maxDirectTextChars: 4096,
    maxChildNodesPerElement: 128,
    mutationCheckDelayMs: 50,
  });
  const PRIORITIZED_TEXT_SELECTOR =
    "a,button,input,textarea,select,label,summary,[role]";

  function isVisible(el) {
    try {
      if (!(el instanceof Element)) return false;
      const style = getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      )
        return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  function normalize(str) {
    return String(str || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function directTextMatches(el, needle) {
    let remaining = WAIT_LIMITS.maxDirectTextChars;
    let inspected = 0;
    try {
      for (const child of el.childNodes || []) {
        inspected += 1;
        if (remaining <= 0 || inspected > WAIT_LIMITS.maxChildNodesPerElement)
          break;
        if (child.nodeType !== Node.TEXT_NODE) continue;
        const chunk = String(child.nodeValue || "").slice(0, remaining);
        remaining -= chunk.length;
        if (normalize(chunk).includes(needle)) return true;
      }
    } catch {}
    return false;
  }

  function hasMatchingText(el, needle) {
    try {
      const aria = el.getAttribute("aria-label");
      if (
        aria &&
        normalize(aria.slice(0, WAIT_LIMITS.maxDirectTextChars)).includes(
          needle,
        )
      )
        return true;
      const title = el.getAttribute("title");
      if (
        title &&
        normalize(title.slice(0, WAIT_LIMITS.maxDirectTextChars)).includes(
          needle,
        )
      )
        return true;
      const alt = el.getAttribute("alt");
      if (
        alt &&
        normalize(alt.slice(0, WAIT_LIMITS.maxDirectTextChars)).includes(needle)
      )
        return true;
      const placeholder = el.getAttribute("placeholder");
      if (
        placeholder &&
        normalize(
          placeholder.slice(0, WAIT_LIMITS.maxDirectTextChars),
        ).includes(needle)
      )
        return true;
      // input/textarea value
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const value = el.value || el.getAttribute("value");
        if (
          value &&
          normalize(
            String(value).slice(0, WAIT_LIMITS.maxDirectTextChars),
          ).includes(needle)
        )
          return true;
      }
      if (directTextMatches(el, needle)) return true;
    } catch {}
    return false;
  }

  function findElementByText(text) {
    const needle = normalize(text);
    if (!needle) return null;
    const root = document.body || document.documentElement;
    if (!root) return null;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let count = 0;
    let current = root;
    while (current && count < WAIT_LIMITS.maxScannedElements) {
      count += 1;
      const el = /** @type {Element} */ (current);
      if (hasMatchingText(el, needle)) {
        let prioritized = null;
        try {
          prioritized = el.closest(PRIORITIZED_TEXT_SELECTOR);
        } catch {}
        if (prioritized && isVisible(prioritized)) return prioritized;
        if (isVisible(el)) return el;
      }
      current = walker.nextNode();
    }
    return null;
  }

  function ensureRefForElement(el) {
    // Try to reuse an existing ref
    for (const k in window.__claudeElementMap) {
      const weak = window.__claudeElementMap[k];
      if (weak && typeof weak.deref === "function" && weak.deref() === el)
        return k;
    }
    const refId = `ref_${++window.__claudeRefCounter}`;
    window.__claudeElementMap[refId] = new WeakRef(el);
    return refId;
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  }

  function normalizeTimeout(value, fallback = 5000) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(WAIT_LIMITS.maxTimeoutMs, Math.max(0, Math.floor(parsed)));
  }

  function waitForMutationResult(check, timeout, timeoutResult) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let observer = null;
      let mutationTimer = null;
      let deadlineTimer = null;

      const cleanup = () => {
        try {
          observer && observer.disconnect();
        } catch {}
        observer = null;
        if (mutationTimer !== null) {
          clearTimeout(mutationTimer);
          mutationTimer = null;
        }
        if (deadlineTimer !== null) {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
      };

      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const runCheck = () => {
        if (settled) return;
        try {
          const result = check();
          if (result !== undefined) finish(result);
        } catch (error) {
          fail(error);
        }
      };

      const scheduleCheck = () => {
        if (settled || mutationTimer !== null) return;
        mutationTimer = setTimeout(() => {
          mutationTimer = null;
          runCheck();
        }, WAIT_LIMITS.mutationCheckDelayMs);
      };

      // Establish every cleanup handle before the initial check. An immediate
      // match can now finish safely without touching a TDZ variable.
      deadlineTimer = setTimeout(
        () => finish(timeoutResult()),
        normalizeTimeout(timeout),
      );

      let observerError = null;
      try {
        observer = new MutationObserver(scheduleCheck);
        observer.observe(document.documentElement || document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      } catch (error) {
        observerError = error;
      }

      runCheck();
      if (!settled && observerError) fail(observerError);
    });
  }

  function waitFor({ text, appear = true, timeout = 5000 }) {
    const start = Date.now();
    return waitForMutationResult(
      () => {
        const match = findElementByText(text);
        if (appear && match) {
          const ref = ensureRefForElement(match);
          const center = centerOf(match);
          return {
            success: true,
            matched: { ref, center },
            tookMs: Date.now() - start,
          };
        }
        if (!appear && !match) {
          return { success: true, matched: null, tookMs: Date.now() - start };
        }
        return undefined;
      },
      timeout,
      () => ({ success: false, reason: "timeout", tookMs: Date.now() - start }),
    );
  }

  function waitForSelector({ selector, visible = true, timeout = 5000 }) {
    const start = Date.now();
    return waitForMutationResult(
      () => {
        let el = null;
        try {
          el = document.querySelector(selector);
        } catch {
          return undefined;
        }
        if (!el || (visible && !isVisible(el))) return undefined;
        const ref = ensureRefForElement(el);
        const center = centerOf(el);
        return {
          success: true,
          matched: { ref, center },
          tookMs: Date.now() - start,
        };
      },
      timeout,
      () => ({ success: false, reason: "timeout", tookMs: Date.now() - start }),
    );
  }

  function errorMessage(error) {
    return String(error && error.message ? error.message : error);
  }

  function respondToWait(promise, sendResponse) {
    promise.then(
      (result) => {
        try {
          sendResponse(result);
        } catch {}
      },
      (error) => {
        try {
          sendResponse({ success: false, error: errorMessage(error) });
        } catch {}
      },
    );
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    try {
      if (request && request.action === "wait_helper_ping") {
        sendResponse({ status: "pong" });
        return false;
      }
      if (request && request.action === "waitForText") {
        const text = String(request.text || "").trim();
        const appear = request.appear !== false; // default true
        const timeout = normalizeTimeout(request.timeout);
        if (!text) {
          sendResponse({ success: false, error: "text is required" });
          return true;
        }
        if (text.length > WAIT_LIMITS.maxTextLength) {
          sendResponse({ success: false, error: "text is too long" });
          return true;
        }
        respondToWait(waitFor({ text, appear, timeout }), sendResponse);
        return true; // async
      }
      if (request && request.action === "waitForSelector") {
        const selector = String(request.selector || "").trim();
        const visible = request.visible !== false; // default true
        const timeout = normalizeTimeout(request.timeout);
        if (!selector) {
          sendResponse({ success: false, error: "selector is required" });
          return true;
        }
        if (selector.length > WAIT_LIMITS.maxSelectorLength) {
          sendResponse({ success: false, error: "selector is too long" });
          return true;
        }
        respondToWait(
          waitForSelector({ selector, visible, timeout }),
          sendResponse,
        );
        return true; // async
      }
    } catch (e) {
      sendResponse({ success: false, error: errorMessage(e) });
      return true;
    }
    return false;
  });
})();
