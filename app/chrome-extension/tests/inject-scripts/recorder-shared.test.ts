import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function installCssEscape(): void {
  const css = (window as unknown as { CSS?: { escape?: (value: string) => string } }).CSS ?? {};
  if (typeof css.escape === 'function') {
    return;
  }
  Object.defineProperty(window, 'CSS', {
    configurable: true,
    value: {
      ...css,
      escape: (value: string) =>
        String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`),
    },
  });
}

function loadRecorderShared(): any {
  delete (window as any).__RR_RECORDER_SHARED__;
  installCssEscape();
  const source = readFileSync(join(process.cwd(), 'inject-scripts/recorder-shared.js'), 'utf8');
  window.eval(source);
  return (window as any).__RR_RECORDER_SHARED__;
}

describe('recorder-shared selector metadata', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete (window as any).__RR_RECORDER_SHARED__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buildTarget emits extended metadata for recorded elements', () => {
    document.body.innerHTML = `
      <main>
        <form name="checkout">
          <input id="email" name="email" data-testid="email-input" />
        </form>
      </main>
    `;
    const shared = loadRecorderShared();
    const input = document.querySelector<HTMLInputElement>('#email');

    const target = shared.SelectorEngine.buildTarget(input);

    expect(target).toMatchObject({
      selector: '#email',
      tag: 'input',
      fingerprint: 'input|id=email',
      shadowHostChain: [],
      frameContext: {
        kind: 'top',
      },
    });
    expect(target.domPath).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(target.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'attr', value: '[data-testid="email-input"]' }),
        expect.objectContaining({ type: 'css', value: '#email' }),
      ]),
    );
  });

  it('buildTarget preserves shadow host chain metadata', () => {
    document.body.innerHTML = '<section><div id="host"></div></section>';
    const shared = loadRecorderShared();
    const host = document.querySelector<HTMLDivElement>('#host');
    const shadow = host?.attachShadow({ mode: 'open' });
    if (!shadow) {
      throw new Error('Expected Shadow DOM support in test environment');
    }
    shadow.innerHTML = '<button id="confirm">Confirm</button>';
    const button = shadow.querySelector<HTMLButtonElement>('#confirm');

    const target = shared.SelectorEngine.buildTarget(button);

    expect(target).toMatchObject({
      selector: '#confirm',
      tag: 'button',
      fingerprint: 'button|id=confirm|text=Confirm',
      shadowHostChain: ['#host'],
    });
    expect(target.domPath).toEqual(expect.arrayContaining([expect.any(Number)]));
  });

  it('stops uniqueness checks at the second match without selector snapshots', () => {
    document.body.innerHTML =
      '<button class="duplicate"></button><button class="duplicate"></button><button class="duplicate"></button>';
    const target = document.body.firstElementChild as HTMLButtonElement;
    const nativeMatches = Element.prototype.matches;
    let matchingResults = 0;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      const matched = nativeMatches.call(this, selector);
      if (matched) matchingResults += 1;
      return matched;
    });
    const querySelectorAll = vi.spyOn(document, 'querySelectorAll');
    const shared = loadRecorderShared();

    expect(shared.SelectorEngine._isUniqueSelector('.duplicate', target)).toBe(false);
    expect(matchingResults).toBe(2);
    expect(querySelectorAll).not.toHaveBeenCalled();
  });

  it('shares a bounded traversal across selector work for a recorded target', () => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 12_100; index += 1) {
      fragment.append(document.createElement('div'));
    }
    const target = document.createElement('button');
    target.id = 'late-target';
    fragment.append(target);
    document.body.append(fragment);
    const matches = vi.spyOn(Element.prototype, 'matches');
    const shared = loadRecorderShared();

    const result = shared.SelectorEngine.buildTarget(target);

    expect(result.selector).toEqual(expect.any(String));
    expect(matches.mock.calls.length).toBeLessThanOrEqual(12_000);
  });

  it('does not materialize sibling collections or subtree text', () => {
    const parent = document.createElement('div');
    const button = document.createElement('button');
    button.append(document.createTextNode('Bounded recorder text'));
    parent.append(button);
    document.body.append(parent);
    Object.defineProperty(parent, 'children', {
      configurable: true,
      get: () => {
        throw new Error('children must not be materialized');
      },
    });
    Object.defineProperty(button, 'textContent', {
      configurable: true,
      get: () => {
        throw new Error('textContent must not be materialized');
      },
    });
    const shared = loadRecorderShared();

    const result = shared.SelectorEngine.buildTarget(button);

    expect(result.fingerprint).toContain('text=Bounded recorder text');
    expect(result.selector).toEqual(expect.any(String));
  });
});
