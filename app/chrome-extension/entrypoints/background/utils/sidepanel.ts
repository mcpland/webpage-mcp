/**
 * Sidepanel Utilities
 *
 * Shared helpers for opening and managing the Chrome sidepanel from background modules.
 * Used by web-editor, quick-panel, and other modules that need to trigger sidepanel navigation.
 */

/**
 * Best-effort open the sidepanel with workflows tab selected.
 *
 * @param tabId - Tab ID to associate with sidepanel
 * @param windowId - Optional window ID for fallback when tab-level open fails
 * @param _sessionId - Deprecated, preserved for call-site compatibility
 *
 * @remarks
 * This function is intentionally resilient - it will not throw on failures.
 * Sidepanel availability varies across Chrome versions and contexts.
 */
export async function openAgentChatSidepanel(
  tabId: number,
  windowId?: number,
  _sessionId?: string,
): Promise<void> {
  try {
    const path = 'sidepanel.html?tab=workflows';

    // Configure sidepanel options for this tab

    const sidePanel = chrome.sidePanel as any;

    if (sidePanel?.setOptions) {
      await sidePanel.setOptions({
        tabId,
        path,
        enabled: true,
      });
    }

    // Attempt to open the sidepanel
    if (sidePanel?.open) {
      try {
        await sidePanel.open({ tabId });
      } catch {
        // Fallback to window-level open if tab-level fails
        // This handles cases where the tab is in a special state
        if (typeof windowId === 'number') {
          await sidePanel.open({ windowId });
        }
      }
    }
  } catch {
    // Best-effort: side panel may be unavailable in some Chrome versions/environments
    // Intentionally suppress errors to avoid breaking calling code
  }
}
