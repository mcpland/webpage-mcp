import { beforeEach, describe, expect, it } from 'vitest';

import { RecorderControlAuthorizationStore } from '@/entrypoints/background/record-replay/recording/control-authorization';
import type { RecordingStatus } from '@/entrypoints/background/record-replay/recording/session-manager';

const CAPABILITY = 'a'.repeat(64);

function sender(
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

function session() {
  let sessionId = 'sess-recording';
  let status: RecordingStatus = 'recording';
  const activeTabs = new Set([7]);
  return {
    getSession: () => ({ sessionId }),
    getStatus: () => status,
    hasActiveTab: (tabId: number) => activeTabs.has(tabId),
    setSessionId: (next: string) => {
      sessionId = next;
    },
    setStatus: (next: RecordingStatus) => {
      status = next;
    },
  };
}

describe('recorder in-page control authorization', () => {
  let store: RecorderControlAuthorizationStore;

  beforeEach(() => {
    store = new RecorderControlAuthorizationStore();
  });

  it('binds the stop capability to session, tab, top frame, and document', () => {
    const current = session();
    const message = {
      sessionId: 'sess-recording',
      controlCapability: CAPABILITY,
    };

    expect(store.register(message, sender(), current)).toBe(true);
    expect(store.authorizeStop(message, sender({ documentId: 'document-b' }), current)).toBe(false);
    expect(store.authorizeStop(message, sender(), current)).toBe(true);
    expect(store.authorizeStop(message, sender(), current)).toBe(false);
  });

  it('rejects forged, foreign, child-frame, inactive-tab, and stale-session grants', () => {
    const current = session();
    const message = {
      sessionId: 'sess-recording',
      controlCapability: CAPABILITY,
    };

    expect(
      store.register({ ...message, controlCapability: 'predictable' }, sender(), current),
    ).toBe(false);
    expect(store.register(message, sender({ id: 'foreign-extension' }), current)).toBe(false);
    expect(store.register(message, sender({ frameId: 1 }), current)).toBe(false);
    expect(store.register(message, sender({ tab: { id: 8 } as chrome.tabs.Tab }), current)).toBe(
      false,
    );
    expect(store.register({ ...message, sessionId: 'stale' }, sender(), current)).toBe(false);

    expect(store.register(message, sender(), current)).toBe(true);
    current.setSessionId('sess-next');
    expect(store.authorizeStop(message, sender(), current)).toBe(false);
  });

  it('does not issue grants outside an active or paused recording', () => {
    const current = session();
    const message = {
      sessionId: 'sess-recording',
      controlCapability: CAPABILITY,
    };

    current.setStatus('stopping');
    expect(store.register(message, sender(), current)).toBe(false);
    current.setStatus('idle');
    expect(store.register(message, sender(), current)).toBe(false);
  });
});
