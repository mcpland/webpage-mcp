import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_MESSAGE_TYPES, PRIVILEGED_UI_ACTIONS } from '@/common/message-types';

const authorizationMocks = vi.hoisted(() => ({
  authorizePrivilegedUiAction: vi.fn(),
}));

vi.mock('@/utils/privileged-ui-authorization', () => authorizationMocks);

describe('Quick Panel agent bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizationMocks.authorizePrivilegedUiAction.mockResolvedValue('cancel-token');
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true });
  });

  it('authorizes cancellation immediately before sending it', async () => {
    const { QuickPanelAgentBridge } = await import('@/shared/quick-panel/core/agent-bridge');
    const bridge = new QuickPanelAgentBridge();

    await expect(bridge.cancelRequest('request-1', 'session-1')).resolves.toEqual({
      success: true,
    });

    expect(authorizationMocks.authorizePrivilegedUiAction).toHaveBeenCalledWith(
      PRIVILEGED_UI_ACTIONS.QUICK_PANEL_CANCEL,
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_CANCEL_AI,
      authorizationToken: 'cancel-token',
      payload: { requestId: 'request-1', sessionId: 'session-1' },
    });

    bridge.dispose();
  });

  it('does not send cancellation when authorization fails', async () => {
    authorizationMocks.authorizePrivilegedUiAction.mockRejectedValue(
      new Error('Authorization was not granted'),
    );
    const { QuickPanelAgentBridge } = await import('@/shared/quick-panel/core/agent-bridge');
    const bridge = new QuickPanelAgentBridge();

    await expect(bridge.cancelRequest('request-1')).resolves.toEqual({
      success: false,
      error: 'Authorization was not granted',
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();

    bridge.dispose();
  });
});
