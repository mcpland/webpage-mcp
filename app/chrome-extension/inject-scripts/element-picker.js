/**
 * Element Picker Inject Script
 *
 * Injected script to let the user manually pick elements for chrome_request_element_selection.
 * - Writes refs into window.__claudeElementMap (compatible with accessibility-tree-helper.js)
 * - Generates stable CSS selectors (prefers id/data-testid/etc.)
 * - Supports iframe picking by reporting selection via chrome.runtime.sendMessage (background reads sender.frameId)
 */

(function () {
  'use strict';

  // Prevent double initialization
  if (window.__MCP_ELEMENT_PICKER_INITIALIZED__) return;
  window.__MCP_ELEMENT_PICKER_INITIALIZED__ = true;

  // ============================================================
  // Constants
  // ============================================================

  const UI_HOST_ID = '__mcp_element_picker_host__';
  const HIGHLIGHT_ID = '__mcp_element_picker_highlight__';
  const MAX_TEXT_LEN = 160;
  const MAX_TEXT_BYTES = 2 * 1024;
  const MAX_TEXT_SCAN_NODES = 512;
  const MAX_TEXT_SCAN_DEPTH = 64;
  const MAX_TEXT_SCAN_MS = 25;
  const MAX_SELECTOR_BYTES = 4 * 1024;
  const MAX_SELECTOR_TOKEN_BYTES = 512;
  const MAX_SESSION_ID_BYTES = 128;
  const MAX_REQUEST_ID_BYTES = 128;
  const MAX_ERROR_BYTES = 4 * 1024;
  const MAX_SELECTOR_SCAN_NODES = 12000;
  const MAX_SELECTOR_SCAN_DEPTH = 128;
  const MAX_SELECTOR_SCAN_MS = 250;
  const MAX_SELECTOR_STEPS = 4096;
  const MAX_SIBLING_STEPS = 128;
  const MAX_LIVE_REFS = 5000;

  // Highlight colors matching Editorial accent (terracotta)
  const HIGHLIGHT_COLOR = '#d97757';
  const HIGHLIGHT_BG = 'rgba(217, 119, 87, 0.08)';
  const HIGHLIGHT_BORDER = 'rgba(217, 119, 87, 0.4)';

  // ============================================================
  // State
  // ============================================================

  const STATE = {
    active: false,
    sessionId: null,
    activeRequestId: null,
    listenersAttached: false,
    hoverRafId: null,
    pendingHoverEvent: null,
    lastHoverEl: null,
    highlighter: null,
  };

  function utf8BytesForCodePoint(codePoint) {
    if (codePoint <= 0x7f) return 1;
    if (codePoint <= 0x7ff) return 2;
    if (codePoint <= 0xffff) return 3;
    return 4;
  }

  function utf8ByteLength(value, stopAfter = Number.POSITIVE_INFINITY) {
    let bytes = 0;
    for (const character of typeof value === 'string' ? value : '') {
      bytes += utf8BytesForCodePoint(character.codePointAt(0) || 0);
      if (bytes > stopAfter) return bytes;
    }
    return bytes;
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

  function normalizeBoundedId(value, maximumBytes) {
    if (typeof value !== 'string') return '';
    if (
      value.length > maximumBytes ||
      utf8ByteLength(value, maximumBytes) > maximumBytes
    ) {
      return '';
    }
    const normalized = value.trim();
    if (!normalized) return '';
    return normalized;
  }

  // ============================================================
  // CSS Escape Helper
  // ============================================================

  function cssEscape(value) {
    const input = truncateUtf8(
      typeof value === 'string' ? value : '',
      MAX_SELECTOR_TOKEN_BYTES,
    );
    if (!input) return '';
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') {
        const escaped = window.CSS.escape(input);
        return utf8ByteLength(escaped, MAX_SELECTOR_TOKEN_BYTES) <=
          MAX_SELECTOR_TOKEN_BYTES
          ? escaped
          : '';
      }
    } catch {
      // Fallback
    }
    let escaped = '';
    for (const character of input) {
      const part = /[a-zA-Z0-9_-]/.test(character)
        ? character
        : `\\${character.codePointAt(0).toString(16)} `;
      if (
        utf8ByteLength(escaped + part, MAX_SELECTOR_TOKEN_BYTES) >
        MAX_SELECTOR_TOKEN_BYTES
      ) {
        return '';
      }
      escaped += part;
    }
    return escaped;
  }

  function cssEscapeString(value) {
    const input = truncateUtf8(
      typeof value === 'string' ? value : '',
      MAX_SELECTOR_TOKEN_BYTES,
    );
    if (!input) return '';
    let escaped = '';
    for (const character of input) {
      let part = character;
      if (character === '\\' || character === '"') part = `\\${character}`;
      else if (character === '\n') part = '\\a ';
      else if (character === '\r') part = '\\d ';
      else if (character === '\f') part = '\\c ';
      else if (character === '\0') part = '\ufffd';
      if (
        utf8ByteLength(escaped + part, MAX_SELECTOR_TOKEN_BYTES) >
        MAX_SELECTOR_TOKEN_BYTES
      ) {
        return '';
      }
      escaped += part;
    }
    return escaped;
  }

  // ============================================================
  // UI Detection Helpers
  // ============================================================

  function getUiHost() {
    try {
      return document.getElementById(UI_HOST_ID);
    } catch {
      return null;
    }
  }

  function isOverlayElement(node) {
    if (!(node instanceof Node)) return false;
    const host = getUiHost();
    if (!host) return false;
    if (node === host) return true;
    const root =
      typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    return root instanceof ShadowRoot && root.host === host;
  }

  function isEventFromUi(ev) {
    if (!ev) return false;
    return isOverlayElement(ev.target);
  }

  /**
   * Get the deepest page target from an event, handling Shadow DOM.
   */
  function getDeepPageTarget(ev) {
    if (!ev) return null;
    let target = ev.target instanceof Element ? ev.target : null;
    if (!target || isOverlayElement(target)) return null;

    // Retarget through open shadow roots without materializing an unbounded composed path.
    try {
      const x = Number.isFinite(ev.clientX) ? ev.clientX : 0;
      const y = Number.isFinite(ev.clientY) ? ev.clientY : 0;
      for (let depth = 0; depth < MAX_SELECTOR_SCAN_DEPTH; depth += 1) {
        const shadow = target.shadowRoot;
        if (!shadow || typeof shadow.elementFromPoint !== 'function') break;
        const inner = shadow.elementFromPoint(x, y);
        if (
          !(inner instanceof Element) ||
          inner === target ||
          isOverlayElement(inner)
        )
          break;
        target = inner;
      }
    } catch {
      // Use the retargeted event target.
    }
    return target;
  }

  // ============================================================
  // Highlighter
  // ============================================================

  function ensureHighlighter() {
    if (STATE.highlighter && STATE.highlighter.isConnected) {
      return STATE.highlighter;
    }

    // Remove any existing highlighter
    try {
      const existing = document.getElementById(HIGHLIGHT_ID);
      if (existing) existing.remove();
    } catch {
      // Best effort
    }

    const hl = document.createElement('div');
    hl.id = HIGHLIGHT_ID;
    Object.assign(hl.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '0px',
      height: '0px',
      border: `2px solid ${HIGHLIGHT_COLOR}`,
      borderRadius: '4px',
      boxShadow: `0 0 0 1px ${HIGHLIGHT_BORDER}`,
      background: HIGHLIGHT_BG,
      pointerEvents: 'none',
      zIndex: '2147483647',
      display: 'none',
      transition:
        'transform 60ms linear, width 60ms linear, height 60ms linear',
    });

    try {
      (document.documentElement || document.body).appendChild(hl);
    } catch {
      // Best effort
    }

    STATE.highlighter = hl;
    return hl;
  }

  function clearHighlighter() {
    const hl = STATE.highlighter;
    if (!hl) return;
    try {
      hl.style.display = 'none';
    } catch {
      // Best effort
    }
  }

  function moveHighlighterTo(el) {
    const hl = ensureHighlighter();
    if (!hl || !(el instanceof Element)) return;

    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      clearHighlighter();
      return;
    }

    if (!rect || rect.width <= 0 || rect.height <= 0) {
      clearHighlighter();
      return;
    }

    try {
      hl.style.display = 'block';
      hl.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
      hl.style.width = `${Math.round(rect.width)}px`;
      hl.style.height = `${Math.round(rect.height)}px`;
    } catch {
      // Best effort
    }
  }

  // ============================================================
  // Selector Uniqueness Check (Optimized)
  // ============================================================

  function createSelectorBudget() {
    return {
      nodes: 0,
      steps: 0,
      deadline: Date.now() + MAX_SELECTOR_SCAN_MS,
    };
  }

  function consumeSelectorStep(budget) {
    budget.steps += 1;
    return budget.steps <= MAX_SELECTOR_STEPS && Date.now() <= budget.deadline;
  }

  /** Check uniqueness without creating a page-sized static NodeList. */
  function isSelectorUnique(selector, target, budget) {
    if (
      !selector ||
      !(target instanceof Element) ||
      !budget ||
      utf8ByteLength(selector, MAX_SELECTOR_BYTES) > MAX_SELECTOR_BYTES
    ) {
      return false;
    }

    try {
      const root = target.getRootNode();
      let first = null;
      if (root === document) first = document.documentElement;
      else if (root instanceof ShadowRoot) first = root.firstElementChild;
      if (!(first instanceof Element)) return false;

      const stack = [{ node: first, depth: 0 }];
      let firstMatch = null;
      let matchCount = 0;
      while (stack.length > 0) {
        if (
          budget.nodes >= MAX_SELECTOR_SCAN_NODES ||
          Date.now() > budget.deadline
        ) {
          return false;
        }
        const frame = stack.pop();
        if (!frame || frame.depth > MAX_SELECTOR_SCAN_DEPTH) return false;
        const node = frame.node;
        budget.nodes += 1;

        if (node.matches(selector)) {
          matchCount += 1;
          if (matchCount === 1) firstMatch = node;
          if (matchCount > 1) return false;
        }

        const sibling = node.nextElementSibling;
        const child = node.firstElementChild;
        if (sibling) stack.push({ node: sibling, depth: frame.depth });
        if (child) stack.push({ node: child, depth: frame.depth + 1 });
      }
      return matchCount === 1 && firstMatch === target;
    } catch {
      return false;
    }
  }

  // ============================================================
  // Selector Generation (Stable & Unique)
  // ============================================================

  function buildSegment(element, budget) {
    const tag = element.tagName.toLowerCase();
    let sibling = element.previousElementSibling;
    let index = 1;
    let scanned = 0;
    while (sibling) {
      scanned += 1;
      if (scanned > MAX_SIBLING_STEPS || !consumeSelectorStep(budget))
        return tag;
      if (sibling.tagName === element.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    if (index > 1) return `${tag}:nth-of-type(${index})`;

    sibling = element.nextElementSibling;
    scanned = 0;
    while (sibling) {
      scanned += 1;
      if (scanned > MAX_SIBLING_STEPS || !consumeSelectorStep(budget))
        return tag;
      if (sibling.tagName === element.tagName) return `${tag}:nth-of-type(1)`;
      sibling = sibling.nextElementSibling;
    }
    return tag;
  }

  function addPathSegment(segments, segment) {
    const candidate = [segment, ...segments].join(' > ');
    if (utf8ByteLength(candidate, MAX_SELECTOR_BYTES) > MAX_SELECTOR_BYTES)
      return false;
    segments.unshift(segment);
    return true;
  }

  function buildPathFromAncestor(ancestor, target, budget) {
    const segs = [];
    let cur = target;
    let depth = 0;

    while (cur && cur !== ancestor && depth < MAX_SELECTOR_SCAN_DEPTH) {
      if (!consumeSelectorStep(budget)) break;
      const seg = buildSegment(cur, budget);
      if (!addPathSegment(segs, seg)) break;
      const parent = cur.parentElement;
      cur = parent;
      depth += 1;
    }

    return segs.join(' > ');
  }

  function buildFullPath(el, budget) {
    const segments = [];
    let current = el;
    let depth = 0;

    while (
      current &&
      current.nodeType === Node.ELEMENT_NODE &&
      depth < MAX_SELECTOR_SCAN_DEPTH &&
      consumeSelectorStep(budget)
    ) {
      const sel = buildSegment(current, budget);
      if (!addPathSegment(segments, sel)) break;
      const parent = current.parentElement;
      current = parent;
      depth += 1;
    }

    return segments.join(' > ') || el.tagName.toLowerCase();
  }

  /**
   * Generate a stable CSS selector for an element.
   * Prioritizes: id > data-testid/data-test/etc > anchor + relative path > full path
   */
  function generateSelector(el) {
    if (!(el instanceof Element)) return '';
    const budget = createSelectorBudget();

    // Prefer unique IDs
    try {
      if (el.id) {
        const idSel = `#${cssEscape(el.id)}`;
        if (idSel !== '#' && isSelectorUnique(idSel, el, budget)) return idSel;
      }
    } catch {
      // Continue
    }

    // Prefer stable test attributes
    try {
      const attrNames = [
        'data-testid',
        'data-testId',
        'data-test',
        'data-qa',
        'data-cy',
        'name',
        'aria-label',
        'title',
        'alt',
      ];
      const tag = el.tagName.toLowerCase();
      for (const attr of attrNames) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        const escaped = cssEscapeString(v);
        if (!escaped) continue;
        const attrSel = `[${attr}="${escaped}"]`;
        const testSel = /^(input|textarea|select)$/i.test(tag)
          ? `${tag}${attrSel}`
          : attrSel;
        if (isSelectorUnique(testSel, el, budget)) return testSel;
      }
    } catch {
      // Continue
    }

    // Anchor + relative path
    try {
      let cur = el;
      const anchorAttrs = [
        'id',
        'data-testid',
        'data-testId',
        'data-test',
        'data-qa',
        'data-cy',
        'name',
      ];

      let depth = 0;
      while (
        cur &&
        depth < MAX_SELECTOR_SCAN_DEPTH &&
        consumeSelectorStep(budget)
      ) {
        if (cur.id) {
          const anchor = `#${cssEscape(cur.id)}`;
          if (anchor !== '#' && isSelectorUnique(anchor, cur, budget)) {
            const rel = buildPathFromAncestor(cur, el, budget);
            const composed = rel ? `${anchor} ${rel}` : anchor;
            if (isSelectorUnique(composed, el, budget)) return composed;
          }
        }

        for (const attr of anchorAttrs) {
          const val = cur.getAttribute(attr);
          if (!val) continue;
          const escaped = cssEscapeString(val);
          if (!escaped) continue;
          const aSel = `[${attr}="${escaped}"]`;
          if (isSelectorUnique(aSel, cur, budget)) {
            const rel = buildPathFromAncestor(cur, el, budget);
            const composed = rel ? `${aSel} ${rel}` : aSel;
            if (isSelectorUnique(composed, el, budget)) return composed;
          }
        }

        cur = cur.parentElement;
        depth += 1;
      }
    } catch {
      // Continue
    }

    // Fallback to full path
    return buildFullPath(el, budget);
  }

  // ============================================================
  // Text Summarization
  // ============================================================

  function normalizeSummary(value) {
    const bounded = truncateUtf8(
      typeof value === 'string' ? value : '',
      MAX_TEXT_BYTES,
    );
    if (!bounded) return '';
    return truncateUtf8(
      bounded.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT_LEN),
      MAX_TEXT_BYTES,
    );
  }

  function collectBoundedText(el) {
    const first = el.firstChild;
    if (!first) return '';
    const stack = [{ node: first, depth: 0 }];
    const parts = [];
    let bytes = 0;
    let visited = 0;
    const deadline = Date.now() + MAX_TEXT_SCAN_MS;

    while (
      stack.length > 0 &&
      visited < MAX_TEXT_SCAN_NODES &&
      Date.now() <= deadline
    ) {
      const frame = stack.pop();
      if (!frame) break;
      const node = frame.node;
      visited += 1;

      const sibling = node.nextSibling;
      if (sibling) stack.push({ node: sibling, depth: frame.depth });

      if (node.nodeType === Node.TEXT_NODE) {
        const remaining = MAX_TEXT_BYTES - bytes;
        if (remaining <= 0) break;
        const part = truncateUtf8(
          typeof node.nodeValue === 'string' ? node.nodeValue : '',
          remaining,
        );
        if (part) {
          parts.push(part);
          bytes += utf8ByteLength(part) + 1;
        }
        continue;
      }

      if (
        node.nodeType !== Node.ELEMENT_NODE ||
        frame.depth >= MAX_TEXT_SCAN_DEPTH
      )
        continue;
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
      const child = node.firstChild;
      if (child) stack.push({ node: child, depth: frame.depth + 1 });
    }

    return normalizeSummary(truncateUtf8(parts.join(' '), MAX_TEXT_BYTES));
  }

  function summarizeText(el) {
    if (!(el instanceof Element)) return '';
    try {
      for (const attribute of ['aria-label', 'placeholder', 'title', 'alt']) {
        const summary = normalizeSummary(el.getAttribute(attribute));
        if (summary) return summary;
      }
    } catch {
      // Continue
    }
    try {
      return collectBoundedText(el);
    } catch {
      return '';
    }
  }

  // ============================================================
  // Ref Management (Compatible with accessibility-tree-helper.js)
  // ============================================================

  function ensureRefForElement(el) {
    try {
      const invalidState =
        !window.__claudeElementMap ||
        typeof window.__claudeElementMap !== 'object' ||
        !(window.__claudeElementRefs instanceof WeakMap) ||
        !Array.isArray(window.__claudeRefOrder) ||
        window.__claudeRefOrder.length > MAX_LIVE_REFS ||
        !Number.isSafeInteger(window.__claudeRefCounter) ||
        window.__claudeRefCounter < 0;
      if (invalidState) {
        window.__claudeElementMap = Object.create(null);
        window.__claudeElementRefs = new WeakMap();
        window.__claudeRefOrder = [];
        window.__claudeRefCounter = 0;
      }
    } catch {
      return '';
    }

    try {
      const map = window.__claudeElementMap;
      const reverse = window.__claudeElementRefs;
      const existing = reverse.get(el);
      if (existing) {
        const weak = map[existing];
        if (weak && typeof weak.deref === 'function' && weak.deref() === el)
          return existing;
      }

      const order = window.__claudeRefOrder;
      if (order.length >= MAX_LIVE_REFS) {
        const expired = order.shift();
        if (expired) delete map[expired];
      }
      const refId = `ref_${++window.__claudeRefCounter}`;
      map[refId] = new WeakRef(el);
      reverse.set(el, refId);
      order.push(refId);
      return refId;
    } catch {
      return '';
    }
  }

  // ============================================================
  // Communication
  // ============================================================

  function sendFrameEvent(payload) {
    try {
      chrome.runtime.sendMessage(payload);
    } catch {
      // Best effort
    }
  }

  // ============================================================
  // Event Handlers
  // ============================================================

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  function processMouseMove(ev) {
    if (!STATE.active) return;

    // Skip if event is from our UI
    if (isEventFromUi(ev)) {
      STATE.lastHoverEl = null;
      clearHighlighter();
      return;
    }

    const target = getDeepPageTarget(ev);
    if (!target) {
      STATE.lastHoverEl = null;
      clearHighlighter();
      return;
    }

    // Skip if same element
    if (STATE.lastHoverEl === target) return;
    STATE.lastHoverEl = target;
    moveHighlighterTo(target);
  }

  function onMouseMove(ev) {
    if (!STATE.active) return;
    STATE.pendingHoverEvent = ev;
    if (STATE.hoverRafId != null) return;
    STATE.hoverRafId = requestAnimationFrame(() => {
      STATE.hoverRafId = null;
      const latest = STATE.pendingHoverEvent;
      STATE.pendingHoverEvent = null;
      if (!latest) return;
      processMouseMove(latest);
    });
  }

  function onClick(ev) {
    if (!STATE.active) return;

    // Allow UI interactions without interference
    if (isEventFromUi(ev)) return;

    const rawTarget = ev.target instanceof Element ? ev.target : null;
    if (!rawTarget) return;

    // Require an active request id so background can map the selection
    if (!STATE.sessionId || !STATE.activeRequestId) return;

    ev.preventDefault();
    ev.stopPropagation();

    const target = getDeepPageTarget(ev) || rawTarget;
    if (!(target instanceof Element)) return;

    const ref = ensureRefForElement(target);
    const selector = generateSelector(target);
    let rect;
    try {
      rect = target.getBoundingClientRect();
    } catch {
      rect = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0 };
    }

    const safeRect = {
      x: finiteNumber(rect.x),
      y: finiteNumber(rect.y),
      width: finiteNumber(rect.width),
      height: finiteNumber(rect.height),
    };
    const left = finiteNumber(rect.left);
    const top = finiteNumber(rect.top);
    const center = {
      x: Math.round(left + safeRect.width / 2),
      y: Math.round(top + safeRect.height / 2),
    };

    sendFrameEvent({
      type: 'element_picker_frame_event',
      sessionId: STATE.sessionId,
      event: 'selected',
      requestId: STATE.activeRequestId,
      element: {
        ref,
        selector: truncateUtf8(selector, MAX_SELECTOR_BYTES),
        selectorType: 'css',
        rect: safeRect,
        center,
        text: summarizeText(target),
        tagName:
          typeof target.tagName === 'string'
            ? truncateUtf8(
                target.tagName.toLowerCase(),
                MAX_SELECTOR_TOKEN_BYTES,
              )
            : '',
      },
    });
  }

  function onKeyDown(ev) {
    if (!STATE.active) return;
    if (ev && ev.key === 'Escape') {
      if (isEventFromUi(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (STATE.sessionId) {
        sendFrameEvent({
          type: 'element_picker_frame_event',
          sessionId: STATE.sessionId,
          event: 'cancel',
        });
      }
    }
  }

  // ============================================================
  // Listener Management
  // ============================================================

  function attachListeners() {
    if (STATE.listenersAttached) return;
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    STATE.listenersAttached = true;
  }

  function detachListeners() {
    if (!STATE.listenersAttached) return;
    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    STATE.listenersAttached = false;
  }

  // ============================================================
  // Session Management API
  // ============================================================

  function startSession(payload) {
    const sessionId = normalizeBoundedId(
      payload && payload.sessionId,
      MAX_SESSION_ID_BYTES,
    );
    if (!sessionId) return false;

    const rawRequestId = payload && payload.activeRequestId;
    const activeRequestId = rawRequestId
      ? normalizeBoundedId(rawRequestId, MAX_REQUEST_ID_BYTES)
      : '';
    if (rawRequestId && !activeRequestId) return false;

    STATE.active = true;
    STATE.sessionId = sessionId;
    STATE.activeRequestId = activeRequestId || null;
    ensureHighlighter();
    attachListeners();
    return true;
  }

  function stopSession(payload) {
    const rawSessionId = payload && payload.sessionId;
    const sessionId = rawSessionId
      ? normalizeBoundedId(rawSessionId, MAX_SESSION_ID_BYTES)
      : '';
    if (rawSessionId && !sessionId) return false;
    // Only stop if session matches or no specific session requested
    if (sessionId && STATE.sessionId && sessionId !== STATE.sessionId)
      return false;

    STATE.active = false;
    STATE.sessionId = null;
    STATE.activeRequestId = null;
    STATE.lastHoverEl = null;
    detachListeners();
    clearHighlighter();

    // Remove highlighter element
    try {
      const hl = STATE.highlighter;
      if (hl && hl.remove) hl.remove();
    } catch {
      // Best effort
    }
    STATE.highlighter = null;
    return true;
  }

  function setActiveRequest(payload) {
    const rawSessionId = payload && payload.sessionId;
    const sessionId = rawSessionId
      ? normalizeBoundedId(rawSessionId, MAX_SESSION_ID_BYTES)
      : '';
    if (rawSessionId && !sessionId) return false;
    if (sessionId && STATE.sessionId && sessionId !== STATE.sessionId)
      return false;

    const rawRequestId = payload && payload.activeRequestId;
    const activeRequestId = rawRequestId
      ? normalizeBoundedId(rawRequestId, MAX_REQUEST_ID_BYTES)
      : '';
    if (rawRequestId && !activeRequestId) return false;
    STATE.activeRequestId = activeRequestId || null;
    return true;
  }

  // ============================================================
  // Expose API for Background Script
  // ============================================================

  window.__mcpElementPicker = {
    startSession,
    stopSession,
    setActiveRequest,
  };

  // ============================================================
  // Message Listener (for direct communication)
  // ============================================================

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    try {
      if (
        request &&
        request.action === 'chrome_request_element_selection_ping'
      ) {
        sendResponse({ status: 'pong' });
        return false;
      }
      if (request && request.action === 'elementPickerStart') {
        sendResponse({ success: startSession(request) });
        return false;
      }
      if (request && request.action === 'elementPickerStop') {
        sendResponse({ success: stopSession(request) });
        return false;
      }
      if (request && request.action === 'elementPickerSetActiveRequest') {
        sendResponse({ success: setActiveRequest(request) });
        return false;
      }
    } catch (e) {
      const error =
        e && typeof e.message === 'string'
          ? e.message
          : 'Element picker failed';
      sendResponse({
        success: false,
        error: truncateUtf8(error, MAX_ERROR_BYTES),
      });
      return false;
    }
    return false;
  });
})();
