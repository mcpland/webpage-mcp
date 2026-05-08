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
        const text = (el.textContent || '').trim();
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
      return { selector, candidates: ranked.slice(0, 3), tag };
    },

    _pushCandidate(candidates, candidate) {
      if (!candidate || !candidate.value) return;
      candidates.push(candidate);
    },

    _choosePrimary(el, candidates) {
      const id = el && el.getAttribute ? el.getAttribute('id') : '';
      if (id && this._isStableId(id)) {
        const idSel = `#${CSS.escape(id)}`;
        try {
          if (document.querySelectorAll(idSel).length === 1) return idSel;
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
          stability: Number(score.toFixed(3)),
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
        const count = document.querySelectorAll(value).length;
        if (count === 1) return true;
        if (el && count > 1) {
          try {
            return !!el.matches(value);
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
          const txt = lab && lab.textContent ? lab.textContent.trim() : '';
          if (txt) return txt;
        }
      } catch {}
      try {
        const parentLabel = el.closest && el.closest('label');
        const txt = parentLabel && parentLabel.textContent ? parentLabel.textContent.trim() : '';
        if (txt) return txt;
      } catch {}
      return '';
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
      const id = el.getAttribute && el.getAttribute('id');
      if (id && this._isStableId(id)) {
        const idSel = `#${CSS.escape(id)}`;
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      }
      for (const attr of ['data-testid', 'data-cy', 'data-qa', 'name']) {
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

    _generateXPath(el) {
      if (!(el instanceof Element)) return '';
      const segments = [];
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) {
          segments.unshift(tag);
          break;
        }
        const sameTagSiblings = Array.from(parent.children).filter((n) => n.tagName === current.tagName);
        const idx = sameTagSiblings.indexOf(current) + 1;
        segments.unshift(`${tag}[${idx}]`);
        current = parent;
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
