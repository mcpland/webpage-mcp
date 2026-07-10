import { describe, expect, it, vi, beforeEach } from 'vitest';

import { createRecorderEventMessageHandler } from '@/entrypoints/background/record-replay/recording/content-message-handler';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

function createSessionMock(sessionId = 'sess_test') {
  const state = { sessionId };
  const appendSteps = vi.fn();
  const appendVariables = vi.fn();

  const session = {
    canAcceptSteps: vi.fn(() => true),
    getFlow: vi.fn(() => ({ id: 'flow-1' })),
    getSession: vi.fn(() => state),
    appendSteps,
    appendVariables,
  };

  return {
    state,
    appendSteps,
    appendVariables,
    session,
  };
}

function createSender(tabId = 101, frameId = 0): chrome.runtime.MessageSender {
  return {
    tab: { id: tabId } as chrome.tabs.Tab,
    frameId,
  };
}

function createMeta(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    version: 1,
    sessionId: 'sess_test',
    eventId: 'evt_1',
    seq: 1,
    ...overrides,
  };
}

function createClickStep(id: string) {
  return {
    id,
    type: 'click',
    target: {
      selector: '#save',
      candidates: [{ type: 'css', value: '#save' }],
    },
  };
}

describe('Recorder ingest protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (chrome.tabs as any).sendMessage = vi.fn().mockResolvedValue({ ok: true });
  });

  it('accepts valid recorder event and appends steps', () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);
    const sendResponse = vi.fn();

    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [createClickStep('s1')] },
        meta: createMeta(),
      },
      createSender(),
      sendResponse,
    );

    expect(mock.appendSteps).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        ack: expect.objectContaining({
          seq: 1,
          eventId: 'evt_1',
          decision: 'accept',
        }),
      }),
    );
  });

  it('deduplicates repeated eventId from same source', () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);

    const firstResponse = vi.fn();
    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [createClickStep('s1')] },
        meta: createMeta(),
      },
      createSender(),
      firstResponse,
    );

    const secondResponse = vi.fn();
    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [createClickStep('s1')] },
        meta: createMeta(), // same eventId + seq
      },
      createSender(),
      secondResponse,
    );

    expect(mock.appendSteps).toHaveBeenCalledTimes(1);
    expect(secondResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        deduped: true,
        ack: expect.objectContaining({
          decision: 'duplicate',
          highWatermarkSeq: 1,
        }),
      }),
    );
  });

  it('marks out-of-order lower seq as stale', () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);

    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [createClickStep('s2')] },
        meta: createMeta({ eventId: 'evt_2', seq: 2 }),
      },
      createSender(),
      vi.fn(),
    );

    const staleResponse = vi.fn();
    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [createClickStep('s1')] },
        meta: createMeta({ eventId: 'evt_3', seq: 1 }),
      },
      createSender(),
      staleResponse,
    );

    expect(mock.appendSteps).toHaveBeenCalledTimes(1);
    expect(staleResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        deduped: true,
        ack: expect.objectContaining({
          decision: 'stale',
          highWatermarkSeq: 2,
        }),
      }),
    );
  });

  it('rejects event with mismatched sessionId', () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);
    const sendResponse = vi.fn();

    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [createClickStep('s1')] },
        meta: createMeta({ sessionId: 'another_session' }),
      },
      createSender(),
      sendResponse,
    );

    expect(mock.appendSteps).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        code: 'SESSION_MISMATCH',
      }),
    );
  });

  it('rejects legacy events when authenticated session metadata is missing', () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);
    const sendResponse = vi.fn();

    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: {
          kind: 'variables',
          variables: [{ key: 'v1', sensitive: true }],
        },
      },
      createSender(),
      sendResponse,
    );

    expect(mock.appendVariables).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        code: 'INVALID_META',
      }),
    );
  });

  it('rejects event when meta is present but invalid', () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);
    const sendResponse = vi.fn();

    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [createClickStep('s1')] },
        meta: createMeta({ seq: -1 }),
      },
      createSender(),
      sendResponse,
    );

    expect(mock.appendSteps).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        code: 'INVALID_META',
      }),
    );
  });

  it('resets source watermark when session rotates', () => {
    const mock = createSessionMock('sess_a');
    const handler = createRecorderEventMessageHandler(mock.session as any);

    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [createClickStep('sa')] },
        meta: createMeta({ sessionId: 'sess_a', eventId: 'evt_a1', seq: 5 }),
      },
      createSender(),
      vi.fn(),
    );

    mock.state.sessionId = 'sess_b';
    const response = vi.fn();
    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [createClickStep('sb')] },
        meta: createMeta({ sessionId: 'sess_b', eventId: 'evt_b1', seq: 1 }),
      },
      createSender(),
      response,
    );

    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        ack: expect.objectContaining({
          decision: 'accept',
          highWatermarkSeq: 1,
        }),
      }),
    );
  });

  it.each(['script', 'http', 'navigate', 'openTab', 'executeFlow'])(
    'rejects dangerous recorder step type %s',
    (type) => {
      const mock = createSessionMock();
      const handler = createRecorderEventMessageHandler(mock.session as any);
      const response = vi.fn();

      handler(
        {
          type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
          payload: {
            kind: 'steps',
            steps: [
              {
                id: 'forged',
                type,
                code: 'globalThis.pwned = true',
                url: 'file:///tmp',
              },
            ],
          },
          meta: createMeta(),
        },
        createSender(),
        response,
      );

      expect(mock.appendSteps).not.toHaveBeenCalled();
      expect(response).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, code: 'INVALID_PAYLOAD' }),
      );
    },
  );

  it('rebuilds allowed steps from whitelisted fields', () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);

    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: {
          kind: 'steps',
          steps: [
            {
              ...createClickStep('safe'),
              code: 'globalThis.pwned = true',
              sideEffect: { kind: 'dangerous' },
              target: {
                ...createClickStep('safe').target,
                frameContext: { kind: 'iframe', url: 'https://evil.test' },
              },
            },
          ],
        },
        meta: createMeta(),
      },
      createSender(),
      vi.fn(),
    );

    expect(mock.appendSteps).toHaveBeenCalledWith([
      {
        id: 'safe',
        type: 'click',
        target: {
          selector: '#save',
          candidates: [{ type: 'css', value: '#save' }],
        },
      },
    ]);
  });

  it('joins a child-frame runtime step with top-frame selector context', async () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);
    const frameEventId = `frame_${'a'.repeat(32)}`;

    const childResponse = await new Promise<unknown>((resolve) => {
      handler(
        {
          type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
          payload: {
            kind: 'iframeStep',
            frameEventId,
            step: createClickStep('iframe-click'),
          },
          meta: createMeta({
            eventId: 'child-event',
            source: { href: 'https://widgets.test/frame', isTop: false },
          }),
        },
        createSender(101, 7),
        resolve,
      );
    });
    expect(childResponse).toEqual(expect.objectContaining({ ok: true }));
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      101,
      {
        action: 'rr_register_iframe_event',
        sessionId: 'sess_test',
        frameEventId,
      },
      { frameId: 0 },
    );
    expect(mock.appendSteps).not.toHaveBeenCalled();

    const response = vi.fn();
    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: {
          kind: 'iframeFrameContext',
          frameEventId,
          frameTarget: {
            selector: 'iframe#checkout',
            candidates: [{ type: 'css', value: 'iframe#checkout' }],
          },
        },
        meta: createMeta({ eventId: 'top-event' }),
      },
      createSender(101, 0),
      response,
    );

    expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(mock.appendSteps).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'iframe-click',
        type: 'click',
        target: expect.objectContaining({
          selector: 'iframe#checkout |> #save',
          frameContext: {
            kind: 'iframe',
            url: 'https://widgets.test/frame',
            frameSelector: 'iframe#checkout',
          },
        }),
      }),
    ]);
  });

  it('rejects forged frame context without a frame-authenticated pending step', () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);
    const response = vi.fn();

    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: {
          kind: 'iframeFrameContext',
          frameEventId: `frame_${'b'.repeat(32)}`,
          frameTarget: {
            selector: 'iframe#evil',
            candidates: [{ type: 'css', value: 'iframe#evil' }],
          },
          step: {
            id: 'forged',
            type: 'script',
            code: 'globalThis.pwned = true',
          },
        },
        meta: createMeta(),
      },
      createSender(101, 0),
      response,
    );

    expect(mock.appendSteps).not.toHaveBeenCalled();
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: 'INVALID_PAYLOAD' }),
    );
  });

  it('does not commit an iframe event when top-frame registration fails', async () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);
    const frameEventId = `frame_${'d'.repeat(32)}`;
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValueOnce(new Error('top frame unavailable'));

    const firstResponse = await new Promise<any>((resolve) => {
      handler(
        {
          type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
          payload: { kind: 'iframeStep', frameEventId, step: createClickStep('retryable') },
          meta: createMeta({ eventId: 'retryable-event' }),
        },
        createSender(101, 9),
        resolve,
      );
    });
    expect(firstResponse).toMatchObject({ ok: false, code: 'FRAME_REGISTRATION_FAILED' });

    const retryResponse = await new Promise<any>((resolve) => {
      handler(
        {
          type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
          payload: { kind: 'iframeStep', frameEventId, step: createClickStep('retryable') },
          meta: createMeta({ eventId: 'retryable-event' }),
        },
        createSender(101, 9),
        resolve,
      );
    });
    expect(retryResponse).toMatchObject({
      ok: true,
      ack: { decision: 'accept', highWatermarkSeq: 1 },
    });
  });
});
