/**
 * Token Detector (Phase 5.4)
 *
 * Scans CSSOM to discover CSS custom property declarations.
 *
 * Key features:
 * - Traverses document and shadow root stylesheets
 * - Handles @import, @media, @supports rules
 * - Gracefully handles cross-origin stylesheet restrictions
 * - Collects inline style custom properties from element ancestors
 *
 * Performance considerations:
 * - Uses lazy evaluation (only scans when needed)
 * - Limits declarations per token to prevent pathological cases
 * - Skips disabled stylesheets and non-matching media queries
 */

import type {
  CssVarName,
  RootCacheKey,
  RootType,
  StyleSheetRef,
  TokenDeclaration,
  TokenIndex,
  TokenIndexStats,
} from './types';

// =============================================================================
// Types
// =============================================================================

/** Options for creating a token detector */
export interface TokenDetectorOptions {
  /**
   * Maximum declarations stored per token name.
   * Prevents memory issues on pages with many overrides.
   * @default 50
   */
  maxDeclarationsPerToken?: number;

  /**
   * Maximum ancestor depth for inline style scanning.
   * @default 8
   */
  maxInlineDepth?: number;
}

/** Token detector public interface */
export interface TokenDetector {
  /**
   * Scan a root's stylesheets for token declarations.
   * This is the primary scanning method.
   */
  collectRootIndex(root: RootCacheKey): TokenIndex;

  /**
   * Discover token names from inline styles on element and ancestors.
   * Useful for finding dynamically set tokens not in stylesheets.
   */
  collectInlineTokenNames(element: Element, options?: { maxDepth?: number }): Set<CssVarName>;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_DECLARATIONS_PER_TOKEN = 50;
const DEFAULT_MAX_INLINE_DEPTH = 8;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a token detector instance.
 */
export function createTokenDetector(options: TokenDetectorOptions = {}): TokenDetector {
  const maxDeclarationsPerToken = Math.max(
    1,
    Math.floor(options.maxDeclarationsPerToken ?? DEFAULT_MAX_DECLARATIONS_PER_TOKEN),
  );
  const defaultInlineDepth = Math.max(
    0,
    Math.floor(options.maxInlineDepth ?? DEFAULT_MAX_INLINE_DEPTH),
  );

  // ===========================================================================
  // CSSOM Traversal Helpers
  // ===========================================================================

  /**
   * Safely read cssRules from a stylesheet.
   * Returns null if access is blocked (e.g., cross-origin).
   */
  function safeReadCssRules(sheet: CSSStyleSheet): CSSRuleList | null {
    try {
      return sheet.cssRules;
    } catch {
      return null;
    }
  }

  /**
   * Check if a stylesheet is applicable (not disabled, media matches).
   */
  function isSheetApplicable(sheet: CSSStyleSheet): boolean {
    if ((sheet as { disabled?: boolean }).disabled) return false;

    try {
      const mediaText = sheet.media?.mediaText?.trim() ?? '';
      if (!mediaText || mediaText.toLowerCase() === 'all') return true;
      return window.matchMedia(mediaText).matches;
    } catch {
      return true; // Assume applicable if we can't check
    }
  }

  /**
   * Create a human-readable reference to a stylesheet.
   */
  function describeStyleSheet(sheet: CSSStyleSheet, fallbackIndex: number): StyleSheetRef {
    const href = typeof sheet.href === 'string' ? sheet.href : undefined;
    if (href) {
      const file = href.split('/').pop()?.split('?')[0] ?? href;
      return { url: href, label: file };
    }

    const ownerNode = sheet.ownerNode as Node | null | undefined;
    if (ownerNode?.nodeType === Node.ELEMENT_NODE) {
      const el = ownerNode as Element;
      const tag = el.tagName.toLowerCase();
      return { label: `<${tag} #${fallbackIndex}>` };
    }

    return { label: `<constructed #${fallbackIndex}>` };
  }

  /**
   * Evaluate @media rule condition.
   */
  function evalMediaRule(rule: CSSMediaRule, warnings: string[]): boolean {
    try {
      const mediaText = rule.media?.mediaText?.trim() ?? '';
      if (!mediaText || mediaText.toLowerCase() === 'all') return true;
      return window.matchMedia(mediaText).matches;
    } catch (e) {
      warnings.push(`Failed to evaluate @media: ${String(e)}`);
      return false;
    }
  }

  /**
   * Evaluate @supports rule condition.
   */
  function evalSupportsRule(rule: CSSSupportsRule, warnings: string[]): boolean {
    try {
      const cond = rule.conditionText?.trim() ?? '';
      if (!cond) return true;
      if (typeof CSS?.supports !== 'function') return true;
      return CSS.supports(cond);
    } catch (e) {
      warnings.push(`Failed to evaluate @supports: ${String(e)}`);
      return false;
    }
  }

  /**
   * Extract custom property declarations from a style declaration.
   */
  function extractCustomProperties(
    style: CSSStyleDeclaration,
  ): Array<{ name: string; value: string; important: boolean }> {
    const results: Array<{ name: string; value: string; important: boolean }> = [];
    const len = Number(style?.length ?? 0);

    for (let i = 0; i < len; i++) {
      let name = '';
      try {
        name = String(style.item(i) ?? '').trim();
      } catch {
        continue;
      }

      if (!name.startsWith('--')) continue;

      let value = '';
      let important = false;
      try {
        value = String(style.getPropertyValue(name) ?? '').trim();
        important = style.getPropertyPriority(name) === 'important';
      } catch {
        // Keep empty value
      }

      results.push({ name, value, important });
    }

    return results;
  }

  // ===========================================================================
  // Main Collection Logic
  // ===========================================================================

  function collectRootIndex(root: RootCacheKey): TokenIndex {
    const rootType: RootType = root instanceof ShadowRoot ? 'shadow' : 'document';
    const warnings: string[] = [];
    const tokens = new Map<CssVarName, TokenDeclaration[]>();

    let rulesScanned = 0;
    let totalDeclarations = 0;
    let order = 0;

    /**
     * Add a declaration to the index.
     */
    function addDeclaration(decl: Omit<TokenDeclaration, 'order'>): void {
      const list = tokens.get(decl.name) ?? [];
      if (list.length >= maxDeclarationsPerToken) return;

      list.push({ ...decl, order: order++ });
      tokens.set(decl.name, list);
      totalDeclarations++;
    }

    /**
     * Recursively walk a rule list.
     */
    function walkRules(
      rules: CSSRuleList,
      context: {
        sheetIndex: number;
        source: StyleSheetRef;
        visited: Set<CSSStyleSheet>;
      },
    ): void {
      for (const rule of Array.from(rules)) {
        rulesScanned++;

        // @import rule
        if (rule.type === CSSRule.IMPORT_RULE) {
          const importRule = rule as CSSImportRule;
          const imported = importRule.styleSheet;

          if (imported && !context.visited.has(imported)) {
            // Check @import media condition (align with cssom-styles-collector)
            try {
              const importMedia = importRule.media?.mediaText?.trim() ?? '';
              if (importMedia && importMedia.toLowerCase() !== 'all') {
                if (!window.matchMedia(importMedia).matches) {
                  continue; // Skip non-matching @import media
                }
              }
            } catch {
              // Ignore media evaluation errors, proceed with import
            }

            if (!isSheetApplicable(imported)) continue;

            const importedRules = safeReadCssRules(imported);
            const importSource = describeStyleSheet(imported, context.sheetIndex);

            if (!importedRules) {
              warnings.push(
                `Skipped @import (cross-origin): ${importSource.url ?? importSource.label}`,
              );
              continue;
            }

            context.visited.add(imported);
            try {
              walkRules(importedRules, {
                ...context,
                source: importSource,
              });
            } finally {
              context.visited.delete(imported);
            }
          }
          continue;
        }

        // @media rule
        if (rule.type === CSSRule.MEDIA_RULE) {
          if (evalMediaRule(rule as CSSMediaRule, warnings)) {
            walkRules((rule as CSSMediaRule).cssRules, context);
          }
          continue;
        }

        // @supports rule
        if (rule.type === CSSRule.SUPPORTS_RULE) {
          if (evalSupportsRule(rule as CSSSupportsRule, warnings)) {
            walkRules((rule as CSSSupportsRule).cssRules, context);
          }
          continue;
        }

        // Style rule
        if (rule.type === CSSRule.STYLE_RULE) {
          const styleRule = rule as CSSStyleRule;
          const selectorText = String(styleRule.selectorText ?? '').trim() || undefined;
          const customProps = extractCustomProperties(styleRule.style);

          for (const prop of customProps) {
            addDeclaration({
              name: prop.name as CssVarName,
              value: prop.value,
              important: prop.important,
              origin: 'rule',
              rootType,
              styleSheet: context.source,
              selectorText,
            });
          }
          continue;
        }

        // Best-effort: traverse other grouping rules
        const anyRule = rule as { cssRules?: CSSRuleList };
        if (anyRule.cssRules?.length) {
          try {
            walkRules(anyRule.cssRules, context);
          } catch {
            // Ignore errors in unknown rule types
          }
        }
      }
    }

    // Collect stylesheets from root
    const docOrShadow = root as DocumentOrShadowRoot;
    const styleSheets: CSSStyleSheet[] = [];

    try {
      for (const s of Array.from(docOrShadow.styleSheets ?? [])) {
        if (s instanceof CSSStyleSheet) styleSheets.push(s);
      }
    } catch {
      // Ignore access errors
    }

    try {
      const adopted = Array.from(docOrShadow.adoptedStyleSheets ?? []);
      for (const s of adopted) {
        if (s instanceof CSSStyleSheet) styleSheets.push(s);
      }
    } catch {
      // adoptedStyleSheets may not be supported
    }

    // Process each stylesheet
    for (let sheetIndex = 0; sheetIndex < styleSheets.length; sheetIndex++) {
      const sheet = styleSheets[sheetIndex]!;
      if (!isSheetApplicable(sheet)) continue;

      const sheetSource = describeStyleSheet(sheet, sheetIndex);
      const cssRules = safeReadCssRules(sheet);

      if (!cssRules) {
        warnings.push(`Skipped stylesheet (cross-origin): ${sheetSource.url ?? sheetSource.label}`);
        continue;
      }

      const visited = new Set<CSSStyleSheet>([sheet]);
      walkRules(cssRules, {
        sheetIndex,
        source: sheetSource,
        visited,
      });
    }

    const stats: TokenIndexStats = {
      styleSheets: styleSheets.length,
      rulesScanned,
      tokens: tokens.size,
      declarations: totalDeclarations,
    };

    return {
      rootType,
      tokens,
      warnings: [...new Set(warnings)], // Deduplicate
      stats,
    };
  }

  // ===========================================================================
  // Inline Style Collection
  // ===========================================================================

  /**
   * Get parent element, crossing shadow boundaries if needed.
   */
  function getParentElementOrHost(element: Element): Element | null {
    if (element.parentElement) return element.parentElement;

    try {
      const root = element.getRootNode?.();
      if (root instanceof ShadowRoot) return root.host;
    } catch {
      // Ignore errors
    }

    return null;
  }

  function collectInlineTokenNames(
    element: Element,
    options?: { maxDepth?: number },
  ): Set<CssVarName> {
    const maxDepth = Math.max(0, Math.floor(options?.maxDepth ?? defaultInlineDepth));
    const result = new Set<CssVarName>();

    let current: Element | null = element;
    let depth = 0;

    while (current && depth <= maxDepth) {
      depth++;

      try {
        const style = (current as HTMLElement).style;
        if (style) {
          const len = Number(style.length ?? 0);
          for (let i = 0; i < len; i++) {
            const name = String(style.item(i) ?? '').trim();
            if (name.startsWith('--')) {
              result.add(name as CssVarName);
            }
          }
        }
      } catch {
        // Ignore access errors
      }

      // Always advance to parent (fixes potential infinite loop)
      current = getParentElementOrHost(current);
    }

    return result;
  }

  return {
    collectRootIndex,
    collectInlineTokenNames,
  };
}
