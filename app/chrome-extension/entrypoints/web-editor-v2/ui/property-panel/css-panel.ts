/**
 * CSS Panel (Phase 4.6 + 4.7)
 *
 * Displays CSS rules and their sources for the selected element.
 * Similar to Chrome DevTools Styles panel.
 *
 * Features:
 * - Shows inline styles, matched CSS rules, and inherited styles
 * - Displays selector, specificity, and source file
 * - Shows which declarations are active vs overridden (strikethrough)
 * - Collapsible sections for inherited rules
 * - Supports Shadow DOM stylesheets
 * - Class editing with chips UI (Phase 4.7)
 */

import { Disposer } from '../../utils/disposables';
import type { TransactionManager } from '../../core/transaction-manager';
import type { DesignControl } from './types';
import { createClassEditor, MAX_SUGGESTION_CACHE, type ClassEditor } from './class-editor';
import { createCssDefaultsProvider, type CssDefaultsProvider } from './css-defaults';
import {
  collectCssPanelSnapshot,
  type CssPanelSnapshot,
  type CssSectionView,
  type CssRuleView,
  type CssDeclView,
} from '../../core/cssom-styles-collector';

// =============================================================================
// Types
// =============================================================================

export interface CssPanelOptions {
  /** Container element to mount the panel */
  container: HTMLElement;
  /** TransactionManager for class edits (Phase 4.7) */
  transactionManager?: TransactionManager;
  /** Notify parent that class list changed (e.g., refresh header label) */
  onClassChange?: () => void;
}

/** Extended interface for CSS panel with visibility control */
export interface CssPanel extends DesignControl {
  /** Notify the panel that it is now visible/hidden */
  setVisible(visible: boolean): void;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Format specificity as a human-readable string: (i, a, b, c)
 */
function formatSpecificity(spec: readonly [number, number, number, number] | undefined): string {
  if (!spec) return '';
  return `(${spec[0]}, ${spec[1]}, ${spec[2]}, ${spec[3]})`;
}

/**
 * Read class list from element (compatible with SVG elements)
 */
function readElementClasses(element: Element): string[] {
  try {
    const list = (element as HTMLElement).classList;
    if (list && typeof list[Symbol.iterator] === 'function') {
      return Array.from(list).filter(Boolean);
    }
  } catch {
    // Fall back to attribute parsing
  }

  try {
    const raw = element.getAttribute('class') ?? '';
    return raw
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Apply class list to element (compatible with SVG elements)
 */
function applyClassListToElement(element: Element, classes: readonly string[]): void {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of classes ?? []) {
    const token = String(raw ?? '').trim();
    if (!token) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    normalized.push(token);
  }

  const value = normalized.join(' ').trim();
  try {
    if (value) {
      element.setAttribute('class', value);
    } else {
      element.removeAttribute('class');
    }
  } catch {
    // Best-effort
  }
}

// =============================================================================
// Class Suggestions (Phase 4.7)
// =============================================================================

/**
 * Unescape CSS identifier (handles hex escapes and simple backslash escapes)
 *
 * Examples:
 * - 'sm\\:bg-red-500' -> 'sm:bg-red-500'
 * - '\\31 23' -> '123'
 */
function unescapeCssIdentifier(input: string): string {
  const s = String(input ?? '');
  let out = '';

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }

    // Trailing backslash - ignore
    if (i >= s.length - 1) break;

    let j = i + 1;
    let hex = '';

    // Collect hex digits (max 6)
    while (j < s.length && hex.length < 6 && /[0-9a-fA-F]/.test(s[j]!)) {
      hex += s[j]!;
      j += 1;
    }

    if (hex.length > 0) {
      const codePoint = Number.parseInt(hex, 16);
      // Validate code point is within Unicode range
      if (Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        out += String.fromCodePoint(codePoint);
        // Consume optional whitespace after hex escape
        if (j < s.length && /\s/.test(s[j]!)) j += 1;
        i = j - 1;
        continue;
      }
    }

    // Simple escape: take the next character literally
    out += s[j] ?? '';
    i = j;
  }

  return out;
}

/**
 * Consume a CSS class identifier starting at `start` position
 * Returns the end position (exclusive)
 */
function consumeClassIdent(selector: string, start: number): number {
  for (let i = start; i < selector.length; i++) {
    const ch = selector[i]!;

    if (ch === '\\') {
      // Skip escape sequence
      const next = i + 1;
      if (next >= selector.length) {
        // Trailing backslash - end of ident
        return selector.length;
      }

      // Check if next char is hex digit
      if (/[0-9a-fA-F]/.test(selector[next]!)) {
        // Hex escape: consume up to 6 hex digits
        let j = next;
        let hexCount = 0;
        while (j < selector.length && hexCount < 6 && /[0-9a-fA-F]/.test(selector[j]!)) {
          j += 1;
          hexCount += 1;
        }
        // Consume optional whitespace after hex escape
        if (j < selector.length && /\s/.test(selector[j]!)) {
          j += 1;
        }
        i = j - 1;
      } else {
        // Simple escape: skip the backslash and next character
        // This handles \: \/ \. etc.
        i = next;
      }
      continue;
    }

    // Terminators for ident in a selector context
    if (
      /\s/.test(ch) ||
      ch === '.' ||
      ch === '#' ||
      ch === ':' ||
      ch === '[' ||
      ch === ']' ||
      ch === '(' ||
      ch === ')' ||
      ch === ',' ||
      ch === '>' ||
      ch === '+' ||
      ch === '~' ||
      ch === '|'
    ) {
      return i;
    }
  }

  return selector.length;
}

/**
 * Extract class names from a CSS selector string
 * Handles CSS escapes (e.g., Tailwind's `sm\:bg-red-500`)
 */
function extractClassNamesFromSelector(selector: string): string[] {
  const out: string[] = [];
  const s = String(selector ?? '');

  let bracketDepth = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;

    // Track quoted strings (mostly inside attribute selectors)
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '[') {
      bracketDepth += 1;
      continue;
    }
    if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    // Ignore class-like tokens inside attribute selector bodies
    if (bracketDepth > 0) continue;

    // Look for class selector start
    if (ch !== '.') continue;

    const start = i + 1;
    if (start >= s.length) continue;

    const end = consumeClassIdent(s, start);
    const raw = s.slice(start, end);
    const cls = unescapeCssIdentifier(raw).trim();
    if (cls) out.push(cls);
    i = end - 1;
  }

  return out;
}

/**
 * Collect class suggestions from CSS snapshot
 * Extracts class names from matched selectors
 */
function collectClassSuggestions(snapshot: CssPanelSnapshot): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const section of snapshot.sections) {
    for (const rule of section.rules) {
      const selector = rule.matchedSelector ?? rule.selector;
      for (const cls of extractClassNamesFromSelector(selector)) {
        if (!cls) continue;
        if (seen.has(cls)) continue;
        seen.add(cls);
        out.push(cls);
        if (out.length >= MAX_SUGGESTION_CACHE) return out;
      }
    }
  }

  return out;
}

/**
 * Check if a declaration is a design token (CSS custom property)
 */
function isDesignToken(declName: string): boolean {
  return declName.trim().startsWith('--');
}

/**
 * Global/universal selectors to filter out (only show element-specific styles)
 */
const GLOBAL_SELECTORS = new Set(['*', 'html', 'body', ':root', ':where(*)', ':is(*)']);

/**
 * Check if a selector is a global/universal selector that should be filtered
 */
function isGlobalSelector(selector: string): boolean {
  const normalized = selector.trim().toLowerCase();
  if (GLOBAL_SELECTORS.has(normalized)) return true;
  // Also filter selectors that are just combinations of global selectors
  // e.g., "html *", "body *", "*, html", ":root *"
  const parts = normalized.split(/\s*,\s*/);
  return parts.every((part) => {
    const tokens = part.split(/\s+/).filter(Boolean);
    return tokens.every((t) => GLOBAL_SELECTORS.has(t) || t === '>' || t === '+' || t === '~');
  });
}

// =============================================================================
// Default Value Filtering
// =============================================================================

interface DefaultValueFilterContext {
  defaults: CssDefaultsProvider;
  tagName: string;
  computedStyle: CSSStyleDeclaration | null;
}

/**
 * Get the longhand properties affected by a declaration
 */
function getDeclAffectedProperties(decl: CssDeclView): readonly string[] {
  if (Array.isArray((decl as CssDeclView & { affects?: string[] }).affects)) {
    const affects = (decl as CssDeclView & { affects?: string[] }).affects;
    if (affects && affects.length > 0) return affects;
  }
  return [decl.name];
}

/**
 * Collect all properties that need baseline values for comparison
 */
function collectBaselineProperties(snapshot: CssPanelSnapshot): string[] {
  const out = new Set<string>();

  for (const section of snapshot.sections) {
    for (const rule of section.rules) {
      for (const decl of rule.decls) {
        if (decl.status !== 'active') continue;
        if (isDesignToken(decl.name)) continue;

        for (const prop of getDeclAffectedProperties(decl)) {
          const name = String(prop ?? '').trim();
          if (name) out.add(name);
        }
      }
    }
  }

  return Array.from(out);
}

/**
 * Check if an active declaration's computed value matches browser default
 */
function isDefaultValueDecl(decl: CssDeclView, ctx: DefaultValueFilterContext): boolean {
  if (decl.status !== 'active') return false;
  if (!ctx.computedStyle) return false;

  const props = getDeclAffectedProperties(decl);
  let hasComparable = false;

  for (const propRaw of props) {
    const prop = String(propRaw ?? '').trim();
    if (!prop) continue;

    let computed = '';
    try {
      computed = String(ctx.computedStyle.getPropertyValue(prop) ?? '').trim();
    } catch {
      computed = '';
    }

    const baseline = ctx.defaults.getBaselineValue(ctx.tagName, prop);
    if (computed || baseline) hasComparable = true;
    if (computed !== baseline) return false;
  }

  return hasComparable;
}

/**
 * Check if a declaration should be rendered (after all filters)
 */
function shouldRenderDecl(decl: CssDeclView, ctx: DefaultValueFilterContext): boolean {
  if (isDesignToken(decl.name)) return false;
  if (isDefaultValueDecl(decl, ctx)) return false;
  return true;
}

/**
 * Check if global selector filtering should apply for this element
 * Don't filter global selectors when the selected element is html/body itself
 */
function shouldFilterGlobalSelector(selector: string, tagName: string): boolean {
  if (!isGlobalSelector(selector)) return false;
  // If selected element is html/body/:root, don't filter their matching selectors
  const tag = tagName.toLowerCase();
  if (tag === 'html' || tag === 'body') return false;
  return true;
}

/**
 * Create a rule block element
 * Returns null if all declarations are filtered out (design tokens) or selector is global
 */
function createRuleBlock(
  rule: CssRuleView,
  disposer: Disposer,
  ctx: DefaultValueFilterContext,
): HTMLElement | null {
  // Filter out global selectors (*, html, body, etc.) - only keep element-specific styles
  const matchedSelector = rule.matchedSelector ?? rule.selector;
  if (rule.origin === 'rule' && shouldFilterGlobalSelector(matchedSelector, ctx.tagName)) {
    return null;
  }

  // Filter out design tokens and declarations matching browser defaults
  const visibleDecls = rule.decls.filter((decl) => shouldRenderDecl(decl, ctx));
  if (visibleDecls.length === 0) return null;

  const block = document.createElement('div');
  block.className = 'we-css-rule';
  block.dataset.ruleId = rule.id;
  block.dataset.origin = rule.origin;

  // Rule header: selector and source
  const header = document.createElement('div');
  header.className = 'we-css-rule-header';

  const selector = document.createElement('span');
  selector.className = 'we-css-rule-selector';
  selector.textContent = rule.matchedSelector ?? rule.selector;
  selector.title = rule.selector;

  header.append(selector);

  // Source info (file name or "element.style")
  if (rule.source) {
    const source = document.createElement('span');
    source.className = 'we-css-rule-source';
    source.textContent = rule.source.label;
    if (rule.source.url) {
      source.title = rule.source.url;
    }
    header.append(source);
  }

  // Specificity badge (optional, shown on hover or always for rules)
  if (rule.origin === 'rule' && rule.specificity) {
    const specBadge = document.createElement('span');
    specBadge.className = 'we-css-rule-spec';
    specBadge.textContent = formatSpecificity(rule.specificity);
    specBadge.title = 'Specificity (inline, id, class, type)';
    header.append(specBadge);
  }

  block.append(header);

  // Declarations list (filtered)
  const declsContainer = document.createElement('div');
  declsContainer.className = 'we-css-decls';

  for (const decl of visibleDecls) {
    const declEl = createDeclaration(decl);
    declsContainer.append(declEl);
  }

  block.append(declsContainer);

  return block;
}

/**
 * Create a declaration element
 */
function createDeclaration(decl: CssDeclView): HTMLElement {
  const el = document.createElement('div');
  el.className = 'we-css-decl';
  el.dataset.status = decl.status;

  // Property name
  const name = document.createElement('span');
  name.className = 'we-css-decl-name';
  name.textContent = decl.name;

  // Colon
  const colon = document.createElement('span');
  colon.className = 'we-css-decl-colon';
  colon.textContent = ': ';

  // Value container (for grid layout with !important outside truncated area)
  const valueContainer = document.createElement('span');
  valueContainer.className = 'we-css-decl-value-container';

  // Property value
  const value = document.createElement('span');
  value.className = 'we-css-decl-value';
  value.textContent = decl.value;
  valueContainer.append(value);

  // Important badge (separate element to avoid truncation)
  if (decl.important) {
    const imp = document.createElement('span');
    imp.className = 'we-css-decl-important';
    imp.textContent = '!important';
    valueContainer.append(imp);
  }

  // Semicolon
  const semi = document.createElement('span');
  semi.className = 'we-css-decl-semi';
  semi.textContent = ';';

  el.append(name, colon, valueContainer, semi);

  return el;
}

/**
 * Check if a rule has any renderable declarations (after filtering)
 */
function hasRenderableRule(rule: CssRuleView, ctx: DefaultValueFilterContext): boolean {
  // Filter out global selectors (unless selected element is html/body)
  const matchedSelector = rule.matchedSelector ?? rule.selector;
  if (rule.origin === 'rule' && shouldFilterGlobalSelector(matchedSelector, ctx.tagName)) {
    return false;
  }
  // Check if any declarations should be rendered
  return rule.decls.some((decl) => shouldRenderDecl(decl, ctx));
}

/**
 * Check if a section has any renderable rules (after filtering)
 */
function hasRenderableDecls(section: CssSectionView, ctx: DefaultValueFilterContext): boolean {
  return section.rules.some((rule) => hasRenderableRule(rule, ctx));
}

/**
 * Create a section element (inline, matched, or inherited)
 * Returns null if all rules are filtered out
 */
function createSection(
  section: CssSectionView,
  disposer: Disposer,
  ctx: DefaultValueFilterContext,
): HTMLElement | null {
  // Skip sections with no renderable declarations after filtering
  if (!hasRenderableDecls(section, ctx)) return null;

  const el = document.createElement('div');
  el.className = 'we-css-section';
  el.dataset.kind = section.kind;

  // Section header (for inherited sections)
  if (section.kind === 'inherited') {
    const header = document.createElement('div');
    header.className = 'we-css-section-header';

    const title = document.createElement('span');
    title.className = 'we-css-section-title';
    title.textContent = section.title;

    header.append(title);
    el.append(header);
  }

  // Rules
  const rulesContainer = document.createElement('div');
  rulesContainer.className = 'we-css-section-rules';

  for (const rule of section.rules) {
    const ruleEl = createRuleBlock(rule, disposer, ctx);
    if (ruleEl) rulesContainer.append(ruleEl);
  }

  // Defensive: if all rules were filtered out, return null
  if (rulesContainer.childElementCount === 0) return null;

  el.append(rulesContainer);

  return el;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a CSS Panel component
 */
export function createCssPanel(options: CssPanelOptions): CssPanel {
  const { container, transactionManager, onClassChange } = options;
  const disposer = new Disposer();

  // CSS defaults provider for filtering browser default values
  const defaultsProvider = createCssDefaultsProvider();
  disposer.add(() => defaultsProvider.dispose());

  // State
  let currentTarget: Element | null = null;
  let snapshot: CssPanelSnapshot | null = null;
  let classSuggestions: string[] = [];
  let classEditor: ClassEditor | null = null;
  let isVisible = false;
  let needsRefresh = false;

  // ==========================================================================
  // DOM Structure
  // ==========================================================================

  const root = document.createElement('div');
  root.className = 'we-css-panel';

  // Class editor mount point (Phase 4.7)
  const classEditorMount = document.createElement('div');
  classEditorMount.className = 'we-css-class-editor-mount';

  // Stats/info bar
  const infoBar = document.createElement('div');
  infoBar.className = 'we-css-info';
  infoBar.hidden = true;

  // Empty state
  const emptyState = document.createElement('div');
  emptyState.className = 'we-css-empty';
  emptyState.textContent = 'No styles';

  // Warnings container
  const warningsContainer = document.createElement('div');
  warningsContainer.className = 'we-css-warnings';
  warningsContainer.hidden = true;

  // Sections container
  const sectionsContainer = document.createElement('div');
  sectionsContainer.className = 'we-css-sections';

  // Create ClassEditor (Phase 4.7)
  classEditor = createClassEditor({
    container: classEditorMount,
    onClassChange: (nextClasses) => {
      const target = currentTarget;
      if (!target || !target.isConnected) return;

      const beforeClasses = readElementClasses(target);

      if (transactionManager) {
        // Use transaction manager for undo/redo support
        transactionManager.recordClass(target, beforeClasses, nextClasses);
      } else {
        // Fallback: apply directly without transaction
        applyClassListToElement(target, nextClasses);
      }

      // Sync UI with actual DOM state (in case normalized differently)
      classEditor?.setClasses(readElementClasses(target));

      // Notify parent (e.g., to update header label)
      onClassChange?.();

      // Refresh CSS rules (class change affects matched rules)
      collectAndRender();
    },
    getSuggestions: () => classSuggestions,
  });

  root.append(classEditorMount, infoBar, warningsContainer, emptyState, sectionsContainer);
  container.append(root);
  disposer.add(() => root.remove());

  // ==========================================================================
  // Render Functions
  // ==========================================================================

  function renderSnapshot(): void {
    // Clear previous content
    sectionsContainer.innerHTML = '';
    warningsContainer.innerHTML = '';

    if (!snapshot) {
      emptyState.hidden = false;
      emptyState.textContent = 'Select an element to view styles';
      infoBar.hidden = true;
      warningsContainer.hidden = true;
      return;
    }

    // Build filter context for default value comparison
    const tagName = currentTarget ? currentTarget.tagName.toLowerCase() : '';
    let computedStyle: CSSStyleDeclaration | null = null;
    try {
      if (currentTarget?.isConnected) {
        computedStyle = window.getComputedStyle(currentTarget);
      }
    } catch {
      computedStyle = null;
    }

    const filterCtx: DefaultValueFilterContext = {
      defaults: defaultsProvider,
      tagName,
      computedStyle,
    };

    // Pre-cache baseline values for all relevant properties
    if (computedStyle && tagName) {
      defaultsProvider.ensureBaselineValues(tagName, collectBaselineProperties(snapshot));
    }

    // Check if there are any renderable rules (after all filters)
    const hasRules = snapshot.sections.some((section) => hasRenderableDecls(section, filterCtx));

    if (!hasRules) {
      emptyState.hidden = false;
      emptyState.textContent = 'No CSS rules matched';
      infoBar.hidden = true;
    } else {
      emptyState.hidden = true;

      // Info bar
      const { stats } = snapshot;
      infoBar.textContent = `${stats.matchedRules} rules matched (${stats.styleSheets} stylesheets, ${stats.rulesScanned} rules scanned)`;
      infoBar.hidden = false;
    }

    // Render warnings (if any)
    if (snapshot.warnings.length > 0) {
      warningsContainer.hidden = false;
      for (const warning of snapshot.warnings.slice(0, 5)) {
        const warningEl = document.createElement('div');
        warningEl.className = 'we-css-warning';
        warningEl.textContent = warning;
        warningsContainer.append(warningEl);
      }
      if (snapshot.warnings.length > 5) {
        const more = document.createElement('div');
        more.className = 'we-css-warning-more';
        more.textContent = `...and ${snapshot.warnings.length - 5} more warnings`;
        warningsContainer.append(more);
      }
    } else {
      warningsContainer.hidden = true;
    }

    // Render sections
    for (const section of snapshot.sections) {
      const sectionEl = createSection(section, disposer, filterCtx);
      if (sectionEl) sectionsContainer.append(sectionEl);
    }
  }

  function collectAndRender(): void {
    // Only collect if visible (performance optimization)
    if (!isVisible) {
      needsRefresh = true;
      return;
    }

    if (!currentTarget || !currentTarget.isConnected) {
      snapshot = null;
      classSuggestions = [];
      classEditor?.setTarget(null);
      renderSnapshot();
      return;
    }

    // Collect snapshot (only direct styles, no inherited)
    snapshot = collectCssPanelSnapshot(currentTarget, {
      maxInheritanceDepth: 0,
    });

    // Update class suggestions cache (Phase 4.7)
    classSuggestions = snapshot ? collectClassSuggestions(snapshot) : [];

    renderSnapshot();
    needsRefresh = false;
  }

  // ==========================================================================
  // Public API (DesignControl interface)
  // ==========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;

    currentTarget = element;
    classEditor?.setTarget(element);
    collectAndRender();
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    classEditor?.refresh();
    collectAndRender();
  }

  function setVisible(visible: boolean): void {
    if (disposer.isDisposed) return;

    isVisible = visible;

    // If becoming visible and needs refresh, collect now
    if (visible && needsRefresh) {
      collectAndRender();
    }
  }

  function dispose(): void {
    currentTarget = null;
    snapshot = null;
    classEditor?.dispose();
    classEditor = null;
    classSuggestions = [];
    isVisible = false;
    needsRefresh = false;
    disposer.dispose();
  }

  // Initial state
  renderSnapshot();

  return {
    setTarget,
    refresh,
    setVisible,
    dispose,
  };
}
