import { addNavigationStep } from './flow-builder';
import { STEP_TYPES } from '@/common/step-types';
import { ensureRecorderInjected, broadcastControlToTab, REC_CMD } from './content-injection';
import type { RecordingSessionManager } from './session-manager';
import type { Step } from '../types';

export function initBrowserEventListeners(session: RecordingSessionManager): void {
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      if (session.getStatus() !== 'recording') return;
      const tabId = activeInfo.tabId;
      await ensureRecorderInjected(tabId);
      await broadcastControlToTab(tabId, REC_CMD.START);
      // Track active tab for targeted STOP later
      session.addActiveTab(tabId);

      const flow = session.getFlow();
      if (!flow) return;
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url;
      const step: Step = {
        id: '',
        type: STEP_TYPES.SWITCH_TAB,
        ...(url ? { urlContains: url } : {}),
      };
      session.appendSteps([step]);
    } catch (e) {
      console.warn('onActivated handler failed', e);
    }
  });

  chrome.webNavigation.onCommitted.addListener(async (details) => {
    try {
      if (session.getStatus() !== 'recording') return;
      if (details.frameId !== 0) return;
      const tabId = details.tabId;
      const t = details.transitionType;
      const link = t === 'link';
      if (!link) {
        const shouldRecord =
          t === 'reload' ||
          t === 'typed' ||
          t === 'generated' ||
          t === 'auto_bookmark' ||
          t === 'keyword' ||
          // include form_submit to better capture Enter-to-search navigations
          t === 'form_submit';
        if (shouldRecord) {
          const tab = await chrome.tabs.get(tabId);
          const url = tab.url || details.url;
          const flow = session.getFlow();
          if (flow && url) addNavigationStep(flow, url);
        }
      }
      await ensureRecorderInjected(tabId);
      await broadcastControlToTab(tabId, REC_CMD.START);
      // Track active tab for targeted STOP later
      session.addActiveTab(tabId);
      if (session.getFlow()) {
        session.broadcastTimelineUpdate();
      }
    } catch (e) {
      console.warn('onCommitted handler failed', e);
    }
  });

  // Remove closed tabs from the active set to avoid stale broadcasts
  chrome.tabs.onRemoved.addListener((tabId) => {
    try {
      // Even if not recording, removing is harmless; keep guard for clarity
      if (session.getStatus() !== 'recording') return;
      session.removeActiveTab(tabId);
    } catch (e) {
      console.warn('onRemoved handler failed', e);
    }
  });
}
