import { beforeEach, describe, expect, it } from 'vitest';

import { PRIVILEGED_UI_ACTIONS } from '@/common/message-types';
import { PrivilegedUiAuthorizationStore } from '@/entrypoints/background/privileged-ui-authorization';

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

describe('privileged in-page UI authorization', () => {
  let store: PrivilegedUiAuthorizationStore;

  beforeEach(() => {
    store = new PrivilegedUiAuthorizationStore();
  });

  it('binds a one-time grant to action, extension, tab, frame, and document', () => {
    const token = store.issue(PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND, sender(), 1_000);
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    expect(store.consume(token, PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND, sender(), 1_001)).toBe(
      true,
    );
    expect(store.consume(token, PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND, sender(), 1_002)).toBe(
      false,
    );
  });

  it('rejects and consumes grants presented from a different document', () => {
    const token = store.issue(PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY, sender(), 2_000);

    expect(
      store.consume(
        token,
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
        sender({ documentId: 'document-b' }),
        2_001,
      ),
    ).toBe(false);
    expect(store.consume(token, PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY, sender(), 2_002)).toBe(
      false,
    );
  });

  it('rejects action confusion, expiry, foreign extensions, and child frames', () => {
    const wrongActionToken = store.issue(PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND, sender(), 3_000);
    expect(
      store.consume(wrongActionToken, PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY, sender(), 3_001),
    ).toBe(false);

    const expiredToken = store.issue(PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND, sender(), 4_000);
    expect(
      store.consume(expiredToken, PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND, sender(), 34_001),
    ).toBe(false);

    expect(
      store.issue(PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND, sender({ id: 'foreign-extension' })),
    ).toBeNull();
    expect(store.issue(PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND, sender({ frameId: 1 }))).toBeNull();
  });
});
