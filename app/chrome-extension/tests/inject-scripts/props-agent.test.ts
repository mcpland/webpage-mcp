import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUEST_EVENT = 'web-editor-props:request';
const RESPONSE_EVENT = 'web-editor-props:response';
const AGENT_KEY = '__MCP_WEB_EDITOR_PROPS_AGENT__';
const REACT_HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

let hadReactHook = false;
let originalReactHook: unknown;

function loadAgent(): void {
  delete (window as any)[AGENT_KEY];
  const source = readFileSync(join(process.cwd(), 'inject-scripts', 'props-agent.js'), 'utf8');
  window.eval(source);
  if (!(window as any)[AGENT_KEY]) throw new Error('Props agent did not initialize');
}

function request(locator: Record<string, unknown>): any {
  let response: any;
  const onResponse = (event: Event) => {
    response = (event as CustomEvent).detail;
  };
  window.addEventListener(RESPONSE_EVENT, onResponse, { once: true });
  window.dispatchEvent(
    new CustomEvent(REQUEST_EVENT, {
      detail: {
        v: 1,
        requestId: 'request-1',
        op: 'read',
        locator,
      },
    }),
  );
  window.removeEventListener(RESPONSE_EVENT, onResponse);
  if (!response) throw new Error('Props agent did not respond');
  return response;
}

describe('props-agent locator resource boundaries', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    hadReactHook = Object.prototype.hasOwnProperty.call(window, REACT_HOOK_KEY);
    originalReactHook = (window as any)[REACT_HOOK_KEY];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    try {
      (window as any)[AGENT_KEY]?.dispose();
    } catch {
      // Best effort cleanup for a partially initialized agent.
    }
    delete (window as any)[AGENT_KEY];
    if (hadReactHook) (window as any)[REACT_HOOK_KEY] = originalReactHook;
    else delete (window as any)[REACT_HOOK_KEY];
    document.documentElement.innerHTML = '<head></head><body></body>';
    vi.restoreAllMocks();
  });

  it('stops at the second selector match without materializing all matches', () => {
    document.body.innerHTML =
      '<button class="duplicate"></button><button class="duplicate"></button><button class="duplicate"></button>';
    const nativeMatches = Element.prototype.matches;
    let matchingResults = 0;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (selector: string) {
      const matched = nativeMatches.call(this, selector);
      if (matched) matchingResults += 1;
      return matched;
    });
    const documentQueryAll = vi.spyOn(document, 'querySelectorAll');
    const shadowQueryAll = vi.spyOn(ShadowRoot.prototype, 'querySelectorAll');
    loadAgent();

    const response = request({ selectors: ['.duplicate'] });

    expect(response).toMatchObject({ success: false, error: 'Target element not found' });
    expect(matchingResults).toBe(2);
    expect(documentQueryAll).not.toHaveBeenCalled();
    expect(shadowQueryAll).not.toHaveBeenCalled();
  });

  it('locates a unique element with one bounded traversal', () => {
    const target = document.createElement('button');
    target.id = 'unique-target';
    document.body.append(target);
    loadAgent();

    const response = request({ selectors: ['#unique-target'] });

    expect(response).toMatchObject({ success: false, error: 'Not a React component' });
  });

  it('shares a 12,000-element budget across selector candidates', () => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 12_100; index += 1) {
      fragment.append(document.createElement('div'));
    }
    const target = document.createElement('button');
    target.id = 'late-target';
    fragment.append(target);
    document.body.append(fragment);
    const matches = vi.spyOn(Element.prototype, 'matches');
    loadAgent();

    const response = request({ selectors: ['#late-target', 'button'] });

    expect(response).toMatchObject({ success: false, error: 'Target element not found' });
    expect(matches.mock.calls.length).toBeLessThanOrEqual(12_000);
  });

  it('rejects oversized and structurally expensive selectors before traversal', () => {
    const matches = vi.spyOn(Element.prototype, 'matches');
    loadAgent();

    const oversized = request({ selectors: [`#${'a'.repeat(4097)}`] });
    const expensive = request({ selectors: ['main:has(button)'] });

    expect(oversized.error).toBe('Target element not found');
    expect(expensive.error).toBe('Target element not found');
    expect(matches).not.toHaveBeenCalled();
  });

  it('uses the same bounded traversal inside open shadow roots', () => {
    const host = document.createElement('div');
    host.id = 'shadow-host';
    const root = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    target.id = 'shadow-target';
    root.append(target);
    document.body.append(host);
    const shadowQueryAll = vi.spyOn(ShadowRoot.prototype, 'querySelectorAll');
    loadAgent();

    const response = request({
      shadowHostChain: ['#shadow-host'],
      selectors: ['#shadow-target'],
    });

    expect(response).toMatchObject({ success: false, error: 'Not a React component' });
    expect(shadowQueryAll).not.toHaveBeenCalled();
  });

  it('stops traversal when the shared time budget expires', () => {
    document.body.innerHTML = '<button id="target"></button>';
    const nativeMatches = Element.prototype.matches;
    let delayed = false;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (selector: string) {
      if (!delayed) {
        delayed = true;
        const deadline = performance.now() + 275;
        while (performance.now() < deadline) {
          // Simulate a pathological selector evaluation in the browser engine.
        }
      }
      return nativeMatches.call(this, selector);
    });
    loadAgent();

    const response = request({ selectors: ['#target'] });

    expect(response).toMatchObject({ success: false, error: 'Target element not found' });
  });
});
