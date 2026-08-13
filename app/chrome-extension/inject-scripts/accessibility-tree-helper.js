/* eslint-disable */
// accessibility-tree-helper.js
// Injected script to generate an accessibility-like tree of the visible page
// Elements receive stable refs (ref_*) via WeakRef mapping for later reference.

(function () {
  if (window.__ACCESSIBILITY_TREE_HELPER_INITIALIZED__) return;
  window.__ACCESSIBILITY_TREE_HELPER_INITIALIZED__ = true;

  // Traversal and output limits to ensure stability on hostile pages.
  const MAX_DEPTH = 30;
  const MAX_DOM_DEPTH = 128;
  const MAX_VISITED_NODES = 12000;
  const MAX_INCLUDED_NODES = 4000;
  const MAX_STYLE_CHECKS = 4000;
  const MAX_LAYOUT_CHECKS = 5000;
  const MAX_TEXT_READS = 4000;
  const MAX_TEXT_NODES_PER_LABEL = 64;
  const MAX_SELECTOR_STEPS = 8000;
  const MAX_SIBLING_STEPS = 128;
  const MAX_LINE_LABEL = 100;
  const MAX_ATTRIBUTE_BYTES = 512;
  const MAX_SELECTOR_BYTES = 1024;
  const MAX_PAGE_CONTENT_BYTES = 384 * 1024;
  const REF_MAP_LIMIT = 256;
  const MAX_LIVE_REFS = 5000;
  const MAX_TARGET_SELECTOR_BYTES = 4 * 1024;
  const MAX_TARGET_TEXT_BYTES = 1024;
  const MAX_TARGET_ERROR_BYTES = 4 * 1024;
  const MAX_TARGET_SCAN_NODES = 12000;
  const MAX_TARGET_SCAN_DEPTH = 128;
  const MAX_TARGET_SCAN_MS = 250;
  const MAX_TARGET_STYLE_CHECKS = 1000;
  const MAX_TARGET_LAYOUT_CHECKS = 1000;
  const MAX_VARIABLE_COUNT = 128;
  const MAX_VARIABLE_PAYLOAD_BYTES = 256 * 1024;
  const MAX_VARIABLE_KEY_BYTES = 128;
  const MAX_VARIABLE_LABEL_BYTES = 512;
  const MAX_VARIABLE_VALUE_BYTES = 8 * 1024;
  const MAX_VARIABLE_VALUES_BYTES = 256 * 1024;
  const MAX_OVERLAY_LINES = 200;
  const MAX_OVERLAY_LINE_BYTES = 4 * 1024;
  const MAX_OVERLAY_TEXT_BYTES = 256 * 1024;

  // Keep a weak map from ref id to elements
  if (!window.__claudeElementMap) window.__claudeElementMap = {};
  if (!window.__claudeRefCounter) window.__claudeRefCounter = 0;
  if (!window.__claudeElementRefs) window.__claudeElementRefs = new WeakMap();
  if (!window.__claudeRefOrder) window.__claudeRefOrder = [];
  if (!window.__rrOverlayState) window.__rrOverlayState = { bytes: 0 };
  if (!window.__rrPickerCleanup) window.__rrPickerCleanup = null;

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

  function cleanLineValue(value, maximumBytes = MAX_ATTRIBUTE_BYTES) {
    return truncateUtf8(value, maximumBytes)
      .replace(/\s+/g, ' ')
      .replace(/"/g, '\\"')
      .trim();
  }

  function cssEscapeIdentifier(value) {
    const input = truncateUtf8(value, MAX_SELECTOR_BYTES);
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(input);
    }
    return input.replace(/[^a-zA-Z0-9_-]/g, (character) => {
      return `\\${character.codePointAt(0).toString(16)} `;
    });
  }

  function markTreeTruncated(state, reason) {
    if (!state) return;
    state.truncated = true;
    if (state.truncationReasons.size < 8) state.truncationReasons.add(reason);
  }

  function ensureRef(element) {
    const reverse = window.__claudeElementRefs;
    const map = window.__claudeElementMap;
    const existing = reverse.get(element);
    if (existing) {
      const weak = map[existing];
      if (weak && typeof weak.deref === 'function' && weak.deref() === element) {
        return existing;
      }
    }

    const order = window.__claudeRefOrder;
    while (order.length >= MAX_LIVE_REFS) {
      const expired = order.shift();
      if (expired) delete map[expired];
    }
    const refId = `ref_${++window.__claudeRefCounter}`;
    map[refId] = new WeakRef(element);
    reverse.set(element, refId);
    order.push(refId);
    return refId;
  }

  function collectBoundedText(root, state, maximumBytes = MAX_ATTRIBUTE_BYTES) {
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let output = '';
    let current = walker.nextNode();
    let nodes = 0;
    while (current && nodes < MAX_TEXT_NODES_PER_LABEL) {
      if (state && state.textReads >= MAX_TEXT_READS) {
        markTreeTruncated(state, 'text_reads');
        break;
      }
      if (state) state.textReads++;
      const remaining = maximumBytes - utf8ByteLength(output);
      if (remaining <= 0) break;
      const piece = truncateUtf8(current.nodeValue || '', remaining);
      output += piece;
      if (piece.length < String(current.nodeValue || '').length) break;
      nodes++;
      current = walker.nextNode();
    }
    if (current) markTreeTruncated(state, 'label_text');
    return output.replace(/\s+/g, ' ').trim();
  }

  /**
   * Infer ARIA-like role from element
   * @param {Element} el
   * @returns {string}
   */
  function inferRole(el) {
    const role = el.getAttribute('role');
    if (role) return cleanLineValue(role, 64) || 'generic';
    const tag = el.tagName.toLowerCase();
    const type = truncateUtf8(el.getAttribute('type') || '', 64);
    const map = {
      a: 'link',
      button: 'button',
      input:
        type === 'submit' || type === 'button'
          ? 'button'
          : type === 'checkbox'
            ? 'checkbox'
            : type === 'radio'
              ? 'radio'
              : type === 'file'
                ? 'button'
                : 'textbox',
      select: 'combobox',
      textarea: 'textbox',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      img: 'image',
      nav: 'navigation',
      main: 'main',
      header: 'banner',
      footer: 'contentinfo',
      section: 'region',
      article: 'article',
      aside: 'complementary',
      form: 'form',
      table: 'table',
      ul: 'list',
      ol: 'list',
      li: 'listitem',
      label: 'label',
    };
    return map[tag] || 'generic';
  }

  /**
   * Derive readable label for element
   * @param {Element} el
   * @returns {string}
   */
  function inferLabel(el, state) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      const sel = /** @type {HTMLSelectElement} */ (el);
      const opt =
        sel.querySelector('option[selected]') || sel.options[sel.selectedIndex];
      if (opt) return collectBoundedText(opt, state, MAX_ATTRIBUTE_BYTES);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return cleanLineValue(aria);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return cleanLineValue(placeholder);
    const title = el.getAttribute('title');
    if (title && title.trim()) return cleanLineValue(title);
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return cleanLineValue(alt);
    if (tag === 'input') {
      const input = /** @type {HTMLInputElement} */ (el);
      const type = input.getAttribute('type') || '';
      const val = input.getAttribute('value');
      if (type === 'submit' && val && val.trim()) return cleanLineValue(val);
      if (input.value && input.value.length < 50 && input.value.trim())
        return cleanLineValue(input.value);
    }
    if (['button', 'a', 'summary'].includes(tag)) {
      const text = collectBoundedText(el, state, MAX_ATTRIBUTE_BYTES);
      if (text) return text;
    }
    if (/^h[1-6]$/.test(tag)) {
      const text = collectBoundedText(el, state, MAX_ATTRIBUTE_BYTES);
      if (text) return text;
    }
    if (tag === 'img') {
      const src = truncateUtf8(el.getAttribute('src') || '', 1024);
      if (src) {
        const lastSlash = src.lastIndexOf('/');
        const tail = src.slice(lastSlash + 1);
        const query = tail.indexOf('?');
        const file = query >= 0 ? tail.slice(0, query) : tail;
        return `Image: ${cleanLineValue(file || '')}`;
      }
    }
    const agg = collectBoundedText(el, state, MAX_ATTRIBUTE_BYTES);
    if (agg && agg.length >= 3) {
      const v = agg;
      return v.length > 50 ? v.substring(0, 50) + '...' : v;
    }
    return '';
  }

  /**
   * Check if element is visible in DOM
   * @param {Element} el
   */
  function isVisible(el, state) {
    if (state && state.styleChecks >= MAX_STYLE_CHECKS) {
      markTreeTruncated(state, 'style_checks');
      return false;
    }
    if (state) state.styleChecks++;
    const cs = window.getComputedStyle(/** @type {HTMLElement} */ (el));
    if (
      cs.display === 'none' ||
      cs.visibility === 'hidden' ||
      cs.opacity === '0'
    )
      return false;
    if (state && state.layoutChecks >= MAX_LAYOUT_CHECKS) {
      markTreeTruncated(state, 'layout_checks');
      return false;
    }
    if (state) state.layoutChecks++;
    const he = /** @type {HTMLElement} */ (el);
    return he.offsetWidth > 0 && he.offsetHeight > 0;
  }

  /**
   * Whether the element is interactive
   * @param {Element} el
   */
  function isInteractive(el) {
    // Native interactive tags
    const tag = el.tagName.toLowerCase();
    if (
      [
        'a',
        'button',
        'input',
        'select',
        'textarea',
        'details',
        'summary',
      ].includes(tag)
    )
      return true;

    // Generic interactive hints
    if (el.getAttribute('onclick') != null) return true;
    if (
      el.getAttribute('tabindex') != null &&
      String(el.getAttribute('tabindex')).trim() !== '' &&
      !String(el.getAttribute('tabindex')).trim().startsWith('-')
    )
      return true;
    if (el.getAttribute('contenteditable') === 'true') return true;

    // ARIA roles commonly used by custom elements
    const role = truncateUtf8(
      (el.getAttribute && el.getAttribute('role')) || '',
      64,
    );
    const interactiveRoles = new Set([
      'button',
      'link',
      'checkbox',
      'radio',
      'switch',
      'slider',
      'option',
      'menuitem',
      'textbox',
      'searchbox',
      'combobox',
      'spinbutton',
      'tab',
      'treeitem',
    ]);
    if (role && interactiveRoles.has(role.toLowerCase())) return true;

    // Shadow host case: treat host as interactive if its open shadow root contains
    // an interactive control (textarea/input/select/button/a or contenteditable).
    try {
      const anyEl = /** @type {any} */ (el);
      const sr = anyEl && anyEl.shadowRoot ? anyEl.shadowRoot : null;
      if (sr) {
        const inner = sr.querySelector(
          'input, textarea, select, button, a[href], [contenteditable="true"], [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="searchbox"], [role="menuitem"], [role="option"], [role="switch"], [role="radio"], [role="checkbox"], [role="tab"], [role="slider"]',
        );
        if (inner) return true;
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  /**
   * Structural containers useful to include
   * @param {Element} el
   */
  function isStructural(el) {
    const tag = el.tagName.toLowerCase();
    if (
      [
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'nav',
        'main',
        'header',
        'footer',
        'section',
        'article',
        'aside',
      ].includes(tag)
    )
      return true;
    return el.getAttribute('role') != null;
  }

  /**
   * Form-ish containers to keep
   * @param {Element} el
   */
  function isFormishContainer(el) {
    const tag = el.tagName.toLowerCase();
    const role = truncateUtf8(
      (el.getAttribute && el.getAttribute('role')) || '',
      64,
    );
    const id = truncateUtf8(/** @type {HTMLElement} */ (el).id || '', 1024);
    // Normalize className for HTML/SVG elements
    let cls = '';
    try {
      const attr = el.getAttribute && el.getAttribute('class');
      if (typeof attr === 'string') cls = truncateUtf8(attr, 1024);
      else {
        const cn = /** @type {any} */ (el).className;
        if (typeof cn === 'string') cls = truncateUtf8(cn, 1024);
        else if (cn && typeof cn.baseVal === 'string') cls = truncateUtf8(cn.baseVal, 1024);
      }
    } catch (e) {
      /* ignore */
    }
    return (
      role === 'search' ||
      role === 'form' ||
      role === 'group' ||
      role === 'toolbar' ||
      role === 'navigation' ||
      tag === 'form' ||
      tag === 'fieldset' ||
      tag === 'nav' ||
      tag === 'legend' ||
      id.includes('search') ||
      cls.includes('search') ||
      id.includes('form') ||
      cls.includes('form') ||
      id.includes('menu') ||
      cls.includes('menu') ||
      id.includes('nav') ||
      cls.includes('nav')
    );
  }

  function targetScanNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function createTargetScanBudget() {
    return {
      nodes: 0,
      styleChecks: 0,
      layoutChecks: 0,
      deadline: targetScanNow() + MAX_TARGET_SCAN_MS,
      truncated: false,
    };
  }

  function createTargetScanFrame(node, depth) {
    return {
      node,
      depth,
      entered: false,
      shadowChild: null,
      lightChild: null,
    };
  }

  // A depth-first scanner with O(depth) auxiliary memory. Wide child lists are
  // followed through sibling pointers rather than copied into an Array.
  function* walkTargetNodesDeep(root, budget) {
    const first =
      root instanceof Node && root.nodeType === Node.ELEMENT_NODE
        ? root
        : root && root.documentElement
          ? root.documentElement
          : root && root.firstElementChild
            ? root.firstElementChild
            : null;
    if (!first) return;
    const stack = [createTargetScanFrame(first, 0)];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame.entered) {
        frame.entered = true;
        if (budget.nodes >= MAX_TARGET_SCAN_NODES) {
          budget.truncated = true;
          return;
        }
        budget.nodes++;
        if ((budget.nodes & 63) === 0 && targetScanNow() > budget.deadline) {
          budget.truncated = true;
          return;
        }
        try {
          frame.lightChild = frame.node.firstChild || null;
        } catch (_) {}
        try {
          frame.shadowChild =
            frame.node instanceof Element && frame.node.shadowRoot
              ? frame.node.shadowRoot.firstChild
              : null;
        } catch (_) {}
        yield frame.node;
        continue;
      }

      let child = null;
      if (frame.shadowChild) {
        child = frame.shadowChild;
        frame.shadowChild = child.nextSibling;
      } else if (frame.lightChild) {
        child = frame.lightChild;
        frame.lightChild = child.nextSibling;
      } else {
        stack.pop();
        continue;
      }
      if (frame.depth >= MAX_TARGET_SCAN_DEPTH) {
        budget.truncated = true;
        continue;
      }
      stack.push(createTargetScanFrame(child, frame.depth + 1));
    }
  }

  function normalizeTargetInput(value, name, maximumBytes) {
    if (typeof value !== 'string') throw new Error(`${name} must be a string`);
    const normalized = value.trim();
    if (!normalized) throw new Error(`${name} is required`);
    if (
      normalized.length > maximumBytes ||
      utf8ByteLength(normalized, maximumBytes) > maximumBytes
    ) {
      throw new Error(`${name} exceeds the ${maximumBytes}-byte UTF-8 limit`);
    }
    return normalized;
  }

  function validateCssTargetSelector(selector) {
    const normalized = normalizeTargetInput(
      selector,
      'selector',
      MAX_TARGET_SELECTOR_BYTES,
    );
    if (/:has\s*\(/iu.test(normalized)) {
      throw new Error('selector must not use the resource-intensive :has() pseudo-class');
    }
    try {
      document.documentElement.matches(normalized);
    } catch (error) {
      throw new Error(
        `Invalid CSS selector: ${truncateUtf8(
          error && error.message ? error.message : String(error),
          512,
        )}`,
      );
    }
    return normalized;
  }

  // Utility: query CSS across the document and open shadow roots (best-effort).
  function querySelectorDeepFirst(selector) {
    const result = querySelectorWithUniquenessCheck(selector, true);
    return result.error ? null : result.element;
  }

  /**
   * Query CSS selector and return match info including uniqueness check.
   * @param {string} selector - CSS selector to query
   * @param {boolean} allowMultiple - If true, skip uniqueness check and return first match
   * @returns {{element: Element | null, matchCount: number, error?: string}}
   * Note: matchCount is capped at 2 (where 2 means "2 or more") for performance
   */
  function querySelectorWithUniquenessCheck(selector, allowMultiple = false) {
    try {
      const normalized = validateCssTargetSelector(selector);
      const budget = createTargetScanBudget();
      let firstMatch = null;
      let matchCount = 0;
      for (const node of walkTargetNodesDeep(document, budget)) {
        if (!(node instanceof Element)) continue;
        if (node.matches(normalized)) {
          matchCount++;
          if (!firstMatch) firstMatch = node;
          if (allowMultiple || matchCount >= 2) {
            return { element: firstMatch, matchCount: allowMultiple ? 1 : 2 };
          }
        }
      }
      if (budget.truncated && (!allowMultiple || !firstMatch)) {
        return {
          element: null,
          matchCount: 0,
          error: 'Selector scan exceeded the bounded page traversal budget',
        };
      }
      return { element: firstMatch, matchCount };
    } catch (error) {
      return {
        element: null,
        matchCount: 0,
        error: truncateUtf8(
          error && error.message ? error.message : String(error),
          MAX_TARGET_ERROR_BYTES,
        ),
      };
    }
  }

  /**
   * Query XPath selector and return match info including uniqueness check.
   * @param {string} selector - XPath selector to query
   * @param {boolean} allowMultiple - If true, skip uniqueness check and return first match
   * @returns {{element: Element | null, matchCount: number, error?: string}}
   * Note: matchCount is capped at 2 (where 2 means "2 or more") for performance
   */
  function queryXPathWithUniquenessCheck(selector, allowMultiple = false) {
    try {
      const normalized = normalizeTargetInput(
        selector,
        'selector',
        MAX_TARGET_SELECTOR_BYTES,
      );
      const structuralTokens = (normalized.match(/\/\/|\[|\]|\(|\)|\|/g) || [])
        .length;
      if (structuralTokens > 128) {
        throw new Error('XPath exceeds the structural complexity limit');
      }
      // XPath evaluation itself is synchronous and cannot be interrupted. Refuse
      // to invoke it when a bounded preflight cannot cover the whole page.
      const pageBudget = createTargetScanBudget();
      for (const _node of walkTargetNodesDeep(document, pageBudget)) {
        // Traversal alone is the preflight.
      }
      if (pageBudget.truncated) {
        throw new Error('XPath page scan exceeds the bounded traversal budget');
      }
      if (allowMultiple) {
        const result = document.evaluate(
          normalized,
          document,
          null,
          XPathResult.ANY_UNORDERED_NODE_TYPE,
          null,
        );
        const firstMatch =
          result.singleNodeValue instanceof Element
            ? /** @type {Element} */ (result.singleNodeValue)
            : null;
        return { element: firstMatch, matchCount: firstMatch ? 1 : 0 };
      } else {
        // Read at most two nodes. Snapshot result types retain every match.
        const iterator = document.evaluate(
          normalized,
          document,
          null,
          XPathResult.ORDERED_NODE_ITERATOR_TYPE,
          null,
        );
        const firstNode = iterator.iterateNext();
        const secondNode = iterator.iterateNext();
        const firstMatch = firstNode instanceof Element ? firstNode : null;
        const matchCount = firstMatch ? (secondNode ? 2 : 1) : 0;
        return { element: firstMatch, matchCount };
      }
    } catch (e) {
      return {
        element: null,
        matchCount: 0,
        error: truncateUtf8(
          `Invalid XPath: ${e && e.message ? e.message : String(e)}`,
          MAX_TARGET_ERROR_BYTES,
        ),
      };
    }
  }

  function normalizeTargetText(value) {
    const normalized = normalizeTargetInput(
      value,
      'text',
      MAX_TARGET_TEXT_BYTES,
    );
    return normalized.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function normalizeTargetTag(value) {
    if (value === undefined || value === null || value === '') return '';
    const tag = normalizeTargetInput(value, 'tagName', 64).toUpperCase();
    if (!/^[A-Z][A-Z0-9-]*$/.test(tag)) throw new Error('tagName is invalid');
    return tag;
  }

  function closestTargetTag(element, tagName) {
    if (!tagName) return element;
    let current = element;
    let steps = 0;
    while (current && steps < 64) {
      if (current.tagName === tagName) return current;
      current = current.parentElement;
      steps++;
    }
    return null;
  }

  function getTargetVisibleRect(element, budget) {
    if (!element || !element.isConnected) return null;
    if (budget.styleChecks >= MAX_TARGET_STYLE_CHECKS) {
      budget.truncated = true;
      return null;
    }
    budget.styleChecks++;
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    ) {
      return null;
    }
    if (budget.layoutChecks >= MAX_TARGET_LAYOUT_CHECKS) {
      budget.truncated = true;
      return null;
    }
    budget.layoutChecks++;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function boundedDiceCoefficient(text, query) {
    if (text.length < 2 || query.length < 2) return text === query ? 1 : 0;
    const counts = new Map();
    for (let index = 0; index < text.length - 1; index++) {
      const pair = text.slice(index, index + 2);
      counts.set(pair, (counts.get(pair) || 0) + 1);
    }
    let intersection = 0;
    for (let index = 0; index < query.length - 1; index++) {
      const pair = query.slice(index, index + 2);
      const count = counts.get(pair) || 0;
      if (count > 0) {
        intersection++;
        counts.set(pair, count - 1);
      }
    }
    return (2 * intersection) / (text.length - 1 + query.length - 1);
  }

  function findElementByTextBounded(text, tagName) {
    try {
      const query = normalizeTargetText(text);
      const normalizedTag = normalizeTargetTag(tagName);
      const budget = createTargetScanBudget();
      let bestElement = null;
      let bestScore = 0;
      for (const node of walkTargetNodesDeep(document, budget)) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const candidateText = truncateUtf8(
          node.nodeValue || '',
          MAX_TARGET_TEXT_BYTES,
        )
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        if (!candidateText) continue;
        const candidate = closestTargetTag(node.parentElement, normalizedTag);
        if (!candidate) continue;
        if (candidateText.includes(query)) {
          if (getTargetVisibleRect(candidate, budget)) {
            return { element: candidate };
          }
          continue;
        }
        const score = boundedDiceCoefficient(candidateText, query);
        if (score > bestScore && getTargetVisibleRect(candidate, budget)) {
          bestElement = candidate;
          bestScore = score;
        }
      }
      if (budget.truncated) {
        return {
          element: null,
          error: 'Text target scan exceeded the bounded page traversal budget',
        };
      }
      return { element: bestScore >= 0.6 ? bestElement : null };
    } catch (error) {
      return {
        element: null,
        error: truncateUtf8(
          error && error.message ? error.message : String(error),
          MAX_TARGET_ERROR_BYTES,
        ),
      };
    }
  }

  function normalizeVariableDefinitions(request) {
    let source = Array.isArray(request.variables) ? request.variables : [];
    if (source.length === 0 && request.payload !== undefined && request.payload !== null) {
      if (typeof request.payload !== 'string') {
        throw new Error('variable payload must be a JSON string');
      }
      if (
        request.payload.length > MAX_VARIABLE_PAYLOAD_BYTES ||
        utf8ByteLength(request.payload, MAX_VARIABLE_PAYLOAD_BYTES) >
          MAX_VARIABLE_PAYLOAD_BYTES
      ) {
        throw new Error(
          `variable payload exceeds the ${MAX_VARIABLE_PAYLOAD_BYTES}-byte UTF-8 limit`,
        );
      }
      const parsed = JSON.parse(request.payload || '{}');
      source = Array.isArray(parsed.variables) ? parsed.variables : [];
    }
    if (source.length > MAX_VARIABLE_COUNT) {
      throw new Error(`variables exceed the ${MAX_VARIABLE_COUNT}-entry limit`);
    }

    const variables = [];
    const keys = new Set();
    let aggregateBytes = 2;
    for (const item of source) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('each variable must be an object');
      }
      const key = normalizeTargetInput(item.key, 'variable key', MAX_VARIABLE_KEY_BYTES);
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`variable key is not allowed: ${key}`);
      }
      if (keys.has(key)) throw new Error(`duplicate variable key: ${key}`);
      keys.add(key);
      const label = truncateUtf8(
        typeof item.label === 'string' ? item.label : key,
        MAX_VARIABLE_LABEL_BYTES,
      );
      const rawDefault =
        typeof item.default === 'string' ||
        typeof item.default === 'number' ||
        typeof item.default === 'boolean'
          ? String(item.default)
          : '';
      const normalized = {
        key,
        label,
        default: truncateUtf8(rawDefault, MAX_VARIABLE_VALUE_BYTES),
        sensitive: item.sensitive === true,
      };
      const bytes = utf8ByteLength(JSON.stringify(normalized));
      if (aggregateBytes + bytes > MAX_VARIABLE_PAYLOAD_BYTES) {
        throw new Error('normalized variables exceed the aggregate byte limit');
      }
      aggregateBytes += bytes;
      variables.push(normalized);
    }
    return variables;
  }

  function putBoundedVariableValue(values, state, key, value) {
    const bounded = truncateUtf8(
      typeof value === 'string' ? value : '',
      MAX_VARIABLE_VALUE_BYTES,
    );
    const bytes = utf8ByteLength(key) + utf8ByteLength(bounded) + 8;
    if (state.bytes + bytes > MAX_VARIABLE_VALUES_BYTES) {
      throw new Error('collected variable values exceed the aggregate byte limit');
    }
    state.bytes += bytes;
    values[key] = bounded;
  }

  /**
   * Whether to include element in tree under config
   * @param {Element} el
   * @param {{filter?: 'all'|'interactive'}} cfg
   */
  function shouldInclude(el, cfg, state) {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'meta', 'link', 'title', 'noscript'].includes(tag))
      return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (!isVisible(el, state)) return false;
    if (cfg.filter !== 'all') {
      // Inactive/background tabs frequently report window.innerWidth/innerHeight
      // as 0 because Chrome does not allocate a layout viewport for hidden tabs.
      // Fall back to the document element's client size (which still reflects
      // intrinsic layout) and, if even that is zero, skip the viewport filter
      // entirely so background tabs still produce a usable accessibility tree.
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if (vw > 0 && vh > 0) {
        if (state && state.layoutChecks >= MAX_LAYOUT_CHECKS) {
          markTreeTruncated(state, 'layout_checks');
          return false;
        }
        if (state) state.layoutChecks++;
        const r = /** @type {HTMLElement} */ (el).getBoundingClientRect();
        if (!(r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0))
          return false;
      }
    }
    if (cfg.filter === 'interactive') return isInteractive(el);
    if (isInteractive(el)) return true;
    if (isStructural(el)) return true;
    if (inferLabel(el, state).length > 0) return true;
    return isFormishContainer(el);
  }

  /**
   * Generate a fairly stable CSS selector
   * @param {Element} el
   * @returns {string}
   */
  function generateSelector(el, state) {
    if (!(el instanceof Element)) return '';
    if (/** @type {HTMLElement} */ (el).id) {
      return truncateUtf8(
        `#${cssEscapeIdentifier(/** @type {HTMLElement} */ (el).id)}`,
        MAX_SELECTOR_BYTES,
      );
    }
    for (const attr of ['data-testid', 'data-cy', 'name']) {
      const attrValue = el.getAttribute(attr);
      if (attrValue) {
        const escaped = truncateUtf8(attrValue, MAX_SELECTOR_BYTES)
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/[\n\r\f]/g, ' ');
        return truncateUtf8(`[${attr}="${escaped}"]`, MAX_SELECTOR_BYTES);
      }
    }
    const parts = [];
    let current = el;
    let depth = 0;
    while (
      current &&
      current.nodeType === Node.ELEMENT_NODE &&
      current.tagName !== 'BODY' &&
      depth < 32
    ) {
      let selector = current.tagName.toLowerCase();
      let sibling = current.previousElementSibling;
      let sameTypeBefore = 0;
      let siblingSteps = 0;
      while (sibling && siblingSteps < MAX_SIBLING_STEPS) {
        if (state && state.selectorSteps >= MAX_SELECTOR_STEPS) {
          markTreeTruncated(state, 'selector_steps');
          sibling = null;
          break;
        }
        if (state) state.selectorSteps++;
        if (sibling.tagName === current.tagName) sameTypeBefore++;
        sibling = sibling.previousElementSibling;
        siblingSteps++;
      }
      if (sibling) markTreeTruncated(state, 'selector_siblings');
      if (sameTypeBefore > 0) selector += `:nth-of-type(${sameTypeBefore + 1})`;
      parts.push(selector);
      current = current.parentElement;
      depth++;
    }
    if (current && current.tagName !== 'BODY') {
      markTreeTruncated(state, 'selector_depth');
    }
    const path = parts.reverse().join(' > ');
    return truncateUtf8(path ? `body > ${path}` : 'body', MAX_SELECTOR_BYTES);
  }

  /**
   * Traverse DOM and build pageContent lines; collect ref map for interactive nodes.
   * @param {Element} el
   * @param {number} depth
   * @param {{filter?: 'all'|'interactive', maxDepth?: number}} cfg
   * @param {string[]} out
   * @param {Array<{ref:string, selector:string, rect:{x:number,y:number,width:number,height:number}}>} refMap
   */
  function traverse(el, depth, domDepth, cfg, out, refMap, state) {
    const maxDepth =
      cfg && typeof cfg.maxDepth === 'number' ? cfg.maxDepth : MAX_DEPTH;
    if (state.stop || depth > maxDepth || !el || !el.tagName) return;
    if (domDepth > MAX_DOM_DEPTH) {
      markTreeTruncated(state, 'dom_depth');
      return;
    }
    if (state.visitedCount >= MAX_VISITED_NODES) {
      markTreeTruncated(state, 'visited_nodes');
      state.stop = true;
      return;
    }
    if (state.visited.has(el)) return;
    state.visited.add(el);
    state.visitedCount++;
    const include = shouldInclude(el, cfg, state) || depth === 0;
    if (include) {
      if (state.included >= MAX_INCLUDED_NODES) {
        markTreeTruncated(state, 'included_nodes');
        state.stop = true;
        return;
      }
      const role = inferRole(el);
      let label = inferLabel(el, state);
      const refId = ensureRef(el);
      if (state.layoutChecks >= MAX_LAYOUT_CHECKS) {
        markTreeTruncated(state, 'layout_checks');
        state.stop = true;
        return;
      }
      state.layoutChecks++;
      const rect = /** @type {HTMLElement} */ (el).getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      let line = `${'  '.repeat(depth)}- ${role}`;
      if (label) {
        label = cleanLineValue(label, MAX_LINE_LABEL * 4).substring(0, MAX_LINE_LABEL);
        line += ` "${label}"`;
      }
      line += ` [ref=${refId}] (x=${cx},y=${cy})`;
      if (/** @type {HTMLElement} */ (el).id)
        line += ` id="${cleanLineValue(/** @type {HTMLElement} */ (el).id)}"`;
      const href = el.getAttribute('href');
      if (href) line += ` href="${cleanLineValue(href)}"`;
      const type = el.getAttribute('type');
      if (type) line += ` type="${cleanLineValue(type)}"`;
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) line += ` placeholder="${cleanLineValue(placeholder)}"`;
      // Surface disabled/pointer-events for better agent judgement
      try {
        const disabled =
          el.hasAttribute('disabled') ||
          el.getAttribute('aria-disabled') === 'true';
        if (disabled) line += ` disabled`;
        if (state.styleChecks < MAX_STYLE_CHECKS) {
          state.styleChecks++;
          const cs = window.getComputedStyle(/** @type {HTMLElement} */ (el));
          if (cs && cs.pointerEvents === 'none') line += ` pe=none`;
        } else {
          markTreeTruncated(state, 'style_checks');
        }
      } catch (_) {
        /* ignore style issues */
      }
      const lineBytes = utf8ByteLength(line);
      const separatorBytes = out.length > 0 ? 1 : 0;
      if (state.outputBytes + separatorBytes + lineBytes > MAX_PAGE_CONTENT_BYTES) {
        markTreeTruncated(state, 'page_content_bytes');
        state.stop = true;
        return;
      }
      out.push(line);
      state.outputBytes += separatorBytes + lineBytes;
      state.included++;

      // Only collect ref mapping for interactive elements to limit cost
      if (isInteractive(el) && refMap.length < REF_MAP_LIMIT) {
        refMap.push({
          ref: /** @type {string} */ (refId),
          selector: generateSelector(el, state),
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        });
      }
    }
    if (state.stop) return;
    // Traverse light DOM children
    if (domDepth < MAX_DOM_DEPTH) {
      let child = /** @type {HTMLElement} */ (el).firstElementChild;
      while (child && !state.stop) {
        const next = child.nextElementSibling;
        traverse(
          child,
          include ? depth + 1 : depth,
          domDepth + 1,
          cfg,
          out,
          refMap,
          state,
        );
        child = next;
      }
    }
    // Traverse shadow DOM roots within the same access budgets.
    try {
      const anyEl = /** @type {any} */ (el);
      if (anyEl && anyEl.shadowRoot && domDepth < MAX_DOM_DEPTH) {
        let child = anyEl.shadowRoot.firstElementChild;
        while (child && !state.stop) {
          const next = child.nextElementSibling;
          traverse(
            child,
            include ? depth + 1 : depth,
            domDepth + 1,
            cfg,
            out,
            refMap,
            state,
          );
          child = next;
        }
      }
    } catch (_) {
      /* ignore shadow errors */
    }
  }

  /**
   * Generate tree and return
   * @param {'all'|'interactive'|null} filter
   * @param {{maxDepth?: number, refId?: string}|undefined} options
   */
  function __generateAccessibilityTree(filter, options) {
    try {
      const start =
        performance && performance.now ? performance.now() : Date.now();
      const out = [];
      const cfg = { filter: filter || undefined };

      // Clamp maxDepth to MAX_DEPTH to keep costs bounded
      if (options && Number.isFinite(options.maxDepth)) {
        const d = Math.max(0, Math.floor(Number(options.maxDepth)));
        cfg.maxDepth = Math.min(d, MAX_DEPTH);
      }

      const refMap = [];
      const state = {
        visitedCount: 0,
        included: 0,
        styleChecks: 0,
        layoutChecks: 0,
        textReads: 0,
        selectorSteps: 0,
        outputBytes: 0,
        stop: false,
        truncated: false,
        truncationReasons: new Set(),
        visited: new WeakSet(),
      };

      // Determine root element (body or refId-specified element)
      let focus = null;
      let root = document.body;
      if (options && options.refId) {
        const refIdStr = truncateUtf8(
          typeof options.refId === 'string' ? options.refId.trim() : '',
          128,
        );
        if (refIdStr) {
          const el = resolveRef(refIdStr);
          if (!el || !(el instanceof Element)) {
            return { error: `ref "${refIdStr}" not found or expired` };
          }
          root = el;
          focus = { refId: refIdStr };
        }
      }

      if (root) traverse(root, 0, 0, cfg, out, refMap, state);
      for (const k in window.__claudeElementMap) {
        if (
          !window.__claudeElementMap[k].deref ||
          !window.__claudeElementMap[k].deref()
        )
          delete window.__claudeElementMap[k];
      }
      const pageContent = out
        .filter((line) => !/^\s*- generic \[ref=ref_\d+\]$/.test(line))
        .join('\n');
      const end =
        performance && performance.now ? performance.now() : Date.now();
      return {
        pageContent,
        focus,
        viewport: {
          // Prefer the live viewport size, but fall back to the document element's
          // intrinsic client size so background/inactive tabs do not report 0x0.
          width: window.innerWidth || document.documentElement.clientWidth || 0,
          height: window.innerHeight || document.documentElement.clientHeight || 0,
          dpr: window.devicePixelRatio || 1,
        },
        stats: {
          processed: state.visitedCount,
          included: state.included,
          durationMs: Math.round(end - start),
          styleChecks: state.styleChecks,
          layoutChecks: state.layoutChecks,
        },
        truncated: state.truncated,
        truncationReasons: Array.from(state.truncationReasons),
        refMap,
      };
    } catch (err) {
      throw new Error(
        'Error generating accessibility tree: ' +
          (err && err.message ? err.message : 'Unknown error'),
      );
    }
  }

  // Expose API on window
  window.__generateAccessibilityTree = __generateAccessibilityTree;

  // ============================================================================
  // Hover for Ref (DOM Fallback Support)
  // ============================================================================

  async function handleHoverForRef(ref) {
    if (!ref) return { success: false, error: 'ref is required' };
    const el = resolveRef(ref);
    if (el) {
      dispatchHoverEvents(el);
      return { success: true, target: summarizeElement(el) };
    }
    return await forwardHoverRefToChildren(ref);
  }

  function resolveRef(ref) {
    const map = window.__claudeElementMap || {};
    const weak = map[ref];
    return weak && typeof weak.deref === 'function' ? weak.deref() : null;
  }

  function dispatchHoverEvents(el) {
    const rect = el.getBoundingClientRect();
    const center = {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
    ['mousemove', 'mouseover', 'mouseenter'].forEach((type) => {
      el.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: center.x,
          clientY: center.y,
          view: window,
        }),
      );
    });
  }

  function summarizeElement(el) {
    return {
      tagName: truncateUtf8(el.tagName || '', 64),
      id: truncateUtf8(el.id || '', MAX_ATTRIBUTE_BYTES),
      className: truncateUtf8(
        typeof el.className === 'string' ? el.className : '',
        MAX_ATTRIBUTE_BYTES,
      ),
      text: collectBoundedText(el, null, MAX_ATTRIBUTE_BYTES),
    };
  }

  function findChildFrameElementForWindow(sourceWindow) {
    const budget = createTargetScanBudget();
    for (const frame of walkTargetNodesDeep(document, budget)) {
      if (
        !(frame instanceof HTMLIFrameElement) &&
        !(frame instanceof HTMLFrameElement)
      ) {
        continue;
      }
      try {
        if (frame.contentWindow === sourceWindow) {
          return frame;
        }
      } catch {}
    }
    return null;
  }

  function collectChildFrames(maximum = 64) {
    const frames = [];
    const budget = createTargetScanBudget();
    for (const frame of walkTargetNodesDeep(document, budget)) {
      if (
        frame instanceof HTMLIFrameElement ||
        frame instanceof HTMLFrameElement
      ) {
        frames.push(frame);
        if (frames.length >= maximum) break;
      }
    }
    return frames;
  }

  function projectPointToTopViewport(point) {
    const normalized = {
      x: Number(point && point.x),
      y: Number(point && point.y),
    };
    if (!Number.isFinite(normalized.x) || !Number.isFinite(normalized.y)) {
      return Promise.reject(new Error('Invalid point for frame projection'));
    }
    if (window === window.top) {
      return Promise.resolve({
        x: Math.round(normalized.x),
        y: Math.round(normalized.y),
      });
    }

    return new Promise((resolve, reject) => {
      const reqId = `rrp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let timeoutHandle = null;

      const cleanup = () => {
        window.removeEventListener('message', listener, true);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      };

      const listener = (ev) => {
        try {
          const data = ev && ev.data;
          if (
            !data ||
            data.type !== 'rr-bridge-project-point-result' ||
            data.reqId !== reqId
          )
            return;
          if (ev.source !== window.parent) return;

          cleanup();
          if (data.success && data.point) {
            resolve({
              x: Math.round(Number(data.point.x)),
              y: Math.round(Number(data.point.y)),
            });
            return;
          }
          reject(
            new Error(data.error || 'Failed to project point to top viewport'),
          );
        } catch (error) {
          cleanup();
          reject(error);
        }
      };

      window.addEventListener('message', listener, true);
      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out while projecting point to top viewport'));
      }, 2000);

      try {
        window.parent.postMessage(
          {
            type: 'rr-bridge-project-point',
            reqId,
            point: normalized,
          },
          '*',
        );
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  function forwardHoverRefToChildren(ref) {
    return new Promise((resolve) => {
      const frames = collectChildFrames();
      if (!frames.length) {
        resolve({ success: false, error: `ref "${ref}" not found` });
        return;
      }
      const reqId = `hover_ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const listener = (ev) => {
        const data = ev?.data;
        if (
          !data ||
          data.type !== 'rr-bridge-hover-ref-result' ||
          data.reqId !== reqId
        )
          return;
        window.removeEventListener('message', listener, true);
        resolve(data.result);
      };
      window.addEventListener('message', listener, true);
      setTimeout(() => {
        window.removeEventListener('message', listener, true);
        resolve({
          success: false,
          error: `ref "${ref}" not found in child frames`,
        });
      }, 1500);
      for (const frame of frames) {
        try {
          frame.contentWindow?.postMessage(
            { type: 'rr-bridge-hover-ref', reqId, ref },
            '*',
          );
        } catch {}
      }
    });
  }

  // Chrome message bridge for ping and tree generation
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    try {
      if (request && request.action === 'chrome_read_page_ping') {
        sendResponse({ status: 'pong' });
        return false;
      }
      if (request && request.action === 'rr_overlay') {
        try {
          const cmd = request.cmd === undefined ? 'init' : request.cmd;
          if (cmd !== 'init' && cmd !== 'append' && cmd !== 'done') {
            throw new Error('overlay command must be init, append, or done');
          }
          let root = document.getElementById('__rr_overlay_root');
          if (!root) {
            root = document.createElement('div');
            root.id = '__rr_overlay_root';
            Object.assign(root.style, {
              position: 'fixed',
              right: '8px',
              bottom: '8px',
              zIndex: 2_147_483_647,
              maxWidth: '40vw',
              maxHeight: '40vh',
              overflow: 'auto',
              background: 'rgba(0,0,0,0.6)',
              color: '#fff',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: '12px',
              padding: '8px',
              borderRadius: '6px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            });
            const title = document.createElement('div');
            title.textContent = 'Record-Replay Run log';
            Object.assign(title.style, {
              fontWeight: 'bold',
              marginBottom: '6px',
            });
            const body = document.createElement('div');
            body.id = '__rr_overlay_body';
            root.appendChild(title);
            root.appendChild(body);
            document.documentElement.appendChild(root);
            window.__rrOverlayState.bytes = 0;
          }
          const body = document.getElementById('__rr_overlay_body');
          if (cmd === 'append' && body) {
            const line = document.createElement('div');
            const text = truncateUtf8(
              typeof request.text === 'string' ? request.text : '',
              MAX_OVERLAY_LINE_BYTES,
            );
            const lineBytes = utf8ByteLength(text);
            line.textContent = text;
            line.dataset.rrBytes = String(lineBytes);
            while (
              body.firstElementChild &&
              (body.childElementCount >= MAX_OVERLAY_LINES ||
                window.__rrOverlayState.bytes + lineBytes > MAX_OVERLAY_TEXT_BYTES)
            ) {
              const first = body.firstElementChild;
              const removedBytes = Number(first.dataset.rrBytes || 0);
              window.__rrOverlayState.bytes = Math.max(
                0,
                window.__rrOverlayState.bytes -
                  (Number.isFinite(removedBytes) ? removedBytes : 0),
              );
              first.remove();
            }
            body.appendChild(line);
            window.__rrOverlayState.bytes += lineBytes;
            body.scrollTop = body.scrollHeight;
          }
          if (cmd === 'done' && root) {
            root.style.opacity = '0.5';
          }
          sendResponse({ success: true });
          return true;
        } catch (e) {
          sendResponse({
            success: false,
            error: truncateUtf8(
              e && e.message ? e.message : String(e),
              MAX_TARGET_ERROR_BYTES,
            ),
          });
          return true;
        }
      }
      // Element picker: start a temporary overlay to let user pick an element
      if (request && request.action === 'rr_picker_start') {
        try {
          if (typeof window.__rrPickerCleanup === 'function') {
            window.__rrPickerCleanup();
          }
          // state
          const state = { active: true };
          let settled = false;
          let cancelPicker = null;
          const hostId = '__rr_picker_host__';
          let host = document.getElementById(hostId);
          if (host) host.remove();
          host = document.createElement('div');
          host.id = hostId;
          Object.assign(host.style, {
            position: 'fixed',
            inset: '0',
            zIndex: 2147483646,
            cursor: 'crosshair',
            background: 'rgba(0,0,0,0.0)',
          });
          const box = document.createElement('div');
          Object.assign(box.style, {
            position: 'fixed',
            border: '2px solid #3b82f6',
            background: 'rgba(59,130,246,0.15)',
            pointerEvents: 'none',
          });
          const tip = document.createElement('div');
          tip.textContent = 'Click to select element (Esc to cancel)';
          Object.assign(tip.style, {
            position: 'fixed',
            top: '10px',
            left: '10px',
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            padding: '6px 10px',
            borderRadius: '6px',
            fontSize: '12px',
            fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,Arial',
          });
          host.appendChild(box);
          host.appendChild(tip);
          document.documentElement.appendChild(host);

          const cleanup = () => {
            try {
              host.remove();
            } catch {}
            try {
              document.removeEventListener('mousemove', onMove, true);
            } catch {}
            try {
              document.removeEventListener('click', onClick, true);
            } catch {}
            try {
              document.removeEventListener('keydown', onKey, true);
            } catch {}
            state.active = false;
            if (window.__rrPickerCleanup === cancelPicker) {
              window.__rrPickerCleanup = null;
            }
          };
          cancelPicker = () => {
            if (settled) return;
            settled = true;
            cleanup();
            sendResponse({ success: false, cancelled: true, reason: 'superseded' });
          };
          window.__rrPickerCleanup = cancelPicker;

          const onMove = (e) => {
            if (!state.active) return;
            const el = e.target instanceof Element ? e.target : null;
            if (!el) return;
            try {
              const r = el.getBoundingClientRect();
              Object.assign(box.style, {
                left: `${Math.round(r.left)}px`,
                top: `${Math.round(r.top)}px`,
                width: `${Math.round(Math.max(0, r.width))}px`,
                height: `${Math.round(Math.max(0, r.height))}px`,
                display: r.width > 0 && r.height > 0 ? 'block' : 'none',
              });
            } catch {}
          };
          const computeCandidates = (el) => {
            const cands = [];
            const seen = new Set();
            const addCandidate = (type, value) => {
              const bounded = truncateUtf8(value, MAX_SELECTOR_BYTES);
              const key = `${type}:${bounded}`;
              if (!bounded || seen.has(key) || cands.length >= 8) return;
              seen.add(key);
              cands.push({ type, value: bounded });
            };
            if (el.id) {
              addCandidate('css', `#${cssEscapeIdentifier(el.id)}`);
            }
            const classes = el.classList;
            for (let index = 0; classes && index < Math.min(classes.length, 3); index++) {
              const className = classes.item(index);
              if (className && /^[a-zA-Z0-9_-]+$/.test(className)) {
                addCandidate('css', `.${cssEscapeIdentifier(className)}`);
              }
            }
            for (const attr of ['data-testid', 'data-cy', 'name']) {
              const val = el.getAttribute(attr);
              if (val) {
                const escaped = truncateUtf8(val, MAX_SELECTOR_BYTES)
                  .replace(/\\/g, '\\\\')
                  .replace(/"/g, '\\"')
                  .replace(/[\n\r\f]/g, ' ');
                addCandidate('attr', `[${attr}="${escaped}"]`);
              }
            }
            const aria = el.getAttribute && el.getAttribute('aria-label');
            if (aria) addCandidate('aria', `textbox[name=${truncateUtf8(aria, 256)}]`);
            const tag = (el.tagName || '').toLowerCase();
            if (['button', 'a', 'summary'].includes(tag)) {
              const text = collectBoundedText(el, null, 256);
              if (text) addCandidate('text', text);
            }
            addCandidate('css', generateSelector(el));
            return cands;
          };
          const onClick = (e) => {
            if (!state.active) return;
            e.preventDefault();
            e.stopPropagation();
            const el = e.target instanceof Element ? e.target : null;
            if (!el) {
              settled = true;
              cleanup();
              sendResponse({ success: false, error: 'no element' });
              return true;
            }
            const refId = ensureRef(el);
            const cands = computeCandidates(el);
            settled = true;
            cleanup();
            sendResponse({ success: true, ref: refId, candidates: cands });
            return true;
          };
          const onKey = (e) => {
            if (e.key === 'Escape') {
              settled = true;
              cleanup();
              sendResponse({ success: false, cancelled: true });
            }
          };
          document.addEventListener('mousemove', onMove, true);
          document.addEventListener('click', onClick, true);
          document.addEventListener('keydown', onKey, true);
          return true; // async
        } catch (e) {
          sendResponse({
            success: false,
            error: String(e && e.message ? e.message : e),
          });
          return true;
        }
      }
      if (request && request.action === 'rr_picker_stop') {
        try {
          if (typeof window.__rrPickerCleanup === 'function') {
            window.__rrPickerCleanup();
          } else {
            const host = document.getElementById('__rr_picker_host__');
            if (host) host.remove();
          }
          sendResponse({ success: true });
          return true;
        } catch (e) {
          sendResponse({
            success: false,
            error: String(e && e.message ? e.message : e),
          });
          return true;
        }
      }
      if (request && request.action === 'generateAccessibilityTree') {
        const result = __generateAccessibilityTree(request.filter || null, {
          maxDepth: request.depth,
          refId: request.refId,
        });
        if (result && result.error) {
          sendResponse({ success: false, error: result.error });
          return true;
        }
        sendResponse({ success: true, ...result });
        return true;
      }
      if (request && request.action === 'ensureRefForSelector') {
        try {
          // Composite selector support: "frameSelector |> innerSelector"
          const maybeSel =
            request.selector === undefined || request.selector === null || request.selector === ''
              ? ''
              : normalizeTargetInput(
                  request.selector,
                  'selector',
                  MAX_TARGET_SELECTOR_BYTES,
                );
          const allowMultiple = !!request.allowMultiple;
          if (maybeSel.includes('|>')) {
            try {
              const parts = maybeSel
                .split('|>')
                .map((s) => s.trim())
                .filter(Boolean);
              if (parts.length > 8) {
                throw new Error('Composite selector exceeds the 8-frame segment limit');
              }
              if (parts.length >= 2) {
                const frameSel = parts[0];
                const innerSel = parts.slice(1).join(' |> ');
                // Find target frame element in current document
                let frameEl = null;
                try {
                  frameEl =
                    querySelectorDeepFirst(frameSel);
                } catch {}
                if (
                  !frameEl ||
                  !(
                    frameEl instanceof HTMLIFrameElement ||
                    frameEl instanceof HTMLFrameElement
                  )
                ) {
                  sendResponse({
                    success: false,
                    error: `Composite frame selector not found: ${frameSel}`,
                  });
                  return true;
                }
                const cw = frameEl.contentWindow;
                if (!cw) {
                  sendResponse({
                    success: false,
                    error: 'Unable to obtain contentWindow of target frame',
                  });
                  return true;
                }
                // Bridge to child frame via postMessage with timeout
                const reqId = `rrc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const BRIDGE_TIMEOUT_MS = 5000; // 5 second timeout for iframe bridge
                let responded = false;
                let timeoutHandle = null;

                const cleanup = () => {
                  window.removeEventListener('message', listener, true);
                  if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                  }
                };

                const listener = (ev) => {
                  try {
                    const data = ev && ev.data;
                    if (
                      !data ||
                      data.type !== 'rr-bridge-ensure-ref-result' ||
                      data.reqId !== reqId
                    )
                      return;
                    // Validate source is the expected frame (security check)
                    if (ev.source !== cw) return;

                    if (responded) return; // Already timed out
                    responded = true;
                    cleanup();

                    if (data.success) {
                      const childRef = normalizeTargetInput(data.ref, 'ref', 128);
                      const center = {
                        x: Number.isFinite(Number(data.center && data.center.x))
                          ? Number(data.center.x)
                          : 0,
                        y: Number.isFinite(Number(data.center && data.center.y))
                          ? Number(data.center.y)
                          : 0,
                      };
                      sendResponse({
                        success: true,
                        ref: childRef,
                        center,
                        href: truncateUtf8(
                          typeof data.href === 'string' ? data.href : '',
                          16 * 1024,
                        ),
                      });
                    } else {
                      sendResponse({
                        success: false,
                        error: truncateUtf8(
                          typeof data.error === 'string' ? data.error : 'child failed',
                          MAX_TARGET_ERROR_BYTES,
                        ),
                      });
                    }
                  } catch (e) {
                    if (!responded) {
                      responded = true;
                      cleanup();
                      sendResponse({
                        success: false,
                        error: truncateUtf8(
                          e && e.message ? e.message : String(e),
                          MAX_TARGET_ERROR_BYTES,
                        ),
                      });
                    }
                  }
                };

                // Set up timeout to prevent infinite wait
                timeoutHandle = setTimeout(() => {
                  if (!responded) {
                    responded = true;
                    cleanup();
                    sendResponse({
                      success: false,
                      error: `iframe bridge timeout after ${BRIDGE_TIMEOUT_MS}ms`,
                    });
                  }
                }, BRIDGE_TIMEOUT_MS);

                window.addEventListener('message', listener, true);
                cw.postMessage(
                  {
                    type: 'rr-bridge-ensure-ref',
                    reqId,
                    selector: innerSel,
                    useText: !!request.useText,
                    isXPath: !!request.isXPath,
                    tagName: normalizeTargetTag(request.tagName),
                    allowMultiple: !!request.allowMultiple,
                  },
                  '*',
                );
                return true; // async response via message bridge
              }
            } catch (e) {
              sendResponse({
                success: false,
                error: truncateUtf8(
                  e && e.message ? e.message : String(e),
                  MAX_TARGET_ERROR_BYTES,
                ),
              });
              return true;
            }
          }
          // Support CSS selector, XPath, or visible text search
          const useText = !!request.useText;
          const textQuery =
            request.text === undefined || request.text === null || request.text === ''
              ? ''
              : normalizeTargetInput(request.text, 'text', MAX_TARGET_TEXT_BYTES);
          const sel = maybeSel;
          const isXPath = !!request.isXPath;
          const limitTag = normalizeTargetTag(request.tagName);
          let el = null;
          if (useText && textQuery) {
            const textResult = findElementByTextBounded(textQuery, limitTag);
            if (textResult.error) {
              sendResponse({ success: false, error: textResult.error });
              return true;
            }
            el = textResult.element;
          } else if (isXPath) {
            if (!sel) {
              sendResponse({ success: false, error: 'selector is required' });
              return true;
            }
            const result = queryXPathWithUniquenessCheck(sel, allowMultiple);
            if (result.error) {
              sendResponse({ success: false, error: result.error });
              return true;
            }
            if (result.matchCount === 0) {
              sendResponse({
                success: false,
                error: `selector not found: ${sel}`,
              });
              return true;
            }
            if (!allowMultiple && result.matchCount > 1) {
              sendResponse({
                success: false,
                error: `Selector "${sel}" matched multiple elements. Please refine the selector to match only one element.`,
              });
              return true;
            }
            el = result.element;
          } else {
            if (!sel) {
              sendResponse({ success: false, error: 'selector is required' });
              return true;
            }
            const result = querySelectorWithUniquenessCheck(sel, allowMultiple);
            if (result.error) {
              sendResponse({ success: false, error: result.error });
              return true;
            }
            if (result.matchCount === 0) {
              sendResponse({
                success: false,
                error: `selector not found: ${sel}`,
              });
              return true;
            }
            if (!allowMultiple && result.matchCount > 1) {
              sendResponse({
                success: false,
                error: `Selector "${sel}" matched multiple elements. Please refine the selector to match only one element.`,
              });
              return true;
            }
            el = result.element;
          }
          if (!el) {
            sendResponse({
              success: false,
              error: `selector not found: ${sel}`,
            });
            return true;
          }
          const refId = ensureRef(el);
          const rect = /** @type {HTMLElement} */ (el).getBoundingClientRect();
          sendResponse({
            success: true,
            ref: refId,
            center: {
              x: Number.isFinite(rect.left + rect.width / 2)
                ? Math.round(rect.left + rect.width / 2)
                : 0,
              y: Number.isFinite(rect.top + rect.height / 2)
                ? Math.round(rect.top + rect.height / 2)
                : 0,
            },
          });
          return true;
        } catch (e) {
          sendResponse({
            success: false,
            error: truncateUtf8(
              e && e.message ? e.message : String(e),
              MAX_TARGET_ERROR_BYTES,
            ),
          });
          return true;
        }
      }
      if (request && request.action === 'dispatchHoverForRef') {
        const ref = normalizeTargetInput(request.ref, 'ref', 128);
        handleHoverForRef(ref)
          .then((result) => sendResponse(result))
          .catch((error) =>
            sendResponse({
              success: false,
              error: truncateUtf8(
                error?.message || String(error),
                MAX_TARGET_ERROR_BYTES,
              ),
            }),
          );
        return true;
      }
      if (request && request.action === 'getAttributeForSelector') {
        try {
          const sel = validateCssTargetSelector(request.selector);
          const name = normalizeTargetInput(request.name, 'name', 128);
          if (
            name !== 'text' &&
            name !== 'textContent' &&
            name !== 'value' &&
            !/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(name)
          ) {
            throw new Error('attribute name is invalid');
          }
          const result = querySelectorWithUniquenessCheck(sel, true);
          if (result.error) throw new Error(result.error);
          const el = result.element;
          if (!el) {
            sendResponse({
              success: false,
              error: `selector not found: ${sel}`,
            });
            return true;
          }
          let value = null;
          if (name === 'text' || name === 'textContent') {
            value = collectBoundedText(el, null, 64 * 1024);
          } else if (name === 'value') {
            try {
              value = truncateUtf8(
                /** @type {HTMLInputElement} */ (el).value ?? '',
                64 * 1024,
              );
            } catch (_) {
              value = truncateUtf8(el.getAttribute('value') || '', 64 * 1024);
            }
          } else {
            const attribute = el.getAttribute(name);
            value = attribute === null ? null : truncateUtf8(attribute, 64 * 1024);
          }
          sendResponse({ success: true, value });
          return true;
        } catch (e) {
          sendResponse({
            success: false,
            error: truncateUtf8(
              e && e.message ? e.message : String(e),
              MAX_TARGET_ERROR_BYTES,
            ),
          });
          return true;
        }
      }
      if (request && request.action === 'collectVariables') {
        try {
          const vars = normalizeVariableDefinitions(request);
          const useOverlay = request.useOverlay !== false; // default true
          const values = Object.create(null);
          const valueState = { bytes: 2 };
          if (!useOverlay) {
            for (const v of vars) {
              const promptText = truncateUtf8(
                `Please enter parameters ${v.label} (${v.key})`,
                MAX_VARIABLE_LABEL_BYTES + MAX_VARIABLE_KEY_BYTES + 32,
              );
              let val = window.prompt(promptText, v.default);
              if (typeof val !== 'string') val = v.default;
              putBoundedVariableValue(values, valueState, v.key, val);
            }
            sendResponse({ success: true, values });
            return true;
          }
          // Build overlay form
          const hostId = '__rr_var_overlay__';
          let host = document.getElementById(hostId);
          if (host) host.remove();
          host = document.createElement('div');
          host.id = hostId;
          Object.assign(host.style, {
            position: 'fixed',
            inset: '0',
            background: 'rgba(0,0,0,0.35)',
            zIndex: 2147483646,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          });
          const panel = document.createElement('div');
          Object.assign(panel.style, {
            background: '#fff',
            borderRadius: '8px',
            width: 'min(520px, 96vw)',
            maxHeight: '80vh',
            overflow: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            padding: '16px',
            fontFamily:
              'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
          });
          const title = document.createElement('div');
          title.textContent = 'Please enter playback parameters';
          Object.assign(title.style, {
            fontSize: '16px',
            fontWeight: '600',
            marginBottom: '12px',
          });
          const form = document.createElement('form');
          const inputs = new Map();
          for (const v of vars) {
            const row = document.createElement('div');
            Object.assign(row.style, { marginBottom: '10px' });
            const label = document.createElement('label');
            label.textContent = `${v.label}${v.sensitive ? ' (Sensitive)' : ''}`;
            Object.assign(label.style, {
              display: 'block',
              marginBottom: '6px',
              fontWeight: '500',
            });
            const input = document.createElement('input');
            input.type = v.sensitive ? 'password' : 'text';
            input.name = v.key;
            input.value = v.default;
            input.maxLength = MAX_VARIABLE_VALUE_BYTES;
            Object.assign(input.style, {
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 10px',
              border: '1px solid #d0d7de',
              borderRadius: '6px',
              outline: 'none',
            });
            row.appendChild(label);
            row.appendChild(input);
            form.appendChild(row);
            inputs.set(v.key, input);
          }
          const actions = document.createElement('div');
          Object.assign(actions.style, {
            display: 'flex',
            gap: '8px',
            marginTop: '12px',
          });
          const ok = document.createElement('button');
          ok.type = 'submit';
          ok.textContent = 'OK';
          Object.assign(ok.style, {
            background: '#0969da',
            color: '#fff',
            border: 'none',
            padding: '8px 16px',
            borderRadius: '6px',
            cursor: 'pointer',
          });
          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.textContent = 'Cancel';
          Object.assign(cancel.style, {
            background: '#f3f4f6',
            color: '#111',
            border: '1px solid #d0d7de',
            padding: '8px 16px',
            borderRadius: '6px',
            cursor: 'pointer',
          });
          actions.appendChild(ok);
          actions.appendChild(cancel);
          panel.appendChild(title);
          panel.appendChild(form);
          panel.appendChild(actions);
          host.appendChild(panel);
          document.documentElement.appendChild(host);

          const cleanup = () => {
            try {
              host.remove();
            } catch {}
          };
          cancel.onclick = () => {
            cleanup();
            sendResponse({ success: false, cancelled: true });
          };
          form.onsubmit = (e) => {
            try {
              e.preventDefault();
              for (const v of vars) {
                const input = inputs.get(v.key);
                if (input) {
                  putBoundedVariableValue(values, valueState, v.key, input.value);
                }
              }
              cleanup();
              sendResponse({ success: true, values });
            } catch (error) {
              cleanup();
              sendResponse({
                success: false,
                error: truncateUtf8(
                  error && error.message ? error.message : String(error),
                  MAX_TARGET_ERROR_BYTES,
                ),
              });
            }
          };
          return true; // async
        } catch (e) {
          sendResponse({
            success: false,
            error: truncateUtf8(
              e && e.message ? e.message : String(e),
              MAX_TARGET_ERROR_BYTES,
            ),
          });
          return true;
        }
      }
      if (request && request.action === 'resolveRef') {
        try {
          const ref = normalizeTargetInput(request.ref, 'ref', 128);
          const map = window.__claudeElementMap;
          const weak = map && map[ref];
          const el =
            weak && typeof weak.deref === 'function' ? weak.deref() : null;
          if (!el || !(el instanceof Element)) {
            sendResponse({
              success: false,
              error: `ref "${ref}" not found or expired`,
            });
            return true;
          }
          const rect = /** @type {HTMLElement} */ (el).getBoundingClientRect();
          const center = {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
          const selector = generateSelector(el);

          projectPointToTopViewport(center)
            .then((viewportCenter) => {
              sendResponse({
                success: true,
                rect: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
                center,
                viewportCenter,
                selector,
              });
            })
            .catch((error) => {
              sendResponse({
                success: true,
                rect: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
                center,
                selector,
                projectionError: truncateUtf8(
                  error && error.message ? error.message : String(error),
                  MAX_TARGET_ERROR_BYTES,
                ),
              });
            });
          return true;
        } catch (e) {
          sendResponse({
            success: false,
            error: truncateUtf8(
              e && e.message ? e.message : String(e),
              MAX_TARGET_ERROR_BYTES,
            ),
          });
          return true;
        }
      }
      if (request && request.action === 'verifyFingerprint') {
        try {
          const ref = normalizeTargetInput(request.ref, 'ref', 128);
          const fingerprint = normalizeTargetInput(
            request.fingerprint,
            'fingerprint',
            4 * 1024,
          );
          const map = window.__claudeElementMap;
          const weak = map && map[ref];
          const el =
            weak && typeof weak.deref === 'function' ? weak.deref() : null;
          if (!el || !(el instanceof Element)) {
            sendResponse({
              success: false,
              error: `ref "${ref}" not found or expired`,
            });
            return true;
          }
          // Verify fingerprint: parse the stored fingerprint and compare it with the current element
          const parts = fingerprint.split('|');
          const storedTag = parts[0] || 'unknown';
          const currentTag = el.tagName
            ? String(el.tagName).toLowerCase()
            : 'unknown';
          // Tag must match
          if (storedTag !== currentTag) {
            sendResponse({ success: true, match: false });
            return true;
          }
          // If stored fingerprint has id, current element must have the same id
          const storedIdPart = parts.find((p) => p.startsWith('id='));
          if (storedIdPart) {
            const storedId = storedIdPart.slice(3);
            const currentId = truncateUtf8(el.id ? String(el.id).trim() : '', 4 * 1024);
            if (storedId !== currentId) {
              sendResponse({ success: true, match: false });
              return true;
            }
          }
          sendResponse({ success: true, match: true });
          return true;
        } catch (e) {
          sendResponse({
            success: false,
            error: truncateUtf8(
              e && e.message ? e.message : String(e),
              MAX_TARGET_ERROR_BYTES,
            ),
          });
          return true;
        }
      }
      if (request && request.action === 'focusByRef') {
        try {
          const ref = normalizeTargetInput(request.ref, 'ref', 128);
          const map = window.__claudeElementMap || {};
          const weak = map[ref];
          const el =
            weak && typeof weak.deref === 'function' ? weak.deref() : null;
          if (!el || !(el instanceof Element)) {
            sendResponse({
              success: false,
              error: `ref "${ref}" not found or expired`,
            });
            return true;
          }
          try {
            /** @type {HTMLElement} */ (el).scrollIntoView({
              behavior: 'instant',
              block: 'center',
              inline: 'nearest',
            });
          } catch {}
          try {
            /** @type {HTMLElement} */ (el).focus &&
              /** @type {HTMLElement} */ (el).focus();
          } catch {}
          sendResponse({ success: true });
          return true;
        } catch (e) {
          sendResponse({
            success: false,
            error: truncateUtf8(
              e && e.message ? e.message : String(e),
              MAX_TARGET_ERROR_BYTES,
            ),
          });
          return true;
        }
      }
    } catch (e) {
      sendResponse({
        success: false,
        error: truncateUtf8(
          e && e.message ? e.message : String(e),
          MAX_TARGET_ERROR_BYTES,
        ),
      });
      return true;
    }
    return false;
  });

  console.log('Accessibility tree helper script loaded');
  // Cross-frame bridge: child listens for ensure-ref requests from parent (composite selector)
  try {
    window.addEventListener(
      'message',
      (ev) => {
        try {
          const data = ev && ev.data;
          // Handle hover-ref bridge requests from parent frame
          if (data && data.type === 'rr-bridge-hover-ref') {
            const reqId = normalizeTargetInput(data.reqId, 'reqId', 128);
            const ref = normalizeTargetInput(data.ref, 'ref', 128);
            handleHoverForRef(ref)
              .then((result) => {
                ev.source?.postMessage(
                  {
                    type: 'rr-bridge-hover-ref-result',
                    reqId,
                    result,
                  },
                  '*',
                );
              })
              .catch((error) => {
                ev.source?.postMessage(
                  {
                    type: 'rr-bridge-hover-ref-result',
                    reqId,
                    result: {
                      success: false,
                      error: truncateUtf8(
                        error?.message || String(error),
                        MAX_TARGET_ERROR_BYTES,
                      ),
                    },
                  },
                  '*',
                );
              });
            return;
          }
          if (data && data.type === 'rr-bridge-project-point') {
            const { reqId } = data || {};
            const respond = (payload) => {
              try {
                ev.source?.postMessage(
                  { type: 'rr-bridge-project-point-result', reqId, ...payload },
                  '*',
                );
              } catch {}
            };

            try {
              const point = {
                x: Number(data.point && data.point.x),
                y: Number(data.point && data.point.y),
              };
              if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
                respond({
                  success: false,
                  error: 'Invalid point for frame projection',
                });
                return;
              }

              const frameEl = findChildFrameElementForWindow(ev.source);
              if (!frameEl) {
                respond({
                  success: false,
                  error: 'Unable to locate child frame element',
                });
                return;
              }

              const frameRect = frameEl.getBoundingClientRect();
              const translatedPoint = {
                x: point.x + frameRect.left,
                y: point.y + frameRect.top,
              };

              projectPointToTopViewport(translatedPoint)
                .then((projected) => {
                  respond({ success: true, point: projected });
                })
                .catch((error) => {
                  respond({
                    success: false,
                    error: truncateUtf8(
                      error && error.message ? error.message : String(error),
                      MAX_TARGET_ERROR_BYTES,
                    ),
                  });
                });
            } catch (error) {
              respond({
                success: false,
                error: truncateUtf8(
                  error && error.message ? error.message : String(error),
                  MAX_TARGET_ERROR_BYTES,
                ),
              });
            }
            return;
          }
          if (!data || data.type !== 'rr-bridge-ensure-ref') return;
          const { selector, useText, isXPath, tagName } = data || {};
          const reqId = normalizeTargetInput(data.reqId, 'reqId', 128);
          const respond = (payload) => {
            try {
              ev.source &&
                ev.source.postMessage(
                  { type: 'rr-bridge-ensure-ref-result', reqId, ...payload },
                  '*',
                );
            } catch {}
          };
          try {
            const sel = normalizeTargetInput(
              selector,
              useText ? 'text' : 'selector',
              useText ? MAX_TARGET_TEXT_BYTES : MAX_TARGET_SELECTOR_BYTES,
            );
            const limitTag = normalizeTargetTag(tagName);
            let el = null;
            if (useText && sel) {
              const textResult = findElementByTextBounded(sel, limitTag);
              if (textResult.error) {
                respond({ success: false, error: textResult.error });
                return;
              }
              el = textResult.element;
            } else if (isXPath) {
              if (!sel) {
                respond({ success: false, error: 'selector is required' });
                return;
              }
              const allowMultiple = !!data.allowMultiple;
              const result = queryXPathWithUniquenessCheck(sel, allowMultiple);
              if (result.error) {
                respond({ success: false, error: result.error });
                return;
              }
              if (result.matchCount === 0) {
                respond({
                  success: false,
                  error: `Selector "${sel}" not found in child frame`,
                });
                return;
              }
              if (!allowMultiple && result.matchCount > 1) {
                respond({
                  success: false,
                  error: `Selector "${sel}" matched multiple elements inside frame. Please refine the selector to match only one element.`,
                });
                return;
              }
              el = result.element;
            } else {
              if (!sel) {
                respond({ success: false, error: 'selector is required' });
                return;
              }
              const allowMultiple = !!data.allowMultiple;
              const result = querySelectorWithUniquenessCheck(
                sel,
                allowMultiple,
              );
              if (result.error) {
                respond({ success: false, error: result.error });
                return;
              }
              if (result.matchCount === 0) {
                respond({
                  success: false,
                  error: `Selector "${sel}" not found in child frame`,
                });
                return;
              }
              if (!allowMultiple && result.matchCount > 1) {
                respond({
                  success: false,
                  error: `Selector "${sel}" matched multiple elements inside frame. Please refine the selector to match only one element.`,
                });
                return;
              }
              el = result.element;
            }
            if (!el || !(el instanceof Element)) {
              respond({
                success: false,
                error: 'Element not found in child frame',
              });
              return;
            }
            const refId = ensureRef(el);
            const rect = el.getBoundingClientRect();
            respond({
              success: true,
              ref: refId,
              center: {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
              },
              href: truncateUtf8(
                location && location.href ? location.href : '',
                16 * 1024,
              ),
            });
          } catch (e) {
            respond({
              success: false,
              error: truncateUtf8(
                e && e.message ? e.message : String(e),
                MAX_TARGET_ERROR_BYTES,
              ),
            });
          }
        } catch {}
      },
      true,
    );
  } catch {}
})();
