/**
 * Assert Action Handler
 *
 * Validates page state against specified conditions:
 * - exists: Selector can be resolved to an element
 * - visible: Element exists and has non-zero dimensions
 * - textPresent: Text appears in the page content
 * - attribute: Element attribute equals/matches/exists
 */

import { failed, invalid, ok, tryResolveString } from '../registry';
import type { ActionHandler, Assertion, VariableStore } from '../types';

/** Default timeout for polling assertions (ms) */
const DEFAULT_ASSERT_TIMEOUT_MS = 5000;

/** Polling interval for retry assertions (ms) */
const POLL_INTERVAL_MS = 200;

/** Maximum attribute name length */
const MAX_ATTR_NAME_LENGTH = 256;

/**
 * Validates assertion configuration at build time
 */
function validateAssertion(assert: Assertion): { ok: true } | { ok: false; error: string } {
  switch (assert.kind) {
    case 'exists':
    case 'visible':
      if (assert.selector === undefined) {
        return { ok: false, error: `Assertion "${assert.kind}" requires a selector` };
      }
      break;

    case 'textPresent':
      if (assert.text === undefined) {
        return { ok: false, error: 'Assertion "textPresent" requires a text value' };
      }
      break;

    case 'attribute':
      if (assert.selector === undefined) {
        return { ok: false, error: 'Assertion "attribute" requires a selector' };
      }
      if (assert.name === undefined) {
        return { ok: false, error: 'Assertion "attribute" requires an attribute name' };
      }
      // Must have at least equals or matches (or neither for existence check)
      break;

    default: {
      const exhaustive: never = assert;
      return { ok: false, error: `Unknown assertion kind: ${(exhaustive as Assertion).kind}` };
    }
  }

  return { ok: true };
}

/**
 * Resolve assertion parameters at runtime
 */
function resolveAssertionParams(
  assert: Assertion,
  vars: VariableStore,
): { ok: true; resolved: ResolvedAssertion } | { ok: false; error: string } {
  switch (assert.kind) {
    case 'exists':
    case 'visible': {
      const selectorResult = tryResolveString(assert.selector, vars);
      if (!selectorResult.ok) return selectorResult;
      const selector = selectorResult.value.trim();
      if (!selector) return { ok: false, error: `Empty selector for "${assert.kind}" assertion` };
      return {
        ok: true,
        resolved: { kind: assert.kind, selector },
      };
    }

    case 'textPresent': {
      const textResult = tryResolveString(assert.text, vars);
      if (!textResult.ok) return textResult;
      const text = textResult.value;
      if (!text) return { ok: false, error: 'Empty text for "textPresent" assertion' };
      return {
        ok: true,
        resolved: { kind: 'textPresent', text },
      };
    }

    case 'attribute': {
      const selectorResult = tryResolveString(assert.selector, vars);
      if (!selectorResult.ok) return selectorResult;
      const selector = selectorResult.value.trim();
      if (!selector) return { ok: false, error: 'Empty selector for "attribute" assertion' };

      const nameResult = tryResolveString(assert.name, vars);
      if (!nameResult.ok) return nameResult;
      const attrName = nameResult.value.trim();
      if (!attrName) return { ok: false, error: 'Empty attribute name' };
      if (attrName.length > MAX_ATTR_NAME_LENGTH) {
        return { ok: false, error: `Attribute name exceeds ${MAX_ATTR_NAME_LENGTH} characters` };
      }

      let equals: string | undefined;
      let matches: string | undefined;

      if (assert.equals !== undefined) {
        const equalsResult = tryResolveString(assert.equals, vars);
        if (!equalsResult.ok) return equalsResult;
        equals = equalsResult.value;
      }

      if (assert.matches !== undefined) {
        const matchesResult = tryResolveString(assert.matches, vars);
        if (!matchesResult.ok) return matchesResult;
        matches = matchesResult.value;
        // Validate regex
        try {
          new RegExp(matches);
        } catch {
          return { ok: false, error: `Invalid regex pattern: ${matches}` };
        }
      }

      return {
        ok: true,
        resolved: { kind: 'attribute', selector, attrName, equals, matches },
      };
    }
  }
}

/**
 * Resolved assertion with all variables interpolated
 */
type ResolvedAssertion =
  | { kind: 'exists'; selector: string }
  | { kind: 'visible'; selector: string }
  | { kind: 'textPresent'; text: string }
  | { kind: 'attribute'; selector: string; attrName: string; equals?: string; matches?: string };

/**
 * Execute assertion check in page context
 */
async function checkAssertionInPage(
  tabId: number,
  frameId: number | undefined,
  resolved: ResolvedAssertion,
): Promise<{ passed: boolean; message?: string }> {
  const frameIds = typeof frameId === 'number' ? [frameId] : undefined;

  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, frameIds } as chrome.scripting.InjectionTarget,
      world: 'MAIN',
      func: (assertion: ResolvedAssertion) => {
        try {
          switch (assertion.kind) {
            case 'exists': {
              const el = document.querySelector(assertion.selector);
              return el ? { passed: true } : { passed: false, message: 'Element not found' };
            }

            case 'visible': {
              const el = document.querySelector(assertion.selector);
              if (!el) return { passed: false, message: 'Element not found' };
              const rect = el.getBoundingClientRect();
              const hasSize = rect.width > 0 && rect.height > 0;
              if (!hasSize) return { passed: false, message: 'Element has zero dimensions' };

              // Check if element is visible in viewport
              const style = window.getComputedStyle(el);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.opacity === '0'
              ) {
                return { passed: false, message: 'Element is hidden via CSS' };
              }
              return { passed: true };
            }

            case 'textPresent': {
              const text = assertion.text;
              const bodyText = document.body?.textContent || '';
              if (bodyText.includes(text)) return { passed: true };
              return { passed: false, message: `Text "${text}" not found in page` };
            }

            case 'attribute': {
              const el = document.querySelector(assertion.selector);
              if (!el) return { passed: false, message: 'Element not found' };

              const attrValue = el.getAttribute(assertion.attrName);

              // Check existence only
              if (assertion.equals === undefined && assertion.matches === undefined) {
                return attrValue !== null
                  ? { passed: true }
                  : { passed: false, message: `Attribute "${assertion.attrName}" not found` };
              }

              // Check equals
              if (assertion.equals !== undefined) {
                if (attrValue === assertion.equals) return { passed: true };
                return {
                  passed: false,
                  message: `Attribute "${assertion.attrName}" is "${attrValue}", expected "${assertion.equals}"`,
                };
              }

              // Check matches (regex)
              if (assertion.matches !== undefined) {
                if (attrValue === null) {
                  return { passed: false, message: `Attribute "${assertion.attrName}" not found` };
                }
                const regex = new RegExp(assertion.matches);
                if (regex.test(attrValue)) return { passed: true };
                return {
                  passed: false,
                  message: `Attribute "${assertion.attrName}" value "${attrValue}" does not match pattern "${assertion.matches}"`,
                };
              }

              return { passed: true };
            }
          }
        } catch (e) {
          return { passed: false, message: e instanceof Error ? e.message : String(e) };
        }
      },
      args: [resolved],
    });

    const result = Array.isArray(injected) ? injected[0]?.result : undefined;
    if (!result || typeof result !== 'object') {
      return { passed: false, message: 'Assertion script returned invalid result' };
    }

    return result as { passed: boolean; message?: string };
  } catch (e) {
    return {
      passed: false,
      message: `Script execution failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Poll assertion until it passes or timeout
 */
async function pollAssertion(
  tabId: number,
  frameId: number | undefined,
  resolved: ResolvedAssertion,
  timeoutMs: number,
): Promise<{ passed: boolean; message?: string }> {
  const startTime = Date.now();
  let lastResult: { passed: boolean; message?: string } = {
    passed: false,
    message: 'Timeout before first check',
  };

  while (Date.now() - startTime < timeoutMs) {
    lastResult = await checkAssertionInPage(tabId, frameId, resolved);
    if (lastResult.passed) return lastResult;

    // Wait before next poll
    const remaining = timeoutMs - (Date.now() - startTime);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
    }
  }

  return {
    passed: false,
    message: `${lastResult.message || 'Assertion failed'} (timeout: ${timeoutMs}ms)`,
  };
}

export const assertHandler: ActionHandler<'assert'> = {
  type: 'assert',

  validate: (action) => {
    const validation = validateAssertion(action.params.assert);
    if (!validation.ok) {
      return invalid(validation.error);
    }
    return ok();
  },

  describe: (action) => {
    const assert = action.params.assert;
    switch (assert.kind) {
      case 'exists':
        return `Assert exists: ${truncate(String(assert.selector), 30)}`;
      case 'visible':
        return `Assert visible: ${truncate(String(assert.selector), 30)}`;
      case 'textPresent':
        return `Assert text: "${truncate(String(assert.text), 25)}"`;
      case 'attribute':
        return `Assert attr: ${truncate(String(assert.name), 15)}`;
      default:
        return 'Assert';
    }
  },

  run: async (ctx, action) => {
    const tabId = ctx.tabId;
    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found for assert action');
    }

    // Resolve assertion parameters
    const resolved = resolveAssertionParams(action.params.assert, ctx.vars);
    if (!resolved.ok) {
      return failed('VALIDATION_ERROR', resolved.error);
    }

    // Determine timeout from policy or default
    const timeoutMs = action.policy?.timeout?.ms ?? DEFAULT_ASSERT_TIMEOUT_MS;
    const failStrategy = action.params.failStrategy ?? 'stop';

    // Execute assertion with polling
    const result = await pollAssertion(tabId, ctx.frameId, resolved.resolved, timeoutMs);

    if (result.passed) {
      return { status: 'success' };
    }

    // Handle failure based on strategy
    const errorMessage = result.message || 'Assertion failed';

    switch (failStrategy) {
      case 'warn':
        ctx.log(`Assertion warning: ${errorMessage}`, 'warn');
        return { status: 'success' };

      case 'retry':
        // Return failed with retryable error code
        // The scheduler should handle retry based on policy
        return failed('ASSERTION_FAILED', errorMessage);

      case 'stop':
      default:
        return failed('ASSERTION_FAILED', errorMessage);
    }
  },
};

/** Truncate string for display */
function truncate(str: string, maxLen: number): string {
  if (typeof str !== 'string') return '(dynamic)';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}
