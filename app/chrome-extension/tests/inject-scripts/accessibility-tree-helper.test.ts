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

type RuntimeListener = (
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

function loadHelper(): (filter: 'all' | 'interactive' | null) => AccessibilityTreeResult {
  delete (window as any).__ACCESSIBILITY_TREE_HELPER_INITIALIZED__;
  delete (window as any).__generateAccessibilityTree;
  delete (window as any).__claudeElementMap;
  delete (window as any).__claudeElementRefs;
  delete (window as any).__claudeRefOrder;
  delete (window as any).__claudeRefCounter;
  vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
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

function getRuntimeListener(): RuntimeListener {
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Accessibility tree helper did not register a listener');
  return listener as RuntimeListener;
}

function dispatch(listener: RuntimeListener, request: unknown): Promise<any> {
  return new Promise((resolve) => {
    listener(request, {} as chrome.runtime.MessageSender, resolve);
  });
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

  it('checks CSS uniqueness without materializing querySelectorAll snapshots', async () => {
    document.body.innerHTML = '<button class="target">One</button><button class="target">Two</button>';
    const documentQueryAll = vi.spyOn(document, 'querySelectorAll');
    const shadowQueryAll = vi.spyOn(ShadowRoot.prototype, 'querySelectorAll');
    loadHelper();

    const response = await dispatch(getRuntimeListener(), {
      action: 'ensureRefForSelector',
      selector: '.target',
    });

    expect(response).toMatchObject({ success: false });
    expect(response.error).toContain('matched multiple elements');
    expect(documentQueryAll).not.toHaveBeenCalled();
    expect(shadowQueryAll).not.toHaveBeenCalled();
  });

  it('reads at most two XPath iterator results instead of a full snapshot', async () => {
    document.body.innerHTML = '<button>One</button><button>Two</button>';
    const evaluate = vi.spyOn(document, 'evaluate');
    loadHelper();

    const response = await dispatch(getRuntimeListener(), {
      action: 'ensureRefForSelector',
      selector: '//button',
      isXPath: true,
    });

    expect(response).toMatchObject({ success: false });
    expect(response.error).toContain('matched multiple elements');
    expect(evaluate).toHaveBeenCalledWith(
      '//button',
      document,
      null,
      XPathResult.ORDERED_NODE_ITERATOR_TYPE,
      null,
    );
    expect(evaluate.mock.calls.some((call) => call[3] === XPathResult.ORDERED_NODE_SNAPSHOT_TYPE)).toBe(
      false,
    );
  });

  it('resolves text incrementally without reading subtree textContent', async () => {
    const button = document.createElement('button');
    button.append(document.createTextNode('Bounded target'));
    Object.defineProperty(button, 'textContent', {
      configurable: true,
      get: () => {
        throw new Error('textContent must not be materialized');
      },
    });
    document.body.append(button);
    loadHelper();

    const response = await dispatch(getRuntimeListener(), {
      action: 'ensureRefForSelector',
      useText: true,
      text: 'Bounded target',
      tagName: 'button',
    });

    expect(response).toMatchObject({ success: true, ref: expect.stringMatching(/^ref_\d+$/) });
  });

  it('rejects oversized selectors before any page traversal', async () => {
    const matches = vi.spyOn(Element.prototype, 'matches');
    loadHelper();

    const response = await dispatch(getRuntimeListener(), {
      action: 'ensureRefForSelector',
      selector: `#${'a'.repeat(4097)}`,
    });

    expect(response).toMatchObject({ success: false });
    expect(response.error).toContain('4096-byte UTF-8 limit');
    expect(matches).not.toHaveBeenCalled();
  });

  it('bounds attribute and text extraction responses', async () => {
    const section = document.createElement('section');
    section.id = 'large-text';
    section.append(document.createTextNode('😀'.repeat(100_000)));
    Object.defineProperty(section, 'textContent', {
      configurable: true,
      get: () => {
        throw new Error('textContent must not be materialized');
      },
    });
    document.body.append(section);
    loadHelper();

    const response = await dispatch(getRuntimeListener(), {
      action: 'getAttributeForSelector',
      selector: '#large-text',
      name: 'textContent',
    });

    expect(response.success).toBe(true);
    expect(new TextEncoder().encode(response.value).byteLength).toBeLessThanOrEqual(64 * 1024);
  });

  it('uses bounded selector generation when resolving a ref', async () => {
    const button = document.createElement('button');
    button.id = 'resolve-target';
    button.setAttribute('aria-label', 'Resolve');
    document.body.append(button);
    const generate = loadHelper();
    const ref = generate('all')
      .pageContent.split('\n')
      .find((line) => line.includes('Resolve'))
      ?.match(/ref_\d+/)?.[0];
    const queryAll = vi.spyOn(document, 'querySelectorAll');

    const response = await dispatch(getRuntimeListener(), {
      action: 'resolveRef',
      ref,
    });

    expect(response).toMatchObject({ success: true, selector: '#resolve-target' });
    expect(queryAll).not.toHaveBeenCalled();
  });

  it('contains no snapshot-producing querySelectorAll calls in target paths', () => {
    const source = readFileSync(
      join(process.cwd(), 'inject-scripts', 'accessibility-tree-helper.js'),
      'utf8',
    );

    expect(source).not.toContain('querySelectorAll(');
    expect(source).not.toContain('ORDERED_NODE_SNAPSHOT_TYPE');
  });
});
