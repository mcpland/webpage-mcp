import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];

function evalInjectScript(filename: string): void {
  const source = readFileSync(join(process.cwd(), 'inject-scripts', filename), 'utf8');
  window.eval(source);
}

function loadRecorder(): {
  listener: RuntimeListener;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  delete (window as any).__RR_RECORDER_INSTALLED__;
  delete (window as any).__RR_RECORDER_SHARED__;
  if (typeof window.CSS?.escape !== 'function') {
    Object.defineProperty(window, 'CSS', {
      configurable: true,
      value: {
        escape: (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'),
      },
    });
  }

  const sendMessage = vi.fn((message: any, callback?: (response: unknown) => void) => {
    callback?.({ ok: true, ack: { seq: message?.meta?.seq } });
  });
  (chrome.runtime as any).sendMessage = sendMessage;
  vi.mocked(chrome.runtime.onMessage.addListener).mockClear();

  evalInjectScript('recorder-shared.js');
  evalInjectScript('recorder.js');
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Recorder runtime listener was not registered');

  listener(
    {
      action: 'rr_recorder_control',
      cmd: 'start',
      meta: { sessionId: 'sess-frame-test' },
    },
    {} as chrome.runtime.MessageSender,
    vi.fn(),
  );
  sendMessage.mockClear();
  return { listener, sendMessage };
}

async function stopRecorder(listener: RuntimeListener): Promise<void> {
  await new Promise<void>((resolve) => {
    listener(
      {
        action: 'rr_recorder_control',
        cmd: 'stop',
        meta: { sessionId: 'sess-frame-test' },
      },
      {} as chrome.runtime.MessageSender,
      () => resolve(),
    );
  });
}

function dispatchFrameMessage(source: Window, origin: string, data: unknown): void {
  const event = new Event('message');
  Object.defineProperties(event, {
    source: { value: source },
    origin: { value: origin },
    data: { value: data },
  });
  window.dispatchEvent(event);
}

describe('recorder iframe ingest boundary', () => {
  let activeListener: RuntimeListener | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(async () => {
    if (activeListener) await stopRecorder(activeListener);
    activeListener = null;
    document.body.innerHTML = '';
    delete (window as any).__RR_RECORDER_INSTALLED__;
    delete (window as any).__RR_RECORDER_SHARED__;
  });

  it.each([
    ['same-origin', 'https://example.com', '/embedded'],
    ['cross-origin', 'https://evil.test', 'https://evil.test/embedded'],
  ])('does not forward a %s iframe forged script step', (_label, origin, src) => {
    const { listener, sendMessage } = loadRecorder();
    activeListener = listener;
    const frame = document.createElement('iframe');
    frame.setAttribute('src', src);
    document.body.appendChild(frame);

    dispatchFrameMessage(frame.contentWindow!, origin, {
      type: 'rr_iframe_event',
      payload: {
        kind: 'iframeStep',
        href: `${origin}/embedded`,
        step: {
          id: 'forged-script',
          type: 'script',
          world: 'MAIN',
          code: 'globalThis.__RECORDER_PWNED__ = true',
        },
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('forwards only selector context even when postMessage includes a forged step field', () => {
    const { listener, sendMessage } = loadRecorder();
    activeListener = listener;
    const frame = document.createElement('iframe');
    frame.id = 'checkout';
    document.body.appendChild(frame);
    const frameEventId = `frame_${'c'.repeat(32)}`;
    const registrationResponse = vi.fn();
    listener(
      {
        action: 'rr_register_iframe_event',
        sessionId: 'sess-frame-test',
        frameEventId,
      },
      {} as chrome.runtime.MessageSender,
      registrationResponse,
    );
    expect(registrationResponse).toHaveBeenCalledWith({ ok: true });

    dispatchFrameMessage(frame.contentWindow!, 'https://example.com', {
      type: 'rr_iframe_event',
      payload: {
        kind: 'iframeStepContext',
        frameEventId,
        step: {
          id: 'forged-script',
          type: 'script',
          code: 'globalThis.__RECORDER_PWNED__ = true',
        },
      },
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const envelope = sendMessage.mock.calls[0][0];
    expect(envelope.payload).toMatchObject({
      kind: 'iframeFrameContext',
      frameEventId,
      frameTarget: expect.objectContaining({ selector: '#checkout' }),
    });
    expect(envelope.payload).not.toHaveProperty('step');
    expect(envelope.meta?.source?.documentId).toEqual(expect.any(String));
    expect(envelope.meta.source.documentId.length).toBeGreaterThan(0);
    expect(JSON.stringify(envelope)).not.toContain('__RECORDER_PWNED__');
  });

  it('does not mint predictable frame capabilities when Web Crypto fails', () => {
    const source = readFileSync(join(process.cwd(), 'inject-scripts', 'recorder.js'), 'utf8');

    expect(source).not.toContain('Math.random().toString(16)');
    expect(source).toMatch(/_newFrameEventId\(\)[\s\S]*?catch \{[\s\S]*?return '';/);
  });
});
