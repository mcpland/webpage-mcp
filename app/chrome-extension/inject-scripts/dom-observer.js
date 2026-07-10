// dom-observer.js - observe bounded, explicitly scoped DOM triggers.
(function () {
  if (window.__RR_DOM_OBSERVER__) return;
  window.__RR_DOM_OBSERVER__ = true;

  // Keep these values aligned with domain/dom-trigger-policy.ts.
  const MAX_TRIGGERS = 32;
  const MAX_QUERIES_PER_CHECK = 16;
  const MAX_SELECTOR_UTF8_BYTES = 512;
  const MAX_SELECTOR_LIST_ITEMS = 4;
  const MAX_SELECTOR_COMBINATORS = 16;
  const MAX_SELECTOR_PSEUDOS = 16;
  const MAX_SELECTOR_NESTING = 4;
  const MIN_DEBOUNCE_MS = 250;
  const DEFAULT_DEBOUNCE_MS = 800;
  const MAX_DEBOUNCE_MS = 60000;
  const CHECK_COALESCE_MS = 50;

  const active = {
    triggers: [],
    hits: new Map(),
    cursor: 0,
    remainingQueries: 0,
    timer: null,
  };

  function now() {
    return Date.now();
  }

  function utf8ByteLength(value) {
    return new TextEncoder().encode(value).byteLength;
  }

  function hasControlCharacters(value) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
  }

  function normalizeSelector(value) {
    if (typeof value !== 'string') return '';
    const selector = value.trim();
    if (!selector || utf8ByteLength(selector) > MAX_SELECTOR_UTF8_BYTES) return '';
    if (hasControlCharacters(selector) || /[{};]/u.test(selector) || /:has\s*\(/iu.test(selector)) {
      return '';
    }
    if (/(?:^|,)\s*[>+~]|[>+~]\s*(?:$|,)|[>+~]\s*[>+~]/u.test(selector)) return '';

    let brackets = 0;
    let parentheses = 0;
    let listItems = 1;
    let combinators = 0;
    let pseudos = 0;
    let quote = '';
    let escaped = false;
    let pendingWhitespace = false;
    let hasToken = false;
    let previousWasCombinator = false;

    for (let index = 0; index < selector.length; index += 1) {
      const character = selector[index];
      if (escaped) {
        escaped = false;
        hasToken = true;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        hasToken = true;
        continue;
      }

      if (character === '[') brackets += 1;
      else if (character === ']') brackets -= 1;
      else if (character === '(') parentheses += 1;
      else if (character === ')') parentheses -= 1;
      if (
        brackets < 0 ||
        parentheses < 0 ||
        brackets > MAX_SELECTOR_NESTING ||
        parentheses > MAX_SELECTOR_NESTING
      ) {
        return '';
      }
      if (brackets !== 0 || parentheses !== 0) {
        hasToken = true;
        continue;
      }

      if (/\s/u.test(character)) {
        pendingWhitespace = hasToken && !previousWasCombinator;
        continue;
      }
      if (character === ',') {
        if (!hasToken || previousWasCombinator) return '';
        listItems += 1;
        hasToken = false;
        previousWasCombinator = false;
        pendingWhitespace = false;
        continue;
      }
      if (character === '>' || character === '+' || character === '~') {
        combinators += 1;
        previousWasCombinator = true;
        pendingWhitespace = false;
        continue;
      }
      if (pendingWhitespace) combinators += 1;
      if (character === ':') pseudos += 1;
      pendingWhitespace = false;
      previousWasCombinator = false;
      hasToken = true;
    }

    if (
      escaped ||
      quote ||
      brackets !== 0 ||
      parentheses !== 0 ||
      !hasToken ||
      previousWasCombinator ||
      listItems > MAX_SELECTOR_LIST_ITEMS ||
      combinators > MAX_SELECTOR_COMBINATORS ||
      pseudos > MAX_SELECTOR_PSEUDOS
    ) {
      return '';
    }

    try {
      document.querySelector(selector);
    } catch (_error) {
      return '';
    }
    return selector;
  }

  function normalizeTrigger(value) {
    if (!value || typeof value !== 'object') return null;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!id || id.length > 256) return null;
    const selector = normalizeSelector(value.selector);
    if (!selector) return null;
    const rawDebounce = Number(value.debounceMs);
    const debounceMs = Number.isFinite(rawDebounce)
      ? Math.min(MAX_DEBOUNCE_MS, Math.max(MIN_DEBOUNCE_MS, Math.floor(rawDebounce)))
      : DEFAULT_DEBOUNCE_MS;
    return {
      id,
      selector,
      appear: value.appear !== false,
      once: value.once !== false,
      debounceMs,
    };
  }

  function scheduleCheck() {
    if (active.triggers.length === 0) return;
    active.remainingQueries = Math.max(active.remainingQueries, active.triggers.length);
    if (active.timer !== null) return;
    active.timer = setTimeout(runCheckRound, CHECK_COALESCE_MS);
  }

  function applyTriggers(list) {
    const next = [];
    const seen = new Set();
    const candidates = Array.isArray(list) ? list.slice(0, MAX_TRIGGERS) : [];
    for (const candidate of candidates) {
      const trigger = normalizeTrigger(candidate);
      if (!trigger || seen.has(trigger.id)) continue;
      seen.add(trigger.id);
      next.push(trigger);
    }
    active.triggers = next;
    active.hits.clear();
    active.cursor = 0;
    active.remainingQueries = 0;
    if (active.timer !== null) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    scheduleCheck();
  }

  function removeTrigger(id) {
    active.triggers = active.triggers.filter((trigger) => trigger.id !== id);
    active.hits.delete(id);
    active.cursor = Math.min(active.cursor, Math.max(0, active.triggers.length - 1));
    active.remainingQueries = Math.min(active.remainingQueries, active.triggers.length);
  }

  function maybeFire(trigger) {
    let exists;
    try {
      exists = Boolean(document.querySelector(trigger.selector));
    } catch (_error) {
      removeTrigger(trigger.id);
      return;
    }

    const shouldFire = trigger.appear ? exists : !exists;
    if (!shouldFire) return;
    const last = active.hits.get(trigger.id);
    const timestamp = now();
    if (last !== undefined && timestamp - last < trigger.debounceMs) return;
    active.hits.set(trigger.id, timestamp);
    try {
      const result = chrome.runtime.sendMessage({
        action: 'dom_trigger_fired',
        triggerId: trigger.id,
        url: String(location.href).slice(0, 4096),
      });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_error) {}
    if (trigger.once) removeTrigger(trigger.id);
  }

  function runCheckRound() {
    active.timer = null;
    const count = Math.min(
      MAX_QUERIES_PER_CHECK,
      active.remainingQueries,
      active.triggers.length,
    );
    if (count <= 0) return;

    const snapshot = active.triggers.slice();
    const start = active.cursor % snapshot.length;
    const batch = [];
    for (let offset = 0; offset < count; offset += 1) {
      batch.push(snapshot[(start + offset) % snapshot.length]);
    }
    active.cursor = (start + count) % snapshot.length;
    active.remainingQueries = Math.max(0, active.remainingQueries - count);
    for (const trigger of batch) {
      if (active.triggers.some((candidate) => candidate.id === trigger.id)) {
        maybeFire(trigger);
      }
    }

    if (active.remainingQueries > 0 && active.triggers.length > 0) {
      active.timer = setTimeout(runCheckRound, CHECK_COALESCE_MS);
    }
  }

  const observer = new MutationObserver(scheduleCheck);
  try {
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    });
  } catch (_error) {}

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    try {
      if (request && request.action === 'dom_observer_ping') {
        sendResponse({ status: 'pong' });
        return false;
      }
      if (request && request.action === 'set_dom_triggers') {
        applyTriggers(request.triggers);
        sendResponse({ success: true, count: active.triggers.length });
        return false;
      }
    } catch (error) {
      sendResponse({
        success: false,
        error: String(error && error.message ? error.message : error),
      });
      return false;
    }
    return false;
  });
})();
