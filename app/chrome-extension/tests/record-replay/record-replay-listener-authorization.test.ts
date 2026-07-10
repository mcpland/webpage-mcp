import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

const mocks = vi.hoisted(() => {
  const session = {
    getSession: vi.fn(() => ({ sessionId: 'sess-listener' })),
    getStatus: vi.fn(() => 'recording' as const),
    hasActiveTab: vi.fn((tabId: number) => tabId === 7),
  };
  return {
    session,
    init: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue({ success: true }),
    stop: vi.fn().mockResolvedValue({ success: true }),
    pause: vi.fn().mockResolvedValue({ success: true }),
    resume: vi.fn().mockResolvedValue({ success: true }),
  };
});

vi.mock('@/entrypoints/background/record-replay/recording/recorder-manager', () => ({
  RecorderManager: {
    init: mocks.init,
    start: mocks.start,
    stop: mocks.stop,
    pause: mocks.pause,
    resume: mocks.resume,
  },
}));

vi.mock('@/entrypoints/background/record-replay/recording/session-manager', () => ({
  recordingSession: mocks.session,
}));

vi.mock('@/entrypoints/background/record-replay/recording/recording-state', () => ({
  buildRecordingStateSnapshot: () => ({ status: 'recording', sessionId: 'sess-listener' }),
}));

vi.mock('@/entrypoints/background/record-replay-v3/compat', () => ({
  enqueueRunAndWait: vi.fn(),
  ensureV3Runtime: vi.fn(),
  exportAllFlowsJson: vi.fn(),
  exportFlowJson: vi.fn(),
  importFlowsToV3: vi.fn(),
  saveFlowToV3: vi.fn(),
}));

type RuntimeListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];

function contentSender(
  overrides: Partial<chrome.runtime.MessageSender> = {},
): chrome.runtime.MessageSender {
  return {
    id: chrome.runtime.id,
    tab: { id: 7 } as chrome.tabs.Tab,
    frameId: 0,
    documentId: 'document-a',
    ...overrides,
  };
}

function extensionPageSender(): chrome.runtime.MessageSender {
  return { id: chrome.runtime.id };
}

describe('record/replay listener authorization', () => {
  let listener: RuntimeListener;

  beforeAll(async () => {
    vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
    const { initRecordReplayListeners } = await import('@/entrypoints/background/record-replay');
    initRecordReplayListeners();
    const registered = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0];
    if (!registered) throw new Error('record/replay listener was not registered');
    listener = registered;
  });

  beforeEach(() => {
    mocks.start.mockReset().mockResolvedValue({ success: true });
    mocks.stop.mockReset().mockResolvedValue({ success: true });
  });

  it('rejects management requests from page content scripts', () => {
    const sendResponse = vi.fn();
    listener({ type: BACKGROUND_MESSAGE_TYPES.RR_START_RECORDING }, contentSender(), sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'record/replay request requires an extension page',
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('allows management requests from this extension page', async () => {
    const sendResponse = vi.fn();
    listener(
      { type: BACKGROUND_MESSAGE_TYPES.RR_START_RECORDING, tabId: 7 },
      extensionPageSender(),
      sendResponse,
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(mocks.start).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, state: expect.any(Object) }),
    );
  });

  it('allows one document-bound in-page stop capability only once', async () => {
    const registrationResponse = vi.fn();
    const capability = 'b'.repeat(64);
    const sender = contentSender();
    listener(
      {
        action: 'rr_register_recorder_control',
        sessionId: 'sess-listener',
        controlCapability: capability,
      },
      sender,
      registrationResponse,
    );
    expect(registrationResponse).toHaveBeenCalledWith({ success: true });

    const firstStopResponse = vi.fn();
    listener(
      {
        type: BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING,
        sessionId: 'sess-listener',
        controlCapability: capability,
      },
      sender,
      firstStopResponse,
    );
    await vi.waitFor(() => expect(firstStopResponse).toHaveBeenCalled());
    expect(mocks.stop).toHaveBeenCalledTimes(1);

    const replayResponse = vi.fn();
    listener(
      {
        type: BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING,
        sessionId: 'sess-listener',
        controlCapability: capability,
      },
      sender,
      replayResponse,
    );
    expect(replayResponse).toHaveBeenCalledWith({
      success: false,
      error: 'record/replay request requires an extension page',
    });
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });
});
