import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MessageListener = (
  request: Record<string, unknown>,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

class ControlledMutationObserver {
  static instances: ControlledMutationObserver[] = [];

  readonly observe = vi.fn();

  constructor(private readonly callback: MutationCallback) {
    ControlledMutationObserver.instances.push(this);
  }

  trigger(): void {
    this.callback([], this as unknown as MutationObserver);
  }
}

function loadDomObserver(): {
  listener: MessageListener;
  sendMessage: ReturnType<typeof vi.fn>;
  observer: ControlledMutationObserver;
} {
  let listener: MessageListener | undefined;
  const sendMessage = vi.fn();
  vi.stubGlobal('MutationObserver', ControlledMutationObserver);
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: vi.fn((candidate: MessageListener) => {
          listener = candidate;
        }),
      },
    },
  });
  delete (window as { __RR_DOM_OBSERVER__?: boolean }).__RR_DOM_OBSERVER__;
  const source = readFileSync(join(process.cwd(), 'inject-scripts/dom-observer.js'), 'utf8');
  window.eval(source);

  const observer = ControlledMutationObserver.instances.at(-1);
  if (!listener || !observer) throw new Error('DOM observer did not initialize');
  return { listener, sendMessage, observer };
}

function trigger(id: string, selector: string, debounceMs = 800): Record<string, unknown> {
  return { id, selector, debounceMs, appear: true, once: false };
}

describe('DOM trigger injected observer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    ControlledMutationObserver.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { __RR_DOM_OBSERVER__?: boolean }).__RR_DOM_OBSERVER__;
    document.body.innerHTML = '';
  });

  it('coalesces mutation bursts and limits every check round to sixteen queries', () => {
    const querySelector = vi.spyOn(document, 'querySelector');
    const { listener, observer } = loadDomObserver();
    const response = vi.fn();

    listener(
      {
        action: 'set_dom_triggers',
        triggers: Array.from({ length: 32 }, (_, index) =>
          trigger(`trigger-${index}`, `.never-matches-${index}`),
        ),
      },
      {},
      response,
    );
    expect(response).toHaveBeenCalledWith({ success: true, count: 32 });
    querySelector.mockClear();

    for (let index = 0; index < 100; index += 1) observer.trigger();
    expect(querySelector).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(querySelector).toHaveBeenCalledTimes(16);
    vi.advanceTimersByTime(50);
    expect(querySelector).toHaveBeenCalledTimes(32);
    vi.advanceTimersByTime(500);
    expect(querySelector).toHaveBeenCalledTimes(32);
  });

  it('caps trigger installation and rejects high-risk selectors in content', () => {
    const { listener } = loadDomObserver();
    const response = vi.fn();
    const triggers = Array.from({ length: 40 }, (_, index) =>
      trigger(`trigger-${index}`, `.safe-${index}`),
    );
    triggers[0] = trigger('unsafe', 'main:has(.expensive)');

    listener({ action: 'set_dom_triggers', triggers }, {}, response);

    expect(response).toHaveBeenCalledWith({ success: true, count: 31 });
  });

  it('enforces the minimum debounce interval for repeated matches', () => {
    const target = document.createElement('div');
    target.id = 'target';
    document.body.appendChild(target);
    const { listener, sendMessage, observer } = loadDomObserver();

    listener(
      {
        action: 'set_dom_triggers',
        triggers: [trigger('repeat', '#target', 0)],
      },
      {},
      vi.fn(),
    );
    vi.advanceTimersByTime(50);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    observer.trigger();
    vi.advanceTimersByTime(50);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(150);
    observer.trigger();
    vi.advanceTimersByTime(50);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
