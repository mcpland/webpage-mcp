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

describe('Recorder ingest protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts valid recorder event and appends steps', () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);
    const sendResponse = vi.fn();

    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [{ id: 's1', type: 'click' }] },
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
        payload: { kind: 'steps', steps: [{ id: 's1', type: 'click' }] },
        meta: createMeta(),
      },
      createSender(),
      firstResponse,
    );

    const secondResponse = vi.fn();
    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [{ id: 's1', type: 'click' }] },
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
        payload: { kind: 'steps', steps: [{ id: 's2', type: 'click' }] },
        meta: createMeta({ eventId: 'evt_2', seq: 2 }),
      },
      createSender(),
      vi.fn(),
    );

    const staleResponse = vi.fn();
    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [{ id: 's1', type: 'click' }] },
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
        payload: { kind: 'steps', steps: [{ id: 's1', type: 'click' }] },
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

  it('falls back to legacy mode when meta is missing', () => {
    const mock = createSessionMock();
    const handler = createRecorderEventMessageHandler(mock.session as any);
    const sendResponse = vi.fn();

    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'variables', variables: [{ key: 'v1', sensitive: true }] },
      },
      createSender(),
      sendResponse,
    );

    expect(mock.appendVariables).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        legacy: true,
      }),
    );
  });

  it('resets source watermark when session rotates', () => {
    const mock = createSessionMock('sess_a');
    const handler = createRecorderEventMessageHandler(mock.session as any);

    handler(
      {
        type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
        payload: { kind: 'steps', steps: [{ id: 'sa', type: 'click' }] },
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
        payload: { kind: 'steps', steps: [{ id: 'sb', type: 'click' }] },
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
});
