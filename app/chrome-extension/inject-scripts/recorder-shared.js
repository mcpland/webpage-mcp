/* eslint-disable */
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
    // Maximum time to hold flush while user is typing (prevents unbounded batch accumulation)
    MAX_TYPING_HOLD_MS: 1500,
  };

  // Cross-frame event channel
  const FRAME_EVENT = 'rr_iframe_event';

  // Memoization caches for selector computations during recording
  const __cacheUnique = new WeakMap();
  const __cachePath = new WeakMap();

  const SelectorEngine = {
    buildTarget(el) {
      const candidates = [];
      const attrNames = ['data-testid', 'data-testId', 'data-test', 'data-qa', 'data-cy'];
      for (const an of attrNames) {
        const v = el.getAttribute && el.getAttribute(an);
        if (v) candidates.push({ type: 'attr', value: `[${an}="${CSS.escape(v)}"]` });
      }
      const classSel = this._uniqueClassSelector(el);
      if (classSel) candidates.push({ type: 'css', value: classSel });
      const css = this._generateSelector(el);
      if (css) candidates.push({ type: 'css', value: css });
      const name = el.getAttribute && el.getAttribute('name');
      if (name) candidates.push({ type: 'attr', value: `[name="${CSS.escape(name)}"]` });
      const title = el.getAttribute && el.getAttribute('title');
      if (title) candidates.push({ type: 'attr', value: `[title="${CSS.escape(title)}"]` });
      const alt = el.getAttribute && el.getAttribute('alt');
      if (alt) candidates.push({ type: 'attr', value: `[alt="${CSS.escape(alt)}"]` });
      const aria = el.getAttribute && el.getAttribute('aria-label');
      const role = el.getAttribute && el.getAttribute('role');
      if (aria) {
        if (role) candidates.push({ type: 'aria', value: `${role}[name=${aria}]` });
        else candidates.push({ type: 'aria', value: `textbox[name=${aria}]` });
      }
      const tag = el.tagName?.toLowerCase?.() || '';
      if (['button', 'a', 'summary'].includes(tag)) {
        const text = (el.textContent || '').trim();
        if (text) candidates.push({ type: 'text', value: text.substring(0, 64) });
      }
      const selector = SelectorEngine._choosePrimary(el, candidates);
      return { selector, candidates, tag };
    },

    _choosePrimary(el, candidates) {
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
        return `#${CSS.escape(el.id)}`;
      }
      const priority = ['attr', 'css'];
      for (const p of priority) {
        const c = candidates.find((c) => c.type === p);
        if (c) {
          try {
            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            if (p === 'attr' && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
              const val = String(c.value || '').trim();
              if (val.startsWith('[')) return `${tag}${val}`;
            }
          } catch {}
          return c.value;
        }
      }
      if (candidates.length) return candidates[0].value;
      return SelectorEngine._generateSelector(el) || '';
    },

    _uniqueClassSelector(el) {
      if (__cacheUnique.has(el)) return __cacheUnique.get(el);
      let result = '';
      try {
        const classes = Array.from(el.classList || []).filter(
          (c) => c && /^[a-zA-Z0-9_-]+$/.test(c),
        );
        for (const cls of classes) {
          const sel = `.${CSS.escape(cls)}`;
          if (document.querySelectorAll(sel).length === 1) {
            result = sel;
            break;
          }
        }
        if (!result) {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          for (const cls of classes) {
            const sel = `${tag}.${CSS.escape(cls)}`;
            if (document.querySelectorAll(sel).length === 1) {
              result = sel;
              break;
            }
          }
        }
        if (!result) {
          for (let i = 0; i < Math.min(classes.length, 3) && !result; i++) {
            for (let j = i + 1; j < Math.min(classes.length, 3); j++) {
              const sel = `.${CSS.escape(classes[i])}.${CSS.escape(classes[j])}`;
              if (document.querySelectorAll(sel).length === 1) {
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
      if (el.id) {
        const idSel = `#${CSS.escape(el.id)}`;
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      }
      for (const attr of ['data-testid', 'data-cy', 'name']) {
        const attrValue = el.getAttribute(attr);
        if (attrValue) {
          const s = `[${attr}="${CSS.escape(attrValue)}"]`;
          if (document.querySelectorAll(s).length === 1) return s;
        }
      }
      let path = '';
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName !== 'BODY') {
        let selector = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (child) => child.tagName === current.tagName,
          );
          if (siblings.length > 1) {
            const index = siblings.indexOf(current) + 1;
            selector += `:nth-of-type(${index})`;
          }
        }
        path = path ? `${selector} > ${path}` : selector;
        current = parent;
      }
      const res = path ? `body > ${path}` : 'body';
      __cachePath.set(el, res);
      return res;
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
