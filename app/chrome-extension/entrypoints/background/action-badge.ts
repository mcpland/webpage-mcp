export interface ConnectionBadgeState {
  connected: boolean;
  serverRunning: boolean;
}

interface ConnectionBadgeView {
  text: string;
  title: string;
  color: chrome.action.ColorArray;
}

const BADGE_VIEW_CONNECTED_RUNNING: ConnectionBadgeView = {
  text: 'ON',
  title: 'Webpage MCP: Connected',
  color: [22, 163, 74, 255],
};

const BADGE_VIEW_CONNECTED_IDLE: ConnectionBadgeView = {
  text: 'IDLE',
  title: 'Webpage MCP: Connected, service not started',
  color: [217, 119, 6, 255],
};

const BADGE_VIEW_DISCONNECTED: ConnectionBadgeView = {
  text: 'OFF',
  title: 'Webpage MCP: Disconnected',
  color: [220, 38, 38, 255],
};

export function getConnectionBadgeView(state: ConnectionBadgeState): ConnectionBadgeView {
  if (state.connected && state.serverRunning) {
    return BADGE_VIEW_CONNECTED_RUNNING;
  }
  if (state.connected) {
    return BADGE_VIEW_CONNECTED_IDLE;
  }
  return BADGE_VIEW_DISCONNECTED;
}

export async function updateConnectionBadge(state: ConnectionBadgeState): Promise<void> {
  if (!chrome.action) {
    return;
  }

  const view = getConnectionBadgeView(state);

  await Promise.allSettled([
    chrome.action.setBadgeText({ text: view.text }),
    chrome.action.setBadgeBackgroundColor({ color: view.color }),
    chrome.action.setTitle({ title: view.title }),
  ]);
}
