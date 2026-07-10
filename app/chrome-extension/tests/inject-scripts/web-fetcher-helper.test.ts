import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = (
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | void;

const HTML_LIMIT_BYTES = 512 * 1024;
const TEXT_LIMIT_BYTES = 100 * 1024;

function loadHelper(): RuntimeListener {
  delete (window as any).__WEB_FETCHER_HELPER_INITIALIZED__;
  vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
  const scriptPath = join(process.cwd(), 'inject-scripts', 'web-fetcher-helper.js');
  const source = readFileSync(scriptPath, 'utf8');
  runInThisContext(source, { filename: scriptPath });
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Web Fetcher helper did not register a listener');
  return listener as RuntimeListener;
}

function dispatch(listener: RuntimeListener, request: unknown): Promise<any> {
  return new Promise((resolve) => {
    listener(request, {} as chrome.runtime.MessageSender, resolve);
  });
}

describe('web-fetcher-helper resource boundaries', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    delete (window as any).__WEB_FETCHER_HELPER_INITIALIZED__;
    vi.restoreAllMocks();
  });

  it('rejects an oversized UTF-8 selector before querying the DOM', async () => {
    const querySelector = vi.spyOn(document, 'querySelector');
    const response = await dispatch(loadHelper(), {
      action: 'getHtmlContent',
      selector: '😀'.repeat(1025),
    });

    expect(response).toMatchObject({ success: false });
    expect(response.error).toContain('4096-byte UTF-8 limit');
    expect(querySelector).not.toHaveBeenCalled();
  });

  it('serializes HTML incrementally within the byte budget', async () => {
    const section = document.createElement('section');
    section.setAttribute('style', 'display:none');
    section.setAttribute('data-large', 'a'.repeat(20_000));
    section.append('😀'.repeat(150_000));
    const script = document.createElement('script');
    script.textContent = 'globalThis.__WEB_FETCHER_SCRIPT_RAN__ = true';
    section.append(script);
    document.body.append(section);

    const response = await dispatch(loadHelper(), { action: 'getHtmlContent' });
    const bytes = new TextEncoder().encode(response.htmlContent).byteLength;

    expect(response).toMatchObject({ success: true, truncated: true });
    expect(bytes).toBeLessThanOrEqual(HTML_LIMIT_BYTES);
    expect(response.htmlContent).not.toContain('style=');
    expect(response.htmlContent).not.toContain('<script');
    expect(response.htmlContent).toContain('</html>');
    expect(response.htmlContent).toContain('webpage-mcp: content truncated');
  });

  it('bounds selected text by UTF-8 bytes without reading innerText', async () => {
    const section = document.createElement('section');
    section.id = 'large';
    section.append('😀'.repeat(40_000));
    document.body.append(section);
    Object.defineProperty(section, 'innerText', {
      configurable: true,
      get: () => {
        throw new Error('innerText must not be materialized');
      },
    });

    const response = await dispatch(loadHelper(), {
      action: 'getTextContent',
      selector: '#large',
    });

    expect(response).toMatchObject({ success: true, truncated: true });
    expect(new TextEncoder().encode(response.textContent).byteLength).toBe(TEXT_LIMIT_BYTES);
  });

  it('preserves the document wrapper for selector HTML', async () => {
    document.body.innerHTML = '<section id="target"><strong>selected</strong></section>';

    const response = await dispatch(loadHelper(), {
      action: 'getHtmlContent',
      selector: '#target',
    });

    expect(response).toMatchObject({ success: true, truncated: false });
    expect(response.htmlContent).toBe(
      '<html><head></head><body><section id="target"><strong>selected</strong></section></body></html>',
    );
  });

  it('omits CSS-hidden text from selector extraction', async () => {
    document.body.innerHTML = `
      <section id="target">
        <span style="display: none">secret</span>
        <span>visible</span>
      </section>
    `;

    const response = await dispatch(loadHelper(), {
      action: 'getTextContent',
      selector: '#target',
    });

    expect(response).toMatchObject({ success: true });
    expect(response.textContent).toContain('visible');
    expect(response.textContent).not.toContain('secret');
  });

  it('rejects :has selectors before querying the DOM', async () => {
    const querySelector = vi.spyOn(document, 'querySelector');

    const response = await dispatch(loadHelper(), {
      action: 'getTextContent',
      selector: 'body:has(.target)',
    });

    expect(response).toMatchObject({ success: false });
    expect(response.error).toContain(':has()');
    expect(querySelector).not.toHaveBeenCalled();
  });

  it('rejects a result whose JSON encoding exceeds the message budget', async () => {
    document.body.append('\\'.repeat(400 * 1024));

    const response = await dispatch(loadHelper(), { action: 'getHtmlContent' });

    expect(response).toMatchObject({ success: false, truncated: true });
    expect(response.error).toContain('bounded extension message size');
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(
      700 * 1024,
    );
  });

  it('skips Readability cloning when the source byte budget is exceeded', async () => {
    document.body.append('x'.repeat(600 * 1024));
    const cloneNode = vi.spyOn(document, 'cloneNode');

    const response = await dispatch(loadHelper(), { action: 'getTextContent' });

    expect(response).toMatchObject({ success: true, fallback: true, truncated: true });
    expect(new TextEncoder().encode(response.textContent).byteLength).toBeLessThanOrEqual(
      TEXT_LIMIT_BYTES,
    );
    expect(cloneNode).not.toHaveBeenCalled();
  });

  it('counts comments before cloning the document for Readability', async () => {
    document.body.append(document.createComment('x'.repeat(600 * 1024)));
    document.body.append('bounded fallback');
    const cloneNode = vi.spyOn(document, 'cloneNode');

    const response = await dispatch(loadHelper(), { action: 'getTextContent' });

    expect(response).toMatchObject({
      success: true,
      fallback: true,
      truncated: true,
      textContent: 'bounded fallback',
    });
    expect(cloneNode).not.toHaveBeenCalled();
  });

  it('does not return Readability article HTML across the message boundary', async () => {
    document.body.innerHTML = `
      <article>
        <h1>Bounded article</h1>
        <p>${'Useful content. '.repeat(20)}</p>
      </article>
    `;

    const response = await dispatch(loadHelper(), { action: 'getTextContent' });

    expect(response).toMatchObject({ success: true, article: expect.any(Object) });
    expect(response.article).not.toHaveProperty('content');
  });

  it('reports metadata field truncation', async () => {
    const description = document.createElement('meta');
    description.name = 'description';
    description.content = 'm'.repeat(8 * 1024 + 1);
    document.head.append(description);
    document.body.innerHTML = `
      <article>
        <h1>Metadata article</h1>
        <p>${'Useful content. '.repeat(20)}</p>
      </article>
    `;

    const response = await dispatch(loadHelper(), { action: 'getTextContent' });

    expect(response).toMatchObject({ success: true, truncated: true });
    expect(response.metadata.description).toHaveLength(8 * 1024);
  });

  it('reports when the shared iframe extraction budget omits frames', async () => {
    document.body.innerHTML = `
      <article>
        <h1>Iframe article</h1>
        <p>${'Useful content. '.repeat(20)}</p>
      </article>
    `;
    for (let index = 0; index < 17; index += 1) {
      const iframe = document.createElement('iframe');
      iframe.getBoundingClientRect = () =>
        ({ width: 10, height: 10 } as DOMRect);
      document.body.append(iframe);
      if (iframe.contentDocument?.body) {
        iframe.contentDocument.body.textContent = `Embedded content ${index}`;
      }
    }

    const response = await dispatch(loadHelper(), { action: 'getTextContent' });

    expect(response).toMatchObject({ success: true, truncated: true });
  });
});
