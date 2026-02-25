/**
 * CSS Defaults Provider
 *
 * Computes baseline (browser-default) computed style values for element tag names.
 * Used by the CSS panel to hide active declarations that match defaults.
 *
 * Isolation strategy:
 * - Mount a hidden host element with `all: initial` into the document.
 * - Attach an isolated ShadowRoot and insert probe elements (one per tag name).
 * - Page author styles do not cross the shadow boundary, so probe values reflect UA defaults.
 */

export interface CssDefaultsProvider {
  /** Precompute/cache baseline values for a tag + set of properties. */
  ensureBaselineValues(tagName: string, properties: readonly string[]): void;
  /** Get baseline computed value for a tag + property (cached). */
  getBaselineValue(tagName: string, property: string): string;
  /** Cleanup DOM and caches. */
  dispose(): void;
}

interface ProbeRoot {
  host: HTMLDivElement;
  shadow: ShadowRoot;
  container: HTMLDivElement;
}

function normalizeTagName(tagName: string): string {
  return String(tagName ?? '')
    .trim()
    .toLowerCase();
}

function normalizePropertyName(property: string): string {
  return String(property ?? '').trim();
}

export function createCssDefaultsProvider(): CssDefaultsProvider {
  let disposed = false;
  let probeRoot: ProbeRoot | null = null;

  const probeByTag = new Map<string, Element>();
  const cacheByTag = new Map<string, Map<string, string>>();

  function ensureProbeRoot(): ProbeRoot | null {
    if (disposed) return null;
    if (typeof document === 'undefined') return null;

    if (probeRoot?.host?.isConnected) return probeRoot;

    const mountPoint = document.documentElement ?? document.body;
    if (!mountPoint) return null;

    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    // Use fixed size to avoid layout-dependent property issues
    // all: initial resets inherited styles, fixed positioning takes out of flow
    host.style.cssText =
      'all: initial;' +
      'display: block;' +
      'position: fixed;' +
      'left: -100000px;' +
      'top: 0;' +
      'width: 100px;' +
      'height: 100px;' +
      'overflow: hidden;' +
      'pointer-events: none;' +
      'contain: layout style paint;' +
      'z-index: -1;' +
      'visibility: hidden;';

    const shadow = host.attachShadow({ mode: 'open' });

    const container = document.createElement('div');
    container.style.cssText = 'all: initial; display: block;';
    shadow.append(container);

    mountPoint.append(host);
    probeRoot = { host, shadow, container };
    return probeRoot;
  }

  function ensureProbeElement(tagName: string): Element | null {
    const tag = normalizeTagName(tagName);
    if (!tag) return null;

    const existing = probeByTag.get(tag);
    if (existing?.isConnected) return existing;

    const root = ensureProbeRoot();
    if (!root) return null;

    let probe: Element;
    try {
      probe = document.createElement(tag);
    } catch {
      probe = document.createElement('div');
    }

    root.container.append(probe);
    probeByTag.set(tag, probe);
    return probe;
  }

  function ensureBaselineValues(tagName: string, properties: readonly string[]): void {
    const tag = normalizeTagName(tagName);
    if (!tag) return;

    const list = (properties ?? []).map((p) => normalizePropertyName(p)).filter(Boolean);
    if (list.length === 0) return;

    const perTag = cacheByTag.get(tag) ?? new Map<string, string>();
    if (!cacheByTag.has(tag)) cacheByTag.set(tag, perTag);

    const missing: string[] = [];
    for (const prop of list) {
      if (!perTag.has(prop)) missing.push(prop);
    }
    if (missing.length === 0) return;

    const probe = ensureProbeElement(tag);
    if (!probe) return;

    let computed: CSSStyleDeclaration | null = null;
    try {
      computed = window.getComputedStyle(probe);
    } catch {
      computed = null;
    }

    if (!computed) {
      for (const prop of missing) perTag.set(prop, '');
      return;
    }

    for (const prop of missing) {
      let value = '';
      try {
        value = String(computed.getPropertyValue(prop) ?? '').trim();
      } catch {
        value = '';
      }
      perTag.set(prop, value);
    }
  }

  function getBaselineValue(tagName: string, property: string): string {
    const tag = normalizeTagName(tagName);
    const prop = normalizePropertyName(property);
    if (!tag || !prop) return '';

    ensureBaselineValues(tag, [prop]);
    return cacheByTag.get(tag)?.get(prop) ?? '';
  }

  function dispose(): void {
    disposed = true;

    try {
      probeRoot?.host?.remove();
    } catch {
      // Best-effort
    }

    probeRoot = null;
    probeByTag.clear();
    cacheByTag.clear();
  }

  return {
    ensureBaselineValues,
    getBaselineValue,
    dispose,
  };
}
