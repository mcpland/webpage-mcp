import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface AccessibilityTreeResult {
  pageContent: string;
  stats: { processed: number; included: number };
  refMap: unknown[];
  truncated: boolean;
  truncationReasons: string[];
}

function loadHelper(): (filter: 'all' | 'interactive' | null) => AccessibilityTreeResult {
  delete (window as any).__ACCESSIBILITY_TREE_HELPER_INITIALIZED__;
  delete (window as any).__generateAccessibilityTree;
  delete (window as any).__claudeElementMap;
  delete (window as any).__claudeElementRefs;
  delete (window as any).__claudeRefOrder;
  delete (window as any).__claudeRefCounter;
  const source = readFileSync(
    join(process.cwd(), 'inject-scripts', 'accessibility-tree-helper.js'),
    'utf8',
  );
  window.eval(source);
  const generate = (window as any).__generateAccessibilityTree;
  if (typeof generate !== 'function') {
    throw new Error('Accessibility tree helper did not expose its generator');
  }
  return generate;
}

describe('accessibility-tree-helper resource boundaries', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          top: 0,
          right: 20,
          bottom: 10,
          left: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(20);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(10);
  });

  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    delete (window as any).__ACCESSIBILITY_TREE_HELPER_INITIALIZED__;
    delete (window as any).__generateAccessibilityTree;
    vi.restoreAllMocks();
  });

  it('counts excluded nodes against the traversal budget', () => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 12_100; index += 1) {
      fragment.append(document.createElement('script'));
    }
    document.body.append(fragment);

    const result = loadHelper()('all');

    expect(result.stats.processed).toBe(12_000);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toContain('visited_nodes');
  });

  it('bounds page content and individual attacker-controlled attributes by UTF-8 bytes', () => {
    const fragment = document.createDocumentFragment();
    const oversized = `https://example.com/${'😀'.repeat(10_000)}`;
    for (let index = 0; index < 900; index += 1) {
      const link = document.createElement('a');
      link.id = `link-${index}`;
      link.href = oversized;
      link.setAttribute('aria-label', `Open ${index}`);
      fragment.append(link);
    }
    document.body.append(fragment);

    const result = loadHelper()('all');
    const bytes = new TextEncoder().encode(result.pageContent).byteLength;

    expect(bytes).toBeLessThanOrEqual(384 * 1024);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toContain('page_content_bytes');
    expect(result.pageContent).not.toContain('😀'.repeat(1000));
    expect(result.refMap.length).toBeLessThanOrEqual(256);
  });

  it('extracts labels without materializing subtree textContent', () => {
    const heading = document.createElement('h1');
    heading.append(document.createTextNode('Bounded heading'));
    Object.defineProperty(heading, 'textContent', {
      configurable: true,
      get: () => {
        throw new Error('textContent must not be materialized');
      },
    });
    document.body.append(heading);

    const result = loadHelper()('all');

    expect(result.pageContent).toContain('Bounded heading');
  });

  it('keeps refs stable without growing the live ref table on repeated reads', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Stable');
    document.body.append(button);
    const generate = loadHelper();

    const first = generate('all');
    const second = generate('all');

    expect(first.pageContent.match(/ref_\d+/)?.[0]).toBe(
      second.pageContent.match(/ref_\d+/)?.[0],
    );
    expect(Object.keys((window as any).__claudeElementMap)).toHaveLength(2);
  });
});
