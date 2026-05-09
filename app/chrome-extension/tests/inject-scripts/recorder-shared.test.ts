import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

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
});
