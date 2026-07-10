/**
 * Resource and selector policy shared by DOM trigger RPC, storage and handlers.
 *
 * The injected observer duplicates the browser-safe subset of these checks because
 * inject scripts are shipped as standalone files and cannot import this module.
 */
export const DOM_TRIGGER_LIMITS = Object.freeze({
  maxStoredTriggers: 256,
  maxTriggersPerTab: 32,
  maxQueriesPerCheck: 16,
  maxSelectorUtf8Bytes: 512,
  maxSelectorListItems: 4,
  maxSelectorCombinators: 16,
  maxSelectorPseudos: 16,
  maxSelectorNesting: 4,
  minDebounceMs: 250,
  defaultDebounceMs: 800,
  maxDebounceMs: 60_000,
} as const);

const HIGH_RISK_SELECTOR_PATTERN = /:has\s*\(/iu;
const INVALID_TOP_LEVEL_CHARACTER_PATTERN = /[{};]/u;
const EDGE_COMBINATOR_PATTERN = /(?:^|,)\s*[>+~]|[>+~]\s*(?:$|,)|[>+~]\s*[>+~]/u;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertStaticSelectorSyntax(selector: string, fieldName: string): void {
  if (hasControlCharacters(selector)) {
    throw new Error(`${fieldName} contains control characters`);
  }
  if (INVALID_TOP_LEVEL_CHARACTER_PATTERN.test(selector)) {
    throw new Error(`${fieldName} contains unsupported characters`);
  }
  if (HIGH_RISK_SELECTOR_PATTERN.test(selector)) {
    throw new Error(`${fieldName} must not use the high-risk :has() pseudo-class`);
  }
  if (EDGE_COMBINATOR_PATTERN.test(selector)) {
    throw new Error(`${fieldName} has invalid combinator placement`);
  }

  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let selectorListItems = 1;
  let combinators = 0;
  let pseudos = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let pendingWhitespace = false;
  let hasTokenInListItem = false;
  let previousWasExplicitCombinator = false;

  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];

    if (escaped) {
      escaped = false;
      hasTokenInListItem = true;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      hasTokenInListItem = true;
      continue;
    }

    if (character === '[') {
      bracketDepth += 1;
    } else if (character === ']') {
      bracketDepth -= 1;
      if (bracketDepth < 0) {
        throw new Error(`${fieldName} has unbalanced brackets`);
      }
    } else if (character === '(') {
      parenthesisDepth += 1;
    } else if (character === ')') {
      parenthesisDepth -= 1;
      if (parenthesisDepth < 0) {
        throw new Error(`${fieldName} has unbalanced parentheses`);
      }
    }

    if (
      bracketDepth > DOM_TRIGGER_LIMITS.maxSelectorNesting ||
      parenthesisDepth > DOM_TRIGGER_LIMITS.maxSelectorNesting
    ) {
      throw new Error(`${fieldName} nesting is too deep`);
    }

    if (bracketDepth !== 0 || parenthesisDepth !== 0) {
      hasTokenInListItem = true;
      continue;
    }

    if (/\s/u.test(character)) {
      pendingWhitespace = hasTokenInListItem && !previousWasExplicitCombinator;
      continue;
    }

    if (character === ',') {
      if (!hasTokenInListItem || previousWasExplicitCombinator) {
        throw new Error(`${fieldName} contains an empty selector list item`);
      }
      selectorListItems += 1;
      hasTokenInListItem = false;
      previousWasExplicitCombinator = false;
      pendingWhitespace = false;
      continue;
    }

    if (character === '>' || character === '+' || character === '~') {
      combinators += 1;
      previousWasExplicitCombinator = true;
      pendingWhitespace = false;
      continue;
    }

    if (pendingWhitespace) combinators += 1;
    if (character === ':') pseudos += 1;
    pendingWhitespace = false;
    previousWasExplicitCombinator = false;
    hasTokenInListItem = true;
  }

  if (escaped || quote || bracketDepth !== 0 || parenthesisDepth !== 0) {
    throw new Error(`${fieldName} has unterminated escaping, quoting, or grouping`);
  }
  if (!hasTokenInListItem || previousWasExplicitCombinator) {
    throw new Error(`${fieldName} contains an incomplete selector`);
  }
  if (selectorListItems > DOM_TRIGGER_LIMITS.maxSelectorListItems) {
    throw new Error(
      `${fieldName} must contain at most ${DOM_TRIGGER_LIMITS.maxSelectorListItems} selector list items`,
    );
  }
  if (combinators > DOM_TRIGGER_LIMITS.maxSelectorCombinators) {
    throw new Error(
      `${fieldName} must contain at most ${DOM_TRIGGER_LIMITS.maxSelectorCombinators} combinators`,
    );
  }
  if (pseudos > DOM_TRIGGER_LIMITS.maxSelectorPseudos) {
    throw new Error(
      `${fieldName} must contain at most ${DOM_TRIGGER_LIMITS.maxSelectorPseudos} pseudo selectors`,
    );
  }

  const cssApi = globalThis.CSS;
  if (
    typeof cssApi?.supports === 'function' &&
    !cssApi.supports(`selector(${selector})`)
  ) {
    throw new Error(`${fieldName} is not valid CSS selector syntax`);
  }
}

export function normalizeDomTriggerSelector(
  value: unknown,
  fieldName = 'trigger.selector',
): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} is required for dom triggers`);
  }
  const selector = value.trim();
  if (!selector) {
    throw new Error(`${fieldName} is required for dom triggers`);
  }
  if (utf8ByteLength(selector) > DOM_TRIGGER_LIMITS.maxSelectorUtf8Bytes) {
    throw new Error(
      `${fieldName} must be at most ${DOM_TRIGGER_LIMITS.maxSelectorUtf8Bytes} UTF-8 bytes`,
    );
  }
  assertStaticSelectorSyntax(selector, fieldName);
  return selector;
}

export function normalizeDomTriggerTabId(
  value: unknown,
  fieldName = 'trigger.tabId',
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

export function normalizeDomTriggerDebounceMs(value: unknown): number {
  if (value === undefined || value === null) {
    return DOM_TRIGGER_LIMITS.defaultDebounceMs;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('trigger.debounceMs must be a finite number');
  }
  return Math.min(
    DOM_TRIGGER_LIMITS.maxDebounceMs,
    Math.max(DOM_TRIGGER_LIMITS.minDebounceMs, Math.floor(value)),
  );
}
