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

  // Keep a weak map from ref id to elements
  if (!window.__claudeElementMap) window.__claudeElementMap = {};
  if (!window.__claudeRefCounter) window.__claudeRefCounter = 0;
  if (!window.__claudeElementRefs) window.__claudeElementRefs = new WeakMap();
  if (!window.__claudeRefOrder) window.__claudeRefOrder = [];

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

  // Utility: query CSS across open shadow roots (best-effort)
  function querySelectorDeepFirst(selector) {
    try {
      // Fast path
      const direct = document.querySelector(selector);
      if (direct) return direct;
    } catch (_) {}
    const visited = new Set();
    const stack = [document.documentElement];
    while (stack.length) {
      const node = stack.pop();
      if (!node || visited.has(node)) continue;
      visited.add(node);
      try {
        const root =
          /** @type {any} */ (node).shadowRoot ||
          (node.nodeType === 9 ? node : null);
        if (root) {
          try {
            const hit = root.querySelector(selector);
            if (hit) return hit;
          } catch (_) {}
        }
      } catch (_) {}
      // Traverse DOM and shadow roots
      try {
        const children = /** @type {Element} */ (node).children || [];
        for (let i = 0; i < children.length; i++) stack.push(children[i]);
        const sr = /** @type {any} */ (node).shadowRoot;
        if (sr && sr.children) {
          for (let i = 0; i < sr.children.length; i++)
            stack.push(sr.children[i]);
        }
      } catch (_) {}
    }
    return null;
  }

  /**
   * Query CSS selector and return match info including uniqueness check.
   * @param {string} selector - CSS selector to query
   * @param {boolean} allowMultiple - If true, skip uniqueness check and return first match
   * @returns {{element: Element | null, matchCount: number, error?: string}}
   * Note: matchCount is capped at 2 (where 2 means "2 or more") for performance
   */
  function querySelectorWithUniquenessCheck(selector, allowMultiple = false) {
    const seen = new Set();
    let firstMatch = null;
    let matchCount = 0;

    const recordMatch = (el) => {
      if (!(el instanceof Element) || seen.has(el)) return false;
      seen.add(el);
      matchCount++;
      if (!firstMatch) firstMatch = el;
      // Short-circuit if:
      // - allowMultiple is true and we found first match (no need to continue)
      // - allowMultiple is false and we found multiple matches
      if (allowMultiple && firstMatch) return true;
      if (!allowMultiple && matchCount >= 2) return true;
      return false;
    };

    // Query in main document
    let selectorError = null;
    try {
      const directMatches = document.querySelectorAll(selector);
      for (let i = 0; i < directMatches.length; i++) {
        if (recordMatch(directMatches[i])) {
          // Early exit: either found first match (allowMultiple) or found multiple (not allowed)
          return { element: firstMatch, matchCount: allowMultiple ? 1 : 2 };
        }
      }
    } catch (e) {
      selectorError = e;
    }

    if (selectorError) {
      return {
        element: null,
        matchCount: 0,
        error: `Invalid CSS selector "${selector}": ${selectorError.message || selectorError}`,
      };
    }

    // If allowMultiple and we already have a match, return immediately
    if (allowMultiple && firstMatch) {
      return { element: firstMatch, matchCount: 1 };
    }

    // Query in shadow DOMs
    const visited = new Set();
    const stack = [document.documentElement];
    while (stack.length) {
      const node = stack.pop();
      if (!node || visited.has(node)) continue;
      visited.add(node);

      try {
        const shadowRoot = /** @type {any} */ (node).shadowRoot;
        if (shadowRoot) {
          try {
            const shadowMatches = shadowRoot.querySelectorAll(selector);
            for (let i = 0; i < shadowMatches.length; i++) {
              if (recordMatch(shadowMatches[i])) {
                // Early exit: either found first match (allowMultiple) or found multiple (not allowed)
                return {
                  element: firstMatch,
                  matchCount: allowMultiple ? 1 : 2,
                };
              }
            }
          } catch (e) {
            return {
              element: null,
              matchCount: 0,
              error: `Invalid CSS selector "${selector}": ${e.message || e}`,
            };
          }

          // Add shadow root children to stack
          try {
            const shadowChildren = shadowRoot.children || [];
            for (let i = 0; i < shadowChildren.length; i++) {
              stack.push(shadowChildren[i]);
            }
          } catch (_) {}
        }
      } catch (_) {}

      // Add regular children to stack
      try {
        const children = /** @type {Element} */ (node).children || [];
        for (let i = 0; i < children.length; i++) {
          stack.push(children[i]);
        }
      } catch (_) {}
    }

    return { element: firstMatch, matchCount: Math.min(matchCount, 2) };
  }

  /**
   * Query XPath selector and return match info including uniqueness check.
   * @param {string} selector - XPath selector to query
   * @param {boolean} allowMultiple - If true, skip uniqueness check and return first match
   * @returns {{element: Element | null, matchCount: number, error?: string}}
   * Note: matchCount is capped at 2 (where 2 means "2 or more") for performance
   */
  function queryXPathWithUniquenessCheck(selector, allowMultiple = false) {
    if (!selector) {
      return { element: null, matchCount: 0 };
    }

    try {
      if (allowMultiple) {
        // When multiple matches are allowed, use ANY_UNORDERED_NODE_TYPE for performance
        // This returns just the first match without evaluating the entire result set
        const result = document.evaluate(
          selector,
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
        // When uniqueness is required, use ORDERED_NODE_SNAPSHOT_TYPE to count matches
        const snapshot = document.evaluate(
          selector,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        const totalMatches = snapshot.snapshotLength;
        // Cap at 2 for performance (2 means "2 or more")
        const matchCount = Math.min(totalMatches, 2);
        const firstMatch =
          totalMatches > 0 && snapshot.snapshotItem(0) instanceof Element
            ? /** @type {Element} */ (snapshot.snapshotItem(0))
            : null;
        return { element: firstMatch, matchCount };
      }
    } catch (e) {
      return {
        element: null,
        matchCount: 0,
        error: `Invalid XPath "${selector}": ${e.message || e}`,
      };
    }
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
    if (/** @type {HTMLElement} */ (el).children && domDepth < MAX_DOM_DEPTH) {
      const children = /** @type {HTMLElement} */ (el).children;
      for (let i = 0; i < children.length; i++) {
        if (state.stop) break;
        traverse(
          children[i],
          include ? depth + 1 : depth,
          domDepth + 1,
          cfg,
          out,
          refMap,
          state,
        );
      }
    }
    // Traverse shadow DOM roots within the same access budgets.
    try {
      const anyEl = /** @type {any} */ (el);
      if (anyEl && anyEl.shadowRoot && domDepth < MAX_DOM_DEPTH) {
        const srChildren = anyEl.shadowRoot.children || [];
        for (let i = 0; i < srChildren.length; i++) {
          if (state.stop) break;
          traverse(
            srChildren[i],
            include ? depth + 1 : depth,
            domDepth + 1,
            cfg,
            out,
            refMap,
            state,
          );
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
      tagName: el.tagName,
      id: el.id || '',
      className: el.className || '',
      text: (el.textContent || '').trim().slice(0, 100),
    };
  }

  function findChildFrameElementForWindow(sourceWindow) {
    const frames = Array.from(document.querySelectorAll('iframe, frame'));
    for (const frame of frames) {
      try {
        if (frame.contentWindow === sourceWindow) {
          return frame;
        }
      } catch {}
    }
    return null;
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
      const frames = Array.from(document.querySelectorAll('iframe, frame'));
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
          const cmd = request.cmd || 'init';
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
          }
          const body = document.getElementById('__rr_overlay_body');
          if (cmd === 'append' && body) {
            const line = document.createElement('div');
            line.textContent = String(request.text || '');
            body.appendChild(line);
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
            error: String(e && e.message ? e.message : e),
          });
          return true;
        }
      }
      // Element picker: start a temporary overlay to let user pick an element
      if (request && request.action === 'rr_picker_start') {
        try {
          // state
          const state = { active: true };
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
          };

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
          const uniqueClassSelector = (node) => {
            try {
              const classes = Array.from(node.classList || []).filter(
                (c) => c && /^[a-zA-Z0-9_-]+$/.test(c),
              );
              for (const cls of classes) {
                const sel = `.${CSS.escape(cls)}`;
                if (document.querySelectorAll(sel).length === 1) return sel;
              }
              const tag = node.tagName ? node.tagName.toLowerCase() : '';
              for (const cls of classes) {
                const sel = `${tag}.${CSS.escape(cls)}`;
                if (document.querySelectorAll(sel).length === 1) return sel;
              }
              for (let i = 0; i < Math.min(classes.length, 3); i++) {
                for (let j = i + 1; j < Math.min(classes.length, 3); j++) {
                  const sel = `.${CSS.escape(classes[i])}.${CSS.escape(classes[j])}`;
                  if (document.querySelectorAll(sel).length === 1) return sel;
                }
              }
            } catch {}
            return '';
          };
          const computeCandidates = (el) => {
            const cands = [];
            // css by id / class / short path
            if (el.id) {
              const idSel = `#${CSS.escape(el.id)}`;
              if (document.querySelectorAll(idSel).length === 1)
                cands.push({ type: 'css', value: idSel });
            }
            const classSel = uniqueClassSelector(el);
            if (classSel) cands.push({ type: 'css', value: classSel });
            // data-* and name
            for (const attr of ['data-testid', 'data-cy', 'name']) {
              const val = el.getAttribute(attr);
              if (val) {
                const s = `[${attr}="${CSS.escape(val)}"]`;
                if (document.querySelectorAll(s).length === 1)
                  cands.push({ type: 'attr', value: s });
              }
            }
            // aria
            const aria = el.getAttribute && el.getAttribute('aria-label');
            if (aria)
              cands.push({ type: 'aria', value: `textbox[name=${aria}]` });
            // text for clickable
            const tag = (el.tagName || '').toLowerCase();
            if (['button', 'a', 'summary'].includes(tag)) {
              const text = (el.textContent || '').trim();
              if (text)
                cands.push({ type: 'text', value: text.substring(0, 64) });
            }
            // fallback path selector
            const gen = (node) => {
              if (!(node instanceof Element)) return '';
              let path = '';
              let current = node;
              while (
                current &&
                current.nodeType === Node.ELEMENT_NODE &&
                current.tagName !== 'BODY'
              ) {
                let sel = current.tagName.toLowerCase();
                const parent = current.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.children).filter(
                    (child) => child.tagName === current.tagName,
                  );
                  if (siblings.length > 1) {
                    const index = siblings.indexOf(current) + 1;
                    sel += `:nth-of-type(${index})`;
                  }
                }
                path = path ? `${sel} > ${path}` : sel;
                current = parent;
              }
              return path ? `body > ${path}` : 'body';
            };
            const pathSel = gen(el);
            if (pathSel) cands.push({ type: 'css', value: pathSel });
            return cands;
          };
          const onClick = (e) => {
            if (!state.active) return;
            e.preventDefault();
            e.stopPropagation();
            const el = e.target instanceof Element ? e.target : null;
            if (!el) {
              cleanup();
              sendResponse({ success: false, error: 'no element' });
              return true;
            }
            // create ref
            try {
              if (!window.__claudeElementMap) window.__claudeElementMap = {};
              if (!window.__claudeRefCounter) window.__claudeRefCounter = 0;
            } catch {}
            let refId = null;
            try {
              for (const k in window.__claudeElementMap) {
                if (
                  window.__claudeElementMap[k].deref &&
                  window.__claudeElementMap[k].deref() === el
                ) {
                  refId = k;
                  break;
                }
              }
              if (!refId) {
                refId = `ref_${++window.__claudeRefCounter}`;
                window.__claudeElementMap[refId] = new WeakRef(el);
              }
            } catch {}
            const cands = computeCandidates(el);
            cleanup();
            sendResponse({ success: true, ref: refId, candidates: cands });
            return true;
          };
          const onKey = (e) => {
            if (e.key === 'Escape') {
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
          const host = document.getElementById('__rr_picker_host__');
          if (host) host.remove();
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
          const maybeSel = String(request.selector || '').trim();
          const allowMultiple = !!request.allowMultiple;
          if (maybeSel.includes('|>')) {
            try {
              const parts = maybeSel
                .split('|>')
                .map((s) => s.trim())
                .filter(Boolean);
              if (parts.length >= 2) {
                const frameSel = parts[0];
                const innerSel = parts.slice(1).join(' |> ');
                // Find target frame element in current document
                let frameEl = null;
                try {
                  frameEl =
                    querySelectorDeepFirst(frameSel) ||
                    document.querySelector(frameSel);
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
                      sendResponse({
                        success: true,
                        ref: data.ref,
                        center: data.center,
                        href: data.href,
                      });
                    } else {
                      sendResponse({
                        success: false,
                        error: data.error || 'child failed',
                      });
                    }
                  } catch (e) {
                    if (!responded) {
                      responded = true;
                      cleanup();
                      sendResponse({
                        success: false,
                        error: String(e && e.message ? e.message : e),
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
                    tagName: String(request.tagName || ''),
                    allowMultiple: !!request.allowMultiple,
                  },
                  '*',
                );
                return true; // async response via message bridge
              }
            } catch (e) {
              sendResponse({
                success: false,
                error: String(e && e.message ? e.message : e),
              });
              return true;
            }
          }
          // Support CSS selector, XPath, or visible text search
          const useText = !!request.useText;
          const textQuery = String(request.text || '').trim();
          const sel = String(request.selector || '').trim();
          const isXPath = !!request.isXPath;
          const limitTag = String(request.tagName || '')
            .trim()
            .toUpperCase();
          let el = null;
          if (useText && textQuery) {
            const normalize = (s) =>
              String(s || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
            const query = normalize(textQuery);
            const bigrams = (s) => {
              const arr = [];
              for (let i = 0; i < s.length - 1; i++)
                arr.push(s.slice(i, i + 2));
              return arr;
            };
            const dice = (a, b) => {
              if (!a || !b) return 0;
              const A = bigrams(a);
              const B = bigrams(b);
              if (A.length === 0 || B.length === 0) return 0;
              let inter = 0;
              const map = new Map();
              for (const t of A) map.set(t, (map.get(t) || 0) + 1);
              for (const t of B) {
                const c = map.get(t) || 0;
                if (c > 0) {
                  inter++;
                  map.set(t, c - 1);
                }
              }
              return (2 * inter) / (A.length + B.length);
            };
            let best = { el: null, score: 0 };
            // Deep traversal including shadow roots
            const stack = [document.documentElement];
            let visited = 0;
            while (stack.length) {
              const node = /** @type {any} */ (stack.pop());
              if (!node || !(node instanceof Element)) continue;
              try {
                if (
                  limitTag &&
                  String(node.tagName || '').toUpperCase() !== limitTag
                ) {
                  // still traverse into children/shadow for performance? yes
                } else {
                  const cs = window.getComputedStyle(node);
                  if (
                    cs.display === 'none' ||
                    cs.visibility === 'hidden' ||
                    cs.opacity === '0'
                  ) {
                    /* skip hidden */
                  } else {
                    const rect = /** @type {HTMLElement} */ (
                      node
                    ).getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                      const txt = normalize(node.textContent || '');
                      if (txt) {
                        if (txt.includes(query)) {
                          el = /** @type {Element} */ (node);
                          break;
                        }
                        const sc = dice(txt, query);
                        if (sc > best.score)
                          best = {
                            el: /** @type {Element} */ (node),
                            score: sc,
                          };
                      }
                    }
                  }
                }
              } catch {}
              // push children and shadow children
              try {
                const children = node.children || [];
                for (let i = 0; i < children.length; i++)
                  stack.push(children[i]);
              } catch {}
              try {
                const sr = node.shadowRoot;
                if (sr && sr.children) {
                  for (let i = 0; i < sr.children.length; i++)
                    stack.push(sr.children[i]);
                }
              } catch {}
              if (++visited > 8000) break;
            }
            if (!el && best.el && best.score >= 0.6) el = best.el;
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
          let refId = null;
          for (const k in window.__claudeElementMap) {
            if (
              window.__claudeElementMap[k].deref &&
              window.__claudeElementMap[k].deref() === el
            ) {
              refId = k;
              break;
            }
          }
          if (!refId) {
            refId = `ref_${++window.__claudeRefCounter}`;
            window.__claudeElementMap[refId] = new WeakRef(el);
          }
          const rect = /** @type {HTMLElement} */ (el).getBoundingClientRect();
          sendResponse({
            success: true,
            ref: refId,
            center: {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            },
          });
          return true;
        } catch (e) {
          sendResponse({
            success: false,
            error: String(e && e.message ? e.message : e),
          });
          return true;
        }
      }
      if (request && request.action === 'dispatchHoverForRef') {
        handleHoverForRef(String(request.ref || '').trim())
          .then((result) => sendResponse(result))
          .catch((error) =>
            sendResponse({
              success: false,
              error: error?.message || String(error),
            }),
          );
        return true;
      }
      if (request && request.action === 'getAttributeForSelector') {
        try {
          const sel = String(request.selector || '').trim();
          const name = String(request.name || '').trim();
          if (!sel || !name) {
            sendResponse({
              success: false,
              error: 'selector and name are required',
            });
            return true;
          }
          const el = document.querySelector(sel) || querySelectorDeepFirst(sel);
          if (!el) {
            sendResponse({
              success: false,
              error: `selector not found: ${sel}`,
            });
            return true;
          }
          let value = null;
          if (name === 'text' || name === 'textContent') {
            value = (el.textContent || '').trim();
          } else if (name === 'value') {
            try {
              value = /** @type {HTMLInputElement} */ (el).value ?? null;
            } catch (_) {
              value = el.getAttribute('value');
            }
          } else {
            value = el.getAttribute(name);
          }
          sendResponse({ success: true, value });
          return true;
        } catch (e) {
          sendResponse({
            success: false,
            error: String(e && e.message ? e.message : e),
          });
          return true;
        }
      }
      if (request && request.action === 'collectVariables') {
        try {
          let vars = Array.isArray(request.variables) ? request.variables : [];
          if ((!vars || vars.length === 0) && request.payload) {
            try {
              const p = JSON.parse(String(request.payload || '{}'));
              if (Array.isArray(p.variables)) vars = p.variables;
            } catch {}
          }
          const useOverlay = request.useOverlay !== false; // default true
          const values = {};
          if (!useOverlay) {
            for (const v of vars) {
              const key = String(v && v.key ? v.key : '');
              if (!key) continue;
              const label = v.label || key;
              const def = v.default || '';
              const promptText = `Please enter parameters ${label} (${key})`;
              let val = window.prompt(promptText, def);
              if (typeof val !== 'string') val = def;
              values[key] = val;
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
          for (const v of vars) {
            const row = document.createElement('div');
            Object.assign(row.style, { marginBottom: '10px' });
            const label = document.createElement('label');
            label.textContent = `${v.label || v.key}${v.sensitive ? ' (Sensitive)' : ''}`;
            Object.assign(label.style, {
              display: 'block',
              marginBottom: '6px',
              fontWeight: '500',
            });
            const input = document.createElement('input');
            input.type = v.sensitive ? 'password' : 'text';
            input.name = String(v.key);
            input.value = String(v.default || '');
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
            e.preventDefault();
            for (const v of vars) {
              const el = form.querySelector(
                `input[name="${CSS.escape(String(v.key))}"]`,
              );
              if (el)
                values[v.key] = /** @type {HTMLInputElement} */ (el).value;
            }
            cleanup();
            sendResponse({ success: true, values });
          };
          return true; // async
        } catch (e) {
          sendResponse({
            success: false,
            error: String(e && e.message ? e.message : e),
          });
          return true;
        }
      }
      if (request && request.action === 'resolveRef') {
        const ref = request.ref;
        try {
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
          const selector = (function () {
            // Simple selector generation inline to avoid duplication
            const generateSelector = function (node) {
              if (!(node instanceof Element)) return '';
              if (node.id) {
                const idSel = `#${CSS.escape(node.id)}`;
                if (document.querySelectorAll(idSel).length === 1) return idSel;
              }
              // prefer unique class selectors if available
              try {
                const classes = Array.from(node.classList || []).filter(
                  (c) => c && /^[a-zA-Z0-9_-]+$/.test(c),
                );
                for (const cls of classes) {
                  const sel = `.${CSS.escape(cls)}`;
                  if (document.querySelectorAll(sel).length === 1) return sel;
                }
                const tag = node.tagName ? node.tagName.toLowerCase() : '';
                for (const cls of classes) {
                  const sel = `${tag}.${CSS.escape(cls)}`;
                  if (document.querySelectorAll(sel).length === 1) return sel;
                }
                for (let i = 0; i < Math.min(classes.length, 3); i++) {
                  for (let j = i + 1; j < Math.min(classes.length, 3); j++) {
                    const sel = `.${CSS.escape(classes[i])}.${CSS.escape(classes[j])}`;
                    if (document.querySelectorAll(sel).length === 1) return sel;
                  }
                }
              } catch {}
              for (const attr of ['data-testid', 'data-cy', 'name']) {
                const val = node.getAttribute(attr);
                if (val) {
                  const s = `[${attr}="${CSS.escape(val)}"]`;
                  if (document.querySelectorAll(s).length === 1) return s;
                }
              }
              let path = '';
              let current = node;
              while (
                current &&
                current.nodeType === Node.ELEMENT_NODE &&
                current.tagName !== 'BODY'
              ) {
                let sel = current.tagName.toLowerCase();
                const parent = current.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.children).filter(
                    (c) => c.tagName === current.tagName,
                  );
                  if (siblings.length > 1) {
                    const idx = siblings.indexOf(current) + 1;
                    sel += `:nth-of-type(${idx})`;
                  }
                }
                path = path ? `${sel} > ${path}` : sel;
                current = parent;
              }
              return path ? `body > ${path}` : 'body';
            };
            return generateSelector(el);
          })();

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
                projectionError: String(
                  error && error.message ? error.message : error,
                ),
              });
            });
          return true;
        } catch (e) {
          sendResponse({
            success: false,
            error: String(e && e.message ? e.message : e),
          });
          return true;
        }
      }
      if (request && request.action === 'verifyFingerprint') {
        try {
          const ref = String(request.ref || '').trim();
          const fingerprint = String(request.fingerprint || '').trim();
          if (!ref || !fingerprint) {
            sendResponse({
              success: false,
              error: 'ref and fingerprint are required',
            });
            return true;
          }
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
            const currentId = el.id ? String(el.id).trim() : '';
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
            error: String(e && e.message ? e.message : e),
          });
          return true;
        }
      }
      if (request && request.action === 'focusByRef') {
        try {
          const ref = String(request.ref || '');
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
            error: String(e && e.message ? e.message : e),
          });
          return true;
        }
      }
    } catch (e) {
      sendResponse({
        success: false,
        error: e && e.message ? e.message : String(e),
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
            handleHoverForRef(data.ref)
              .then((result) => {
                ev.source?.postMessage(
                  {
                    type: 'rr-bridge-hover-ref-result',
                    reqId: data.reqId,
                    result,
                  },
                  '*',
                );
              })
              .catch((error) => {
                ev.source?.postMessage(
                  {
                    type: 'rr-bridge-hover-ref-result',
                    reqId: data.reqId,
                    result: {
                      success: false,
                      error: error?.message || String(error),
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
                    error: String(
                      error && error.message ? error.message : error,
                    ),
                  });
                });
            } catch (error) {
              respond({
                success: false,
                error: String(error && error.message ? error.message : error),
              });
            }
            return;
          }
          if (!data || data.type !== 'rr-bridge-ensure-ref') return;
          const { reqId, selector, useText, isXPath, tagName } = data || {};
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
            const sel = String(selector || '').trim();
            const limitTag = String(tagName || '')
              .trim()
              .toUpperCase();
            let el = null;
            if (useText && sel) {
              const normalize = (s) =>
                String(s || '')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .toLowerCase();
              const query = normalize(sel);
              const bigrams = (s) => {
                const arr = [];
                for (let i = 0; i < s.length - 1; i++)
                  arr.push(s.slice(i, i + 2));
                return arr;
              };
              const dice = (a, b) => {
                if (!a || !b) return 0;
                const A = bigrams(a),
                  B = bigrams(b);
                if (!A.length || !B.length) return 0;
                let inter = 0;
                const m = new Map();
                for (const t of A) m.set(t, (m.get(t) || 0) + 1);
                for (const t of B) {
                  const c = m.get(t) || 0;
                  if (c > 0) {
                    inter++;
                    m.set(t, c - 1);
                  }
                }
                return (2 * inter) / (A.length + B.length);
              };
              let best = { el: null, score: 0 };
              const stack = [document.documentElement];
              while (stack.length) {
                const node = stack.pop();
                if (!node || !(node instanceof Element)) continue;
                try {
                  if (
                    limitTag &&
                    String(node.tagName || '').toUpperCase() !== limitTag
                  ) {
                  } else {
                    const cs = window.getComputedStyle(node);
                    if (
                      cs.display !== 'none' &&
                      cs.visibility !== 'hidden' &&
                      cs.opacity !== '0'
                    ) {
                      const rect = node.getBoundingClientRect();
                      if (rect.width > 0 && rect.height > 0) {
                        const txt = normalize(node.textContent || '');
                        if (txt) {
                          if (txt.includes(query)) {
                            el = node;
                            break;
                          }
                          const sc = dice(txt, query);
                          if (sc > best.score) best = { el: node, score: sc };
                        }
                      }
                    }
                  }
                } catch {}
                try {
                  const children = node.children || [];
                  for (let i = 0; i < children.length; i++)
                    stack.push(children[i]);
                  const sr = node.shadowRoot;
                  if (sr && sr.children)
                    for (let i = 0; i < sr.children.length; i++)
                      stack.push(sr.children[i]);
                } catch {}
              }
              if (!el && best.el) el = best.el;
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
            if (!window.__claudeElementMap) window.__claudeElementMap = {};
            if (!window.__claudeRefCounter) window.__claudeRefCounter = 0;
            let refId = null;
            for (const k in window.__claudeElementMap) {
              const w = window.__claudeElementMap[k];
              if (
                w &&
                typeof w.deref === 'function' &&
                w.deref &&
                w.deref() === el
              ) {
                refId = k;
                break;
              }
            }
            if (!refId) {
              refId = `ref_${++window.__claudeRefCounter}`;
              window.__claudeElementMap[refId] = new WeakRef(el);
            }
            const rect = el.getBoundingClientRect();
            respond({
              success: true,
              ref: refId,
              center: {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
              },
              href: String(location && location.href ? location.href : ''),
            });
          } catch (e) {
            respond({
              success: false,
              error: String(e && e.message ? e.message : e),
            });
          }
        } catch {}
      },
      true,
    );
  } catch {}
})();
