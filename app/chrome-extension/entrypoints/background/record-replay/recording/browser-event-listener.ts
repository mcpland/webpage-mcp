import { addNavigationStep } from './flow-builder';
import { STEP_TYPES } from '@/common/step-types';
import { ensureRecorderInjected, broadcastControlToTab, REC_CMD } from './content-injection';
import type { RecordingSessionManager } from './session-manager';
import type { Step } from '../types';

export function initBrowserEventListeners(session: RecordingSessionManager): void {
  const getStartMeta = () => {
    const flow = session.getFlow();
    const sess = session.getSession();
    return {
      ...(flow?.id ? { id: flow.id } : {}),
      ...(flow?.name ? { name: flow.name } : {}),
      ...(flow?.description ? { description: flow.description } : {}),
      sessionId: sess.sessionId,
    };
  };

  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    let newlyTracked = false;
    try {
      if (session.getStatus() !== 'recording') return;
      const tabId = activeInfo.tabId;
      const wasTracked = session.hasActiveTab(tabId);
      if (!session.addActiveTab(tabId)) return;
      newlyTracked = !wasTracked;
      await ensureRecorderInjected(tabId);
      await broadcastControlToTab(tabId, REC_CMD.START, getStartMeta());

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
      if (newlyTracked) session.removeActiveTab(activeInfo.tabId);
      console.warn('onActivated handler failed', e);
    }
  });

  chrome.webNavigation.onCommitted.addListener(async (details) => {
    try {
      if (session.getStatus() !== 'recording') return;
      if (details.frameId !== 0) return;
      const tabId = details.tabId;
      if (!session.hasActiveTab(tabId)) return;

      await ensureRecorderInjected(tabId);
      await broadcastControlToTab(tabId, REC_CMD.START, getStartMeta());

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
      // Also prune while paused/stopping so the stop barrier cannot retain a
      // closed tab that will never acknowledge the final flush.
      session.removeActiveTab(tabId);
    } catch (e) {
      console.warn('onRemoved handler failed', e);
    }
  });
}
