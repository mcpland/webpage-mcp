// interactive-elements-helper.js
// Bounded page-side discovery for interactive controls and text targets.

(function () {
  if (window.__INTERACTIVE_ELEMENTS_HELPER_INITIALIZED__) return;
  window.__INTERACTIVE_ELEMENTS_HELPER_INITIALIZED__ = true;

  const LIMITS = {
    maxNodes: 12000,
    maxDepth: 128,
    maxDurationMs: 250,
    maxStyleChecks: 2000,
    maxLayoutChecks: 2000,
    maxSelectorChecks: 16000,
    maxSelectorSteps: 8000,
    maxTextReads: 4096,
    maxTextNodesPerName: 64,
    maxAncestorSteps: 64,
    maxSiblingSteps: 128,
    maxResults: 200,
    maxResultJsonBytes: 512 * 1024,
    resultJsonReserveBytes: 4096,
    selectorBytes: 4 * 1024,
    textQueryBytes: 1024,
    elementTextBytes: 1024,
    scannedTextNodeBytes: 4 * 1024,
    typeBytes: 64,
    errorBytes: 4 * 1024,
  };

  const ELEMENT_CONFIG = {
    button: 'button, input[type="button"], input[type="submit"], [role="button"]',
    link: 'a[href], [role="link"]',
    input:
      'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])',
    checkbox: 'input[type="checkbox"], [role="checkbox"]',
    radio: 'input[type="radio"], [role="radio"]',
    textarea: 'textarea, [role="textbox"], [role="searchbox"]',
    select: 'select, [role="combobox"]',
    tab: '[role="tab"]',
    interactive:
      '[onclick], [tabindex]:not([tabindex^="-"]), [role="menuitem"], [role="slider"], [role="option"], [role="treeitem"], [role="switch"]',
  };
  const TYPE_NAMES = Object.keys(ELEMENT_CONFIG);
  const TYPE_SET = new Set(TYPE_NAMES);

  function now() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

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

  function createBudget() {
    return {
      startedAt: now(),
      deadline: now() + LIMITS.maxDurationMs,
      nodes: 0,
      styleChecks: 0,
      layoutChecks: 0,
      selectorChecks: 0,
      selectorSteps: 0,
      textReads: 0,
      resultBytes: 2,
      truncated: false,
      reasons: new Set(),
    };
  }

  function markTruncated(budget, reason) {
    budget.truncated = true;
    if (budget.reasons.size < 8) budget.reasons.add(reason);
  }

  function withinDeadline(budget) {
    if (now() <= budget.deadline) return true;
    markTruncated(budget, 'time');
    return false;
  }

  function consume(budget, key, maximum, reason, amount = 1) {
    if (budget[key] + amount > maximum) {
      markTruncated(budget, reason);
      return false;
    }
    budget[key] += amount;
    return true;
  }

  function createFrame(node, depth) {
    return {
      node,
      depth,
      entered: false,
      shadowChild: null,
      lightChild: null,
    };
  }

  // Depth-first traversal stores only the current ancestry. It never expands a
  // wide child collection into an attacker-sized Array or stack.
  function* walkAllNodesDeep(root, budget) {
    const first =
      root instanceof Node && root.nodeType === Node.ELEMENT_NODE
        ? root
        : root && root.documentElement
          ? root.documentElement
          : root && root.firstElementChild
            ? root.firstElementChild
            : null;
    if (!first) return;

    const stack = [createFrame(first, 0)];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame.entered) {
        frame.entered = true;
        if (!consume(budget, 'nodes', LIMITS.maxNodes, 'nodes')) return;
        if ((budget.nodes & 63) === 0 && !withinDeadline(budget)) return;

        try {
          frame.lightChild = frame.node.firstChild || null;
        } catch (_) {
          frame.lightChild = null;
        }
        try {
          const shadowRoot =
            frame.node instanceof Element && frame.node.shadowRoot
              ? frame.node.shadowRoot
              : null;
          frame.shadowChild = shadowRoot ? shadowRoot.firstChild : null;
        } catch (_) {
          frame.shadowChild = null;
        }
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

      if (frame.depth >= LIMITS.maxDepth) {
        markTruncated(budget, 'depth');
        continue;
      }
      stack.push(createFrame(child, frame.depth + 1));
    }
  }

  function normalizeOptions(value) {
    const input = value && typeof value === 'object' ? value : {};
    const normalizeString = (name, raw, maximumBytes) => {
      if (raw === undefined || raw === null || raw === '') return undefined;
      if (typeof raw !== 'string') throw new Error(name + ' must be a string');
      const normalized = raw.trim();
      if (!normalized) return undefined;
      if (
        normalized.length > maximumBytes ||
        utf8ByteLength(normalized, maximumBytes) > maximumBytes
      ) {
        throw new Error(name + ' exceeds the ' + maximumBytes + '-byte UTF-8 limit');
      }
      return normalized;
    };

    const selector = normalizeString('selector', input.selector, LIMITS.selectorBytes);
    if (selector && /:has\s*\(/iu.test(selector)) {
      throw new Error('selector must not use the resource-intensive :has() pseudo-class');
    }
    if (selector) {
      try {
        document.documentElement.matches(selector);
      } catch (error) {
        throw new Error(
          'Invalid CSS selector: ' +
            truncateUtf8(error && error.message ? error.message : String(error), 512),
        );
      }
    }

    const textQuery = normalizeString(
      'textQuery',
      input.textQuery,
      LIMITS.textQueryBytes,
    );
    let types = TYPE_NAMES;
    if (input.types !== undefined) {
      if (!Array.isArray(input.types)) throw new Error('types must be an array');
      if (input.types.length > TYPE_NAMES.length) {
        throw new Error('types contains too many entries');
      }
      const unique = new Set();
      for (const item of input.types) {
        if (typeof item !== 'string' || !TYPE_SET.has(item)) {
          throw new Error(
            'Unsupported interactive element type: ' +
              (typeof item === 'string'
                ? truncateUtf8(item, LIMITS.typeBytes)
                : typeof item),
          );
        }
        unique.add(item);
      }
      types = Array.from(unique);
    }

    return {
      selector,
      textQuery,
      includeCoordinates: input.includeCoordinates !== false,
      types,
    };
  }

  function matchesSelector(element, selector, budget) {
    if (!consume(budget, 'selectorChecks', LIMITS.maxSelectorChecks, 'selector_checks')) {
      return false;
    }
    try {
      return element.matches(selector);
    } catch (_) {
      return false;
    }
  }

  function isElementInteractive(element, budget) {
    if (
      element.hasAttribute('disabled') ||
      element.getAttribute('aria-disabled') === 'true'
    ) {
      return false;
    }
    let current = element;
    let steps = 0;
    while (current && steps < LIMITS.maxAncestorSteps) {
      if (current.getAttribute && current.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      current = current.parentElement;
      steps += 1;
    }
    if (current) markTruncated(budget, 'ancestor_depth');
    return true;
  }

  function getVisibleRect(element, budget) {
    if (!element || !element.isConnected) return null;
    if (!consume(budget, 'styleChecks', LIMITS.maxStyleChecks, 'style_checks')) {
      return null;
    }
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity) === 0
    ) {
      return null;
    }
    if (!consume(budget, 'layoutChecks', LIMITS.maxLayoutChecks, 'layout_checks')) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0 && element.tagName !== 'A') return null;
    return rect;
  }

  function collectBoundedText(root, budget) {
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let output = '';
    let textNodes = 0;
    let current = walker.nextNode();
    while (current && textNodes < LIMITS.maxTextNodesPerName) {
      if (!consume(budget, 'textReads', LIMITS.maxTextReads, 'text_reads')) break;
      const remaining = LIMITS.elementTextBytes - utf8ByteLength(output);
      if (remaining <= 0) break;
      const piece = truncateUtf8(current.nodeValue || '', remaining);
      output += piece;
      if (piece.length < String(current.nodeValue || '').length) break;
      textNodes += 1;
      current = walker.nextNode();
    }
    if (current) markTruncated(budget, 'element_text');
    return output.replace(/\s+/g, ' ').trim();
  }

  function findParentLabel(element, budget) {
    let current = element.parentElement;
    let steps = 0;
    while (current && steps < LIMITS.maxAncestorSteps) {
      if (current.tagName === 'LABEL') return current;
      current = current.parentElement;
      steps += 1;
    }
    if (current) markTruncated(budget, 'ancestor_depth');
    return null;
  }

  function getAccessibleName(element, budget) {
    const labelledBy = truncateUtf8(
      element.getAttribute('aria-labelledby') || '',
      LIMITS.elementTextBytes,
    )
      .split(/\s+/)
      .filter(Boolean)[0];
    if (labelledBy) {
      const labelElement = document.getElementById(labelledBy);
      if (labelElement) {
        const labelText = collectBoundedText(labelElement, budget);
        if (labelText) return labelText;
      }
    }

    for (const attribute of ['aria-label', 'placeholder', 'value', 'title']) {
      const value = truncateUtf8(
        element.getAttribute(attribute) || '',
        LIMITS.elementTextBytes,
      ).trim();
      if (value) return value;
    }

    const parentLabel = findParentLabel(element, budget);
    if (parentLabel) {
      const labelText = collectBoundedText(parentLabel, budget);
      if (labelText) return labelText;
    }
    return collectBoundedText(element, budget);
  }

  function fuzzyMatch(text, query) {
    if (!text || !query) return false;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let textIndex = 0;
    let queryIndex = 0;
    while (textIndex < lowerText.length && queryIndex < lowerQuery.length) {
      if (lowerText[textIndex] === lowerQuery[queryIndex]) queryIndex += 1;
      textIndex += 1;
    }
    return queryIndex === lowerQuery.length;
  }

  function cssEscapeIdentifier(value) {
    const input = truncateUtf8(value, LIMITS.selectorBytes);
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(input);
    }
    return input.replace(/[^a-zA-Z0-9_-]/g, (character) => {
      return '\\' + character.codePointAt(0).toString(16) + ' ';
    });
  }

  function cssEscapeString(value) {
    return truncateUtf8(value, LIMITS.selectorBytes)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/[\n\r\f]/g, ' ');
  }

  function generateSelector(element, budget) {
    if (!(element instanceof Element)) return '';
    if (element.id) {
      return truncateUtf8('#' + cssEscapeIdentifier(element.id), LIMITS.selectorBytes);
    }
    for (const attribute of ['data-testid', 'data-cy', 'name']) {
      const value = element.getAttribute(attribute);
      if (value) {
        return truncateUtf8(
          '[' + attribute + '="' + cssEscapeString(value) + '"]',
          LIMITS.selectorBytes,
        );
      }
    }

    const parts = [];
    let current = element;
    let depth = 0;
    while (
      current &&
      current.nodeType === Node.ELEMENT_NODE &&
      current.tagName !== 'BODY' &&
      depth < 32
    ) {
      if (!consume(budget, 'selectorSteps', LIMITS.maxSelectorSteps, 'selector_steps')) {
        break;
      }
      const tagName = current.tagName.toLowerCase();
      let sameTypeBefore = 0;
      let sibling = current.previousElementSibling;
      let siblingSteps = 0;
      while (sibling && siblingSteps < LIMITS.maxSiblingSteps) {
        if (!consume(budget, 'selectorSteps', LIMITS.maxSelectorSteps, 'selector_steps')) {
          sibling = null;
          break;
        }
        if (sibling.tagName === current.tagName) sameTypeBefore += 1;
        sibling = sibling.previousElementSibling;
        siblingSteps += 1;
      }
      if (sibling) markTruncated(budget, 'selector_siblings');
      parts.push(
        sameTypeBefore > 0 ? tagName + ':nth-of-type(' + (sameTypeBefore + 1) + ')' : tagName,
      );
      current = current.parentElement;
      depth += 1;
    }
    if (current && current.tagName !== 'BODY') markTruncated(budget, 'selector_depth');
    const path = parts.reverse().join(' > ');
    return truncateUtf8(path ? 'body > ' + path : 'body', LIMITS.selectorBytes);
  }

  function determineType(element, types, budget) {
    for (const type of types) {
      if (matchesSelector(element, ELEMENT_CONFIG[type], budget)) return type;
    }
    return null;
  }

  function finite(value) {
    return Number.isFinite(value) ? value : 0;
  }

  function createElementInfo(
    element,
    type,
    includeCoordinates,
    budget,
    knownRect,
    knownText,
  ) {
    const info = {
      type: truncateUtf8(type || 'unknown', LIMITS.typeBytes),
      selector: generateSelector(element, budget),
      text:
        typeof knownText === 'string'
          ? truncateUtf8(knownText, LIMITS.elementTextBytes)
          : getAccessibleName(element, budget),
      isInteractive: isElementInteractive(element, budget),
      disabled:
        element.hasAttribute('disabled') ||
        element.getAttribute('aria-disabled') === 'true',
    };
    const href = truncateUtf8(element.getAttribute('href') || '', LIMITS.selectorBytes);
    if (href) info.href = href;
    if ('checked' in element && typeof element.checked === 'boolean') {
      info.checked = element.checked;
    }
    if (includeCoordinates) {
      const rect =
        knownRect ||
        (consume(budget, 'layoutChecks', LIMITS.maxLayoutChecks, 'layout_checks')
          ? element.getBoundingClientRect()
          : null);
      if (rect) {
        info.coordinates = {
          x: finite(rect.left + rect.width / 2),
          y: finite(rect.top + rect.height / 2),
          rect: {
            x: finite(rect.x),
            y: finite(rect.y),
            width: finite(rect.width),
            height: finite(rect.height),
            top: finite(rect.top),
            right: finite(rect.right),
            bottom: finite(rect.bottom),
            left: finite(rect.left),
          },
        };
      }
    }
    return info;
  }

  function pushBoundedResult(results, info, budget) {
    if (results.length >= LIMITS.maxResults) {
      markTruncated(budget, 'results');
      return false;
    }
    const bytes = utf8ByteLength(JSON.stringify(info));
    const maximum = LIMITS.maxResultJsonBytes - LIMITS.resultJsonReserveBytes;
    if (budget.resultBytes + bytes + (results.length > 0 ? 1 : 0) > maximum) {
      markTruncated(budget, 'result_bytes');
      return false;
    }
    results.push(info);
    budget.resultBytes += bytes + (results.length > 1 ? 1 : 0);
    return true;
  }

  function findInteractiveAncestor(element, selector, budget) {
    let current = element;
    let steps = 0;
    while (current && steps < LIMITS.maxAncestorSteps) {
      if (
        matchesSelector(current, selector, budget) &&
        isElementInteractive(current, budget)
      ) {
        return current;
      }
      current = current.parentElement;
      steps += 1;
    }
    if (current) markTruncated(budget, 'ancestor_depth');
    return null;
  }

  function findElements(options) {
    const budget = createBudget();
    const results = [];
    const textAncestors = new Set();
    const textParents = new Set();
    const selectorForTypes = options.types
      .map((type) => ELEMENT_CONFIG[type])
      .filter(Boolean)
      .join(', ');
    const normalizedQuery = (options.textQuery || '').toLowerCase();

    if (!options.selector && !selectorForTypes) {
      return { elements: [], budget };
    }

    for (const node of walkAllNodesDeep(document, budget)) {
      if (node instanceof Element) {
        if (options.selector) {
          if (matchesSelector(node, options.selector, budget)) {
            const info = createElementInfo(
              node,
              'selected',
              options.includeCoordinates,
              budget,
              null,
            );
            if (!pushBoundedResult(results, info, budget)) break;
          }
        } else if (selectorForTypes && matchesSelector(node, selectorForTypes, budget)) {
          const rect = getVisibleRect(node, budget);
          if (rect && isElementInteractive(node, budget)) {
            const name = getAccessibleName(node, budget);
            if (!normalizedQuery || fuzzyMatch(name, normalizedQuery)) {
              const type = determineType(node, options.types, budget) || 'interactive';
              const info = createElementInfo(
                node,
                type,
                options.includeCoordinates,
                budget,
                rect,
                name,
              );
              if (!pushBoundedResult(results, info, budget)) break;
            }
          }
        }
      } else if (
        normalizedQuery &&
        node.nodeType === Node.TEXT_NODE &&
        textParents.size < LIMITS.maxResults
      ) {
        if (!consume(budget, 'textReads', LIMITS.maxTextReads, 'text_reads')) break;
        const text = truncateUtf8(
          node.nodeValue || '',
          LIMITS.scannedTextNodeBytes,
        )
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        if (text && text.includes(normalizedQuery)) {
          const parent = node.parentElement;
          if (parent) {
            const interactive = findInteractiveAncestor(parent, selectorForTypes, budget);
            if (interactive) textAncestors.add(interactive);
            textParents.add(parent);
          }
        }
      } else if (
        normalizedQuery &&
        node.nodeType === Node.TEXT_NODE &&
        textParents.size >= LIMITS.maxResults
      ) {
        markTruncated(budget, 'text_candidates');
      }

      if (
        results.length >= LIMITS.maxResults ||
        budget.styleChecks >= LIMITS.maxStyleChecks ||
        budget.layoutChecks >= LIMITS.maxLayoutChecks ||
        budget.selectorChecks >= LIMITS.maxSelectorChecks
      ) {
        markTruncated(budget, 'work');
        break;
      }
    }

    if (results.length === 0 && normalizedQuery) {
      const candidates = textAncestors.size > 0 ? textAncestors : textParents;
      for (const element of candidates) {
        const rect = getVisibleRect(element, budget);
        if (!rect) continue;
        const type =
          textAncestors.size > 0
            ? determineType(element, options.types, budget) || 'interactive'
            : 'text';
        const info = createElementInfo(
          element,
          type,
          options.includeCoordinates,
          budget,
          rect,
        );
        if (!pushBoundedResult(results, info, budget)) break;
      }
    }

    return { elements: results, budget };
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request && request.action === 'getInteractiveElements') {
      try {
        const options = normalizeOptions(request);
        const outcome = findElements(options);
        const endedAt = now();
        sendResponse({
          success: true,
          elements: outcome.elements,
          count: outcome.elements.length,
          truncated: outcome.budget.truncated,
          truncationReasons: Array.from(outcome.budget.reasons),
          stats: {
            visitedNodes: outcome.budget.nodes,
            styleChecks: outcome.budget.styleChecks,
            layoutChecks: outcome.budget.layoutChecks,
            selectorChecks: outcome.budget.selectorChecks,
            durationMs: Math.max(0, Math.round(endedAt - outcome.budget.startedAt)),
          },
        });
      } catch (error) {
        sendResponse({
          success: false,
          error: truncateUtf8(
            error && error.message ? error.message : String(error),
            LIMITS.errorBytes,
          ),
        });
      }
      return true;
    }
    if (request && request.action === 'chrome_get_interactive_elements_ping') {
      sendResponse({ status: 'pong' });
      return false;
    }
  });
})();
