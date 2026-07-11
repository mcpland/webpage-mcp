import { beforeEach, describe, expect, it } from 'vitest';

import {
  PRIVILEGED_UI_ACTIONS,
  PRIVILEGED_UI_SURFACES,
} from '@/common/message-types';
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
  const quickPanelSession = '11'.repeat(32);
  const webEditorSession = '22'.repeat(32);

  beforeEach(() => {
    store = new PrivilegedUiAuthorizationStore();
    expect(
      store.activateSurface(
        PRIVILEGED_UI_SURFACES.QUICK_PANEL,
        7,
        quickPanelSession,
      ),
    ).toBe(true);
    expect(
      store.activateSurface(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        7,
        webEditorSession,
      ),
    ).toBe(true);
  });

  it('binds a one-time grant to surface session, action, tab, frame, and document', () => {
    const token = store.issue(
      PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
      PRIVILEGED_UI_SURFACES.QUICK_PANEL,
      quickPanelSession,
      sender(),
      1_000,
    );
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    expect(
      store.consume(
        token,
        PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
        sender(),
        1_001,
      ),
    ).toBe(true);
    expect(
      store.consume(
        token,
        PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
        sender(),
        1_002,
      ),
    ).toBe(false);
  });

  it('rejects and consumes grants presented from a different document', () => {
    const token = store.issue(
      PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      webEditorSession,
      sender(),
      2_000,
    );

    expect(
      store.consume(
        token,
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
        sender({ documentId: 'document-b' }),
        2_001,
      ),
    ).toBe(false);
    expect(
      store.consume(
        token,
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
        sender(),
        2_002,
      ),
    ).toBe(false);
  });

  it('rejects action confusion, expiry, foreign extensions, and child frames', () => {
    const issueQuickPanel = (
      action:
        | typeof PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND
        | typeof PRIVILEGED_UI_ACTIONS.QUICK_PANEL_CANCEL,
      now: number,
      source = sender(),
    ) =>
      store.issue(
        action,
        PRIVILEGED_UI_SURFACES.QUICK_PANEL,
        quickPanelSession,
        source,
        now,
      );
    const wrongActionToken = issueQuickPanel(
      PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
      3_000,
    );
    expect(
      store.consume(
        wrongActionToken,
        PRIVILEGED_UI_ACTIONS.QUICK_PANEL_CANCEL,
        sender(),
        3_001,
      ),
    ).toBe(false);

    const cancelToken = issueQuickPanel(
      PRIVILEGED_UI_ACTIONS.QUICK_PANEL_CANCEL,
      3_100,
    );
    expect(
      store.consume(
        cancelToken,
        PRIVILEGED_UI_ACTIONS.QUICK_PANEL_CANCEL,
        sender(),
        3_101,
      ),
    ).toBe(true);

    const editorCancelToken = store.issue(
      PRIVILEGED_UI_ACTIONS.WEB_EDITOR_CANCEL,
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      webEditorSession,
      sender(),
      3_200,
    );
    expect(
      store.consume(
        editorCancelToken,
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_CANCEL,
        sender(),
        3_201,
      ),
    ).toBe(true);

    const expiredToken = issueQuickPanel(
      PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
      4_000,
    );
    expect(
      store.consume(
        expiredToken,
        PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
        sender(),
        34_001,
      ),
    ).toBe(false);

    expect(
      issueQuickPanel(
        PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
        5_000,
        sender({ id: 'foreign-extension' }),
      ),
    ).toBeNull();
    expect(
      issueQuickPanel(
        PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
        5_001,
        sender({ frameId: 1 }),
      ),
    ).toBeNull();
    expect(
      issueQuickPanel(
        PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
        5_002,
        sender({ documentId: undefined }),
      ),
    ).toBeNull();
    expect(
      issueQuickPanel(
        PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
        5_003,
        sender({ documentId: 'x'.repeat(513) }),
      ),
    ).toBeNull();
  });

  it('prevents same-document Quick Panel and Element Picker code from farming Web Editor grants', () => {
    expect(
      store.issue(
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
        PRIVILEGED_UI_SURFACES.QUICK_PANEL,
        quickPanelSession,
        sender(),
      ),
    ).toBeNull();
    expect(
      store.issue(
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        quickPanelSession,
        sender(),
      ),
    ).toBeNull();
    expect(
      store.issue(
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        '33'.repeat(32),
        sender(),
      ),
    ).toBeNull();
  });

  it('invalidates outstanding grants when a surface stops or rotates sessions', () => {
    const token = store.issue(
      PRIVILEGED_UI_ACTIONS.WEB_EDITOR_OPEN_SOURCE,
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      webEditorSession,
      sender(),
      6_000,
    );
    store.activateSurface(
      PRIVILEGED_UI_SURFACES.WEB_EDITOR,
      7,
      '44'.repeat(32),
    );

    expect(
      store.consume(
        token,
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_OPEN_SOURCE,
        sender(),
        6_001,
      ),
    ).toBe(false);
    expect(
      store.issue(
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_OPEN_SOURCE,
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        webEditorSession,
        sender(),
      ),
    ).toBeNull();

    expect(
      store.deactivateSurfaceIfSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        7,
        webEditorSession,
      ),
    ).toBe(false);
    expect(
      store.issue(
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_OPEN_SOURCE,
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        '44'.repeat(32),
        sender(),
      ),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts UI-close only from the active surface session and owning document', () => {
    expect(
      store.issue(
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        webEditorSession,
        sender(),
      ),
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      store.deactivateSurfaceFromSender(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        '99'.repeat(32),
        sender(),
      ),
    ).toBe(false);
    expect(
      store.deactivateSurfaceFromSender(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        webEditorSession,
        sender({ documentId: 'document-b' }),
      ),
    ).toBe(false);
    expect(
      store.deactivateSurfaceFromSender(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        webEditorSession,
        sender(),
      ),
    ).toBe(true);
    expect(
      store.issue(
        PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        webEditorSession,
        sender(),
      ),
    ).toBeNull();
  });
});
