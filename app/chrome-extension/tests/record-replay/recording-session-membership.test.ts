import { describe, expect, it } from 'vitest';
import {
  MAX_RECORDING_ACTIVE_TABS,
  RecordingSessionManager,
} from '@/entrypoints/background/record-replay/recording/session-manager';

describe('RecordingSessionManager tab membership', () => {
  it('tracks only bounded non-negative integer tab identifiers', () => {
    const session = new RecordingSessionManager();

    expect(session.addActiveTab(-1)).toBe(false);
    expect(session.addActiveTab(Number.NaN)).toBe(false);
    expect(session.addActiveTab(1.5)).toBe(false);

    for (let tabId = 0; tabId < MAX_RECORDING_ACTIVE_TABS; tabId += 1) {
      expect(session.addActiveTab(tabId)).toBe(true);
    }
    expect(session.addActiveTab(MAX_RECORDING_ACTIVE_TABS)).toBe(false);
    expect(session.addActiveTab(0)).toBe(true);
    expect(session.getActiveTabs()).toHaveLength(MAX_RECORDING_ACTIVE_TABS);
    expect(session.hasActiveTab(0)).toBe(true);
    expect(session.hasActiveTab(MAX_RECORDING_ACTIVE_TABS)).toBe(false);
  });
});
