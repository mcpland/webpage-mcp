import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getConnectionBadgeView,
  updateConnectionBadge,
} from '@/entrypoints/background/action-badge';

describe('action badge', () => {
  beforeEach(() => {
    (chrome as any).action = {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('returns connected-running badge view', () => {
    expect(
      getConnectionBadgeView({
        connected: true,
        serverRunning: true,
      }),
    ).toEqual({
      text: 'ON',
      title: 'Webpage MCP: Connected',
      color: [22, 163, 74, 255],
    });
  });

  it('returns connected-idle badge view', () => {
    expect(
      getConnectionBadgeView({
        connected: true,
        serverRunning: false,
      }),
    ).toEqual({
      text: 'IDLE',
      title: 'Webpage MCP: Connected, service not started',
      color: [217, 119, 6, 255],
    });
  });

  it('applies the disconnected badge via chrome.action', async () => {
    await updateConnectionBadge({
      connected: false,
      serverRunning: false,
    });

    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'OFF' });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: [220, 38, 38, 255],
    });
    expect(chrome.action.setTitle).toHaveBeenCalledWith({
      title: 'Webpage MCP: Disconnected',
    });
  });
});
