// Shared constants + selector engine for recorder.js

(function () {
  if (window.__RR_RECORDER_SHARED__) return;

  const CONFIG = {
    // Increase debounce to improve step merging for slow/DOM-replacing inputs
    INPUT_DEBOUNCE_MS: 800,
    BATCH_SEND_MS: 100,
    SCROLL_DEBOUNCE_MS: 350,
    SENSITIVE_INPUT_TYPES: new Set(['password']),
    UI_MAX_STEPS: 30,
    LOCAL_MAX_STEPS: 100,
    LOCAL_MAX_VARIABLES: 256,
    // Maximum time to hold flush while user is typing (prevents unbounded batch accumulation)
    MAX_TYPING_HOLD_MS: 1500,
  };

  // Cross-frame event channel
  const FRAME_EVENT = 'rr_iframe_event';

  const SELECTOR_LIMITS = Object.freeze({
    maxSelectorBytes: 4 * 1024,
    maxVisitedElements: 12000,
    maxDepth: 128,
    maxDurationMs: 250,
    maxSiblingSteps: 256,
    maxTraversalSteps: 4096,
    maxClasses: 64,
    maxTextNodes: 512,
    maxTextBytes: 2 * 1024,
    maxTextDurationMs: 25,
  });
  const NATIVE_ELEMENT_MATCHES = Element.prototype.matches;

  // Memoization caches for selector computations during recording
  const __cacheUnique = new WeakMap();
  const __cachePath = new WeakMap();

  const SelectorEngine = {
    buildTarget(el) {
      const previousBudget = this.__activeTraversalBudget;
      this.__activeTraversalBudget = this._createTraversalBudget();
      try {
      const candidates = [];
      const tag = el.tagName?.toLowerCase?.() || '';
      const attrNames = ['data-testid', 'data-test', 'data-qa', 'data-cy'];

      for (const an of attrNames) {
        const v = el.getAttribute && el.getAttribute(an);
        if (v) this._pushCandidate(candidates, { type: 'attr', value: `[${an}="${CSS.escape(v)}"]` });
      }

      const id = el.getAttribute && el.getAttribute('id');
      if (id && this._isStableId(id)) {
        this._pushCandidate(candidates, { type: 'css', value: `#${CSS.escape(id)}` });
      }

      const name = el.getAttribute && el.getAttribute('name');
      if (name) {
        this._pushCandidate(candidates, { type: 'attr', value: `[name="${CSS.escape(name)}"]` });
        const form = el.closest && el.closest('form');
        const formName = form && form.getAttribute && form.getAttribute('name');
        if (formName && tag) {
          this._pushCandidate(candidates, {
            type: 'css',
            value: `form[name="${CSS.escape(formName)}"] ${tag}[name="${CSS.escape(name)}"]`,
          });
        }
      }

      const title = el.getAttribute && el.getAttribute('title');
      if (title) this._pushCandidate(candidates, { type: 'attr', value: `[title="${CSS.escape(title)}"]` });

      const alt = el.getAttribute && el.getAttribute('alt');
      if (alt) this._pushCandidate(candidates, { type: 'attr', value: `[alt="${CSS.escape(alt)}"]` });

      const placeholder = el.getAttribute && el.getAttribute('placeholder');
      if (placeholder) {
        this._pushCandidate(candidates, {
          type: 'attr',
          value: `[placeholder="${CSS.escape(placeholder)}"]`,
        });
      }

      const aria = el.getAttribute && el.getAttribute('aria-label');
      const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
      const role = el.getAttribute && el.getAttribute('role');
      if (aria) {
        this._pushCandidate(candidates, {
          type: 'attr',
          value: `[aria-label="${CSS.escape(aria)}"]`,
        });
        const roleName = role || tag || 'textbox';
        this._pushCandidate(candidates, { type: 'aria', value: `${roleName}[name=${aria}]` });
      }
      if (labelledBy) {
        this._pushCandidate(candidates, {
          type: 'attr',
          value: `[aria-labelledby="${CSS.escape(labelledBy)}"]`,
        });
      }

      const labelText = this._associatedLabelText(el);
      if (labelText) {
        this._pushCandidate(candidates, { type: 'text', value: labelText.substring(0, 64) });
      }

      if (['button', 'a', 'summary', 'option'].includes(tag)) {
        const text = this._boundedText(el);
        if (text) this._pushCandidate(candidates, { type: 'text', value: text.substring(0, 64) });
      }

      const classSel = this._uniqueClassSelector(el);
      if (classSel) this._pushCandidate(candidates, { type: 'css', value: classSel });

      const css = this._generateSelector(el);
      if (css) this._pushCandidate(candidates, { type: 'css', value: css });

      const xpath = this._generateXPath(el);
      if (xpath) this._pushCandidate(candidates, { type: 'xpath', value: xpath });

      const ranked = this._rankCandidates(el, candidates);
      const selector = this._choosePrimary(el, ranked);
      return {
        selector,
        candidates: ranked,
        tag,
        fingerprint: this._computeFingerprint(el),
        domPath: this._computeDomPath(el),
        shadowHostChain: this._computeShadowHostChain(el),
        frameContext: this._buildFrameContext(),
      };
      } finally {
        this.__activeTraversalBudget = previousBudget;
      }
    },

    _createTraversalBudget() {
      return {
        visited: 0,
        steps: 0,
        deadline: Date.now() + SELECTOR_LIMITS.maxDurationMs,
      };
    },

    _utf8ByteLength(value, stopAfter = Number.POSITIVE_INFINITY) {
      let bytes = 0;
      for (const character of typeof value === 'string' ? value : '') {
        const codePoint = character.codePointAt(0) || 0;
        bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        if (bytes > stopAfter) return bytes;
      }
      return bytes;
    },

    _normalizeSelector(selector) {
      if (
        typeof selector !== 'string' ||
        selector.length === 0 ||
        selector.length > SELECTOR_LIMITS.maxSelectorBytes ||
        this._utf8ByteLength(selector, SELECTOR_LIMITS.maxSelectorBytes) >
          SELECTOR_LIMITS.maxSelectorBytes ||
        /:has\s*\(/i.test(selector)
      ) {
        return '';
      }
      return selector.trim();
    },

    _scanSelector(selector, target) {
      const normalized = this._normalizeSelector(selector);
      if (!normalized || !(target instanceof Element)) {
        return { count: 0, first: null, complete: false, selector: normalized };
      }
      const budget = this.__activeTraversalBudget || this._createTraversalBudget();
      try {
        const root = target.getRootNode ? target.getRootNode() : document;
        const first =
          root === document || root.nodeType === Node.DOCUMENT_NODE
            ? root.documentElement
            : root.firstElementChild;
        if (!(first instanceof Element)) {
          return { count: 0, first: null, complete: true, selector: normalized };
        }

        const stack = [{ element: first, depth: 0 }];
        let count = 0;
        let firstMatch = null;
        while (stack.length > 0) {
          if (
            budget.visited >= SELECTOR_LIMITS.maxVisitedElements ||
            Date.now() > budget.deadline
          ) {
            return { count, first: firstMatch, complete: false, selector: normalized };
          }
          const entry = stack.pop();
          if (!entry || entry.depth > SELECTOR_LIMITS.maxDepth) {
            return { count, first: firstMatch, complete: false, selector: normalized };
          }
          const element = entry.element;
          budget.visited += 1;
          if (NATIVE_ELEMENT_MATCHES.call(element, normalized)) {
            count += 1;
            if (count === 1) firstMatch = element;
            if (count >= 2) {
              return { count: 2, first: firstMatch, complete: true, selector: normalized };
            }
          }

          const sibling = element.nextElementSibling;
          if (sibling) stack.push({ element: sibling, depth: entry.depth });
          const child = element.firstElementChild;
          if (child) {
            if (entry.depth >= SELECTOR_LIMITS.maxDepth) {
              return { count, first: firstMatch, complete: false, selector: normalized };
            }
            stack.push({ element: child, depth: entry.depth + 1 });
          }
        }
        return { count, first: firstMatch, complete: true, selector: normalized };
      } catch {
        return { count: 0, first: null, complete: false, selector: normalized };
      }
    },

    _isUniqueSelector(selector, target) {
      const result = this._scanSelector(selector, target);
      return result.complete && result.count === 1 && result.first === target;
    },

    _consumeTraversalStep() {
      const budget = this.__activeTraversalBudget || this._createTraversalBudget();
      budget.steps += 1;
      return (
        budget.steps <= SELECTOR_LIMITS.maxTraversalSteps && Date.now() <= budget.deadline
      );
    },

    _boundedClasses(el) {
      const result = [];
      try {
        const list = el && el.classList;
        const length = Math.min(Number(list && list.length) || 0, SELECTOR_LIMITS.maxClasses);
        for (let index = 0; index < length; index += 1) {
          const value = list.item(index);
          if (value) result.push(value);
        }
      } catch {}
      return result;
    },

    _boundedText(el) {
      if (!(el instanceof Element)) return '';
      try {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_ALL);
        const deadline = Date.now() + SELECTOR_LIMITS.maxTextDurationMs;
        let output = '';
        let visited = 0;
        let bytes = 0;
        while (visited < SELECTOR_LIMITS.maxTextNodes && Date.now() <= deadline) {
          const node = walker.nextNode();
          if (!node) break;
          visited += 1;
          if (node.nodeType !== Node.TEXT_NODE) continue;
          const parentTag = node.parentElement?.tagName?.toLowerCase() || '';
          if (parentTag === 'script' || parentTag === 'style' || parentTag === 'noscript') continue;
          const raw = typeof node.nodeValue === 'string' ? node.nodeValue : '';
          let part = '';
          for (const character of raw) {
            const codePoint = character.codePointAt(0) || 0;
            const nextBytes =
              codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
            if (bytes + nextBytes > SELECTOR_LIMITS.maxTextBytes) break;
            part += character;
            bytes += nextBytes;
          }
          if (part) output += `${output ? ' ' : ''}${part}`;
          if (bytes >= SELECTOR_LIMITS.maxTextBytes) break;
        }
        return output.trim().replace(/\s+/g, ' ').slice(0, 256);
      } catch {
        return '';
      }
    },

    _elementSiblingIndex(el) {
      let index = 0;
      let sibling = el && el.previousElementSibling;
      while (sibling) {
        if (index >= SELECTOR_LIMITS.maxSiblingSteps || !this._consumeTraversalStep()) return -1;
        index += 1;
        sibling = sibling.previousElementSibling;
      }
      return index;
    },

    _sameTagPosition(el, checkFollowing) {
      let index = 1;
      let scanned = 0;
      let sibling = el && el.previousElementSibling;
      while (sibling) {
        if (scanned >= SELECTOR_LIMITS.maxSiblingSteps || !this._consumeTraversalStep()) {
          return { index: 0, multiple: false, complete: false };
        }
        scanned += 1;
        if (sibling.tagName === el.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      if (index > 1 || !checkFollowing) return { index, multiple: index > 1, complete: true };

      scanned = 0;
      sibling = el && el.nextElementSibling;
      while (sibling) {
        if (scanned >= SELECTOR_LIMITS.maxSiblingSteps || !this._consumeTraversalStep()) {
          return { index, multiple: false, complete: false };
        }
        scanned += 1;
        if (sibling.tagName === el.tagName) return { index, multiple: true, complete: true };
        sibling = sibling.nextElementSibling;
      }
      return { index, multiple: false, complete: true };
    },

    _pushCandidate(candidates, candidate) {
      if (!candidate || !candidate.value) return;
      if (
        typeof candidate.value !== 'string' ||
        this._utf8ByteLength(candidate.value, SELECTOR_LIMITS.maxSelectorBytes) >
          SELECTOR_LIMITS.maxSelectorBytes
      ) {
        return;
      }
      candidates.push(candidate);
    },

    _choosePrimary(el, candidates) {
      const id = el && el.getAttribute ? el.getAttribute('id') : '';
      if (id && this._isStableId(id)) {
        const idSel = `#${CSS.escape(id)}`;
        try {
          if (this._isUniqueSelector(idSel, el)) return idSel;
        } catch {}
      }

      const first = candidates && candidates.length ? candidates[0] : null;
      if (first && first.value) {
        try {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          if (first.type === 'attr' && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
            const val = String(first.value || '').trim();
            if (val.startsWith('[')) return `${tag}${val}`;
          }
        } catch {}
        return String(first.value);
      }

      return SelectorEngine._generateSelector(el) || '';
    },

    _rankCandidates(el, candidates) {
      const map = new Map();
      for (const c of candidates || []) {
        if (!c || !c.value) continue;
        const score = this.scoreSelector(c, el);
        if (score <= 0) continue;
        const normalized = {
          type: c.type,
          value: String(c.value),
          source: 'recorded',
          strategy: this._candidateStrategy(c),
          stability: {
            score: Number(score.toFixed(3)),
            signals: this._candidateStabilitySignals(c),
          },
          weight: Number(score.toFixed(3)),
        };
        const key = `${normalized.type}:${normalized.value}`;
        const old = map.get(key);
        if (!old || normalized.weight > old.weight) {
          map.set(key, normalized);
        }
      }
      return Array.from(map.values()).sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight;
        return a.value.length - b.value.length;
      });
    },

    _candidateStrategy(candidate) {
      const type = String(candidate && candidate.type ? candidate.type : '');
      const value = String(candidate && candidate.value ? candidate.value : '');
      if (type === 'attr' && /\[data-(testid|test|qa|cy)=/i.test(value)) return 'testid';
      if (type === 'attr' && /\[aria-label=|\[aria-labelledby=/i.test(value)) return 'aria';
      if (type === 'attr' && /\[name=/i.test(value)) return 'name';
      if (type === 'aria') return 'aria';
      if (type === 'text') return 'text';
      if (type === 'xpath') return 'xpath';
      if (value.includes(':nth-of-type(')) return 'css-path';
      return type || 'unknown';
    },

    _candidateStabilitySignals(candidate) {
      const type = String(candidate && candidate.type ? candidate.type : '');
      const value = String(candidate && candidate.value ? candidate.value : '');
      return {
        usesId: type === 'css' && value.startsWith('#'),
        usesTestId: /\[data-(testid|test|qa|cy)=/i.test(value),
        usesAria: type === 'aria' || /\[aria-label=|\[aria-labelledby=/i.test(value),
        usesText: type === 'text',
        usesNthOfType: value.includes(':nth-of-type('),
        usesAttributes: type === 'attr' || /\[[^\]]+=/.test(value),
        usesClass: /(^|\s|>)\.[a-zA-Z0-9_-]+/.test(value),
      };
    },

    _normalizeFingerprintText(text) {
      return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    },

    _computeFingerprint(el) {
      try {
        const parts = [];
        const tag = el.tagName?.toLowerCase?.() || 'unknown';
        parts.push(tag);
        const id = el.getAttribute && el.getAttribute('id');
        if (id) parts.push(`id=${id}`);
        const classes = this._boundedClasses(el).slice(0, 8);
        if (classes.length) parts.push(`class=${classes.join('.')}`);
        const text = this._normalizeFingerprintText(this._boundedText(el));
        if (text) parts.push(`text=${text}`);
        return parts.join('|');
      } catch {
        return 'unknown';
      }
    },

    _computeDomPath(el) {
      const path = [];
      try {
        let current = el;
        let depth = 0;
        while (current && depth < SELECTOR_LIMITS.maxDepth) {
          const index = this._elementSiblingIndex(current);
          if (index < 0) break;
          path.unshift(index);
          const parent = current.parentElement;
          if (parent) {
            current = parent;
            depth += 1;
            continue;
          }
          const parentNode = current.parentNode;
          if (
            (typeof ShadowRoot !== 'undefined' && parentNode instanceof ShadowRoot) ||
            (typeof Document !== 'undefined' && parentNode instanceof Document)
          ) {
            break;
          }
          break;
        }
      } catch {}
      return path;
    },

    _hostSelector(host) {
      try {
        const id = host.getAttribute && host.getAttribute('id');
        if (id && this._isStableId(id)) {
          const selector = `#${CSS.escape(id)}`;
          if (this._isUniqueSelector(selector, host)) return selector;
        }
        for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name']) {
          const value = host.getAttribute && host.getAttribute(attr);
          if (!value) continue;
          const selector = `[${attr}="${CSS.escape(value)}"]`;
          if (this._isUniqueSelector(selector, host)) return selector;
        }
        return this._generateSelector(host);
      } catch {
        return '';
      }
    },

    _computeShadowHostChain(el) {
      const chain = [];
      try {
        let root = el && el.getRootNode ? el.getRootNode() : null;
        let guard = 0;
        while (root && typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot && guard++ < 10) {
          const host = root.host;
          const selector = this._hostSelector(host);
          if (selector) chain.unshift(selector);
          root = host && host.getRootNode ? host.getRootNode() : null;
        }
      } catch {}
      return chain;
    },

    _buildFrameContext() {
      try {
        return {
          kind: window === window.top ? 'top' : 'iframe',
          url: String(location && location.href ? location.href : ''),
        };
      } catch {
        return { kind: 'top' };
      }
    },

    scoreSelector(candidate, el) {
      const type = String(candidate && candidate.type ? candidate.type : '');
      const value = String(candidate && candidate.value ? candidate.value : '');
      if (!value) return 0;

      let score = 0.35;
      if (type === 'attr') {
        if (/\[data-(testid|test|qa|cy)=/i.test(value)) score = 0.99;
        else if (/\[aria-label=/i.test(value)) score = 0.84;
        else if (/\[name=/i.test(value)) score = 0.8;
        else if (/\[(placeholder|title|alt)=/i.test(value)) score = 0.68;
        else score = 0.62;
      } else if (type === 'aria') {
        score = 0.83;
      } else if (type === 'css') {
        if (value.startsWith('#')) score = 0.9;
        else if (value.includes('form[') && value.includes('[name=')) score = 0.82;
        else if (value.startsWith('.')) score = 0.65;
        else if (value.includes(':nth-of-type(')) score = 0.4;
        else score = 0.58;
      } else if (type === 'text') {
        score = 0.5;
      } else if (type === 'xpath') {
        score = 0.28;
      }

      if (this._looksDynamicSelector(value)) score -= 0.35;
      if (value.includes(':nth-of-type(')) score -= 0.08;
      if (value.length > 120) score -= 0.06;
      if (value.length > 180) score -= 0.1;
      if (!this._isLikelyUnique(type, value, el)) score -= 0.12;

      if (score < 0) score = 0;
      if (score > 1) score = 1;
      return score;
    },

    _isLikelyUnique(type, value, el) {
      if (type !== 'css' && type !== 'attr') return true;
      try {
        const result = this._scanSelector(value, el);
        if (result.complete && result.count === 1 && result.first === el) return true;
        if (el && result.count >= 2) {
          try {
            return !!NATIVE_ELEMENT_MATCHES.call(el, result.selector);
          } catch {
            return false;
          }
        }
        return false;
      } catch {
        return false;
      }
    },

    _looksDynamicSelector(value) {
      const v = String(value || '');
      if (!v) return false;
      return (
        /[a-f0-9]{8,}/i.test(v) ||
        /(?:^|[_-])[0-9]{3,}(?:$|[_-])/i.test(v) ||
        /\b\d{6,}\b/.test(v) ||
        /(css|jsx|chakra|mui)-[a-z0-9]{5,}/i.test(v)
      );
    },

    _isStableId(id) {
      const v = String(id || '').trim();
      if (!v) return false;
      if (v.length > 80) return false;
      if (/^\d+$/.test(v)) return false;
      if (/[a-f0-9]{8,}/i.test(v) && /[-_]/.test(v)) return false;
      if (/(?:^|[_-])[0-9]{4,}(?:$|[_-])/.test(v)) return false;
      if (/^[a-z]{0,4}\d{6,}$/i.test(v)) return false;
      return true;
    },

    _associatedLabelText(el) {
      if (!(el instanceof Element)) return '';
      try {
        const id = el.getAttribute && el.getAttribute('id');
        if (id) {
          const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          const txt = lab ? this._boundedText(lab) : '';
          if (txt) return txt;
        }
      } catch {}
      try {
        const parentLabel = el.closest && el.closest('label');
        const txt = parentLabel ? this._boundedText(parentLabel) : '';
        if (txt) return txt;
      } catch {}
      return '';
    },

    _uniqueClassSelector(el) {
      if (__cacheUnique.has(el)) return __cacheUnique.get(el);
      let result = '';
      try {
        const classes = this._boundedClasses(el).filter(
          (c) => c && /^[a-zA-Z0-9_-]+$/.test(c),
        );
        for (const cls of classes) {
          const sel = `.${CSS.escape(cls)}`;
          if (this._isUniqueSelector(sel, el)) {
            result = sel;
            break;
          }
        }
        if (!result) {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          for (const cls of classes) {
            const sel = `${tag}.${CSS.escape(cls)}`;
            if (this._isUniqueSelector(sel, el)) {
              result = sel;
              break;
            }
          }
        }
        if (!result) {
          for (let i = 0; i < Math.min(classes.length, 3) && !result; i++) {
            for (let j = i + 1; j < Math.min(classes.length, 3); j++) {
              const sel = `.${CSS.escape(classes[i])}.${CSS.escape(classes[j])}`;
              if (this._isUniqueSelector(sel, el)) {
                result = sel;
                break;
              }
            }
          }
        }
      } catch {}
      __cacheUnique.set(el, result);
      return result;
    },

    _generateSelector(el) {
      if (!(el instanceof Element)) return '';
      if (__cachePath.has(el)) return __cachePath.get(el);
      const id = el.getAttribute && el.getAttribute('id');
      if (id && this._isStableId(id)) {
        const idSel = `#${CSS.escape(id)}`;
        if (this._isUniqueSelector(idSel, el)) return idSel;
      }
      for (const attr of ['data-testid', 'data-cy', 'data-qa', 'name']) {
        const attrValue = el.getAttribute(attr);
        if (attrValue) {
          const s = `[${attr}="${CSS.escape(attrValue)}"]`;
          if (this._isUniqueSelector(s, el)) return s;
        }
      }
      let path = '';
      let current = el;
      let depth = 0;
      while (
        current &&
        current.nodeType === Node.ELEMENT_NODE &&
        current.tagName !== 'BODY' &&
        depth < SELECTOR_LIMITS.maxDepth
      ) {
        let selector = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const position = this._sameTagPosition(current, true);
          if (position.complete && position.multiple) {
            selector += `:nth-of-type(${position.index})`;
          }
        }
        const candidatePath = path ? `${selector} > ${path}` : selector;
        if (
          this._utf8ByteLength(candidatePath, SELECTOR_LIMITS.maxSelectorBytes - 7) >
          SELECTOR_LIMITS.maxSelectorBytes - 7
        ) {
          break;
        }
        path = candidatePath;
        current = parent;
        depth += 1;
      }
      const res = path ? `body > ${path}` : 'body';
      __cachePath.set(el, res);
      return res;
    },

    _generateXPath(el) {
      if (!(el instanceof Element)) return '';
      const segments = [];
      let current = el;
      let depth = 0;
      while (
        current &&
        current.nodeType === Node.ELEMENT_NODE &&
        depth < SELECTOR_LIMITS.maxDepth
      ) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) {
          segments.unshift(tag);
          break;
        }
        const position = this._sameTagPosition(current, false);
        if (!position.complete || position.index <= 0) return '';
        const segment = `${tag}[${position.index}]`;
        const candidatePath = `/${[segment, ...segments].join('/')}`;
        if (
          this._utf8ByteLength(candidatePath, SELECTOR_LIMITS.maxSelectorBytes) >
          SELECTOR_LIMITS.maxSelectorBytes
        ) {
          return '';
        }
        segments.unshift(segment);
        current = parent;
        depth += 1;
        if (tag === 'html') break;
      }
      if (!segments.length) return '';
      return `/${segments.join('/')}`;
    },
  };

  // Extend SelectorEngine with a shared ref helper (attached after declaration)
  SelectorEngine._ensureGlobalRef = function (el) {
    try {
      if (!window.__claudeElementMap) window.__claudeElementMap = {};
      if (!window.__claudeRefCounter) window.__claudeRefCounter = 0;
      for (const k in window.__claudeElementMap) {
        const w = window.__claudeElementMap[k];
        if (w && typeof w.deref === 'function' && w.deref() === el) return k;
      }
      const id = `ref_${++window.__claudeRefCounter}`;
      window.__claudeElementMap[id] = new WeakRef(el);
      return id;
    } catch {
      return null;
    }
  };

  window.__RR_RECORDER_SHARED__ = {
    CONFIG,
    FRAME_EVENT,
    SelectorEngine,
  };
})();
