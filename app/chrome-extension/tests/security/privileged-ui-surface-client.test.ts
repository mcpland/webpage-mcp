import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PRIVILEGED_UI_ACTIONS, PRIVILEGED_UI_SURFACES } from '@/common/message-types';
import {
  authorizePrivilegedUiAction,
  clearPrivilegedUiSurfaceSession,
  closePrivilegedUiSurfaceSession,
  configurePrivilegedUiSurfaceSession,
} from '@/utils/privileged-ui-authorization';

describe('privileged UI surface client', () => {
  const quickPanelSession = '55'.repeat(32);

  beforeEach(() => {
    vi.clearAllMocks();
    clearPrivilegedUiSurfaceSession();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      success: true,
      authorizationToken: 'authorization-token',
    });
  });

  it('sends the background-owned session with its matching action', async () => {
    expect(
      configurePrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.QUICK_PANEL,
        quickPanelSession,
      ),
    ).toBe(true);

    await expect(
      authorizePrivilegedUiAction(PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND),
    ).resolves.toBe('authorization-token');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'privileged_ui_authorize',
      payload: {
        action: PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
        surface: PRIVILEGED_UI_SURFACES.QUICK_PANEL,
        surfaceSessionId: quickPanelSession,
      },
    });
  });

  it('refuses cross-surface and inactive authorization locally', async () => {
    configurePrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.QUICK_PANEL,
      quickPanelSession,
    );

    await expect(
      authorizePrivilegedUiAction(PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY),
    ).rejects.toThrow('Privileged UI surface is not active');
    clearPrivilegedUiSurfaceSession(PRIVILEGED_UI_SURFACES.QUICK_PANEL);
    await expect(
      authorizePrivilegedUiAction(PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND),
    ).rejects.toThrow('Privileged UI surface is not active');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('notifies background when the UI closes and clears the local session first', async () => {
    configurePrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.QUICK_PANEL,
      quickPanelSession,
    );
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ success: true });

    await expect(
      closePrivilegedUiSurfaceSession(PRIVILEGED_UI_SURFACES.QUICK_PANEL),
    ).resolves.toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'privileged_ui_surface_close',
      payload: {
        surface: PRIVILEGED_UI_SURFACES.QUICK_PANEL,
        surfaceSessionId: quickPanelSession,
      },
    });
    await expect(
      authorizePrivilegedUiAction(PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND),
    ).rejects.toThrow('Privileged UI surface is not active');
  });
});
