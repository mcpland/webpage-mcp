import { STEP_TYPES } from "@/common/step-types";
import {
  ensureRecorderInjected,
  broadcastControlToTab,
  REC_CMD,
} from "./content-injection";
import type { RecordingSessionManager } from "./session-manager";
import type { Step } from "../types";

export function initBrowserEventListeners(
  session: RecordingSessionManager,
): void {
  const getTopDocumentId = async (
    tabId: number,
  ): Promise<string | undefined> => {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      const top = Array.isArray(frames)
        ? frames.find((frame) => frame.frameId === 0)
        : undefined;
      return typeof top?.documentId === "string" && top.documentId.length <= 128
        ? top.documentId
        : undefined;
    } catch {
      return undefined;
    }
  };

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

  chrome.tabs.onActivated?.addListener(async (activeInfo) => {
    let newlyTracked = false;
    let appendedStepId = "";
    try {
      await session.waitUntilReady?.();
      if (session.getStatus() !== "recording") return;
      const tabId = activeInfo.tabId;
      const wasTracked = session.hasActiveTab(tabId);
      if (!session.addActiveTab(tabId)) return;
      newlyTracked = !wasTracked;
      session.setActiveTabDocument?.(tabId, await getTopDocumentId(tabId));
      await ensureRecorderInjected(tabId);

      const flow = session.getFlow();
      if (!flow)
        throw new Error("recording flow unavailable during tab activation");
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url;
      const step: Step = {
        id: "",
        type: STEP_TYPES.SWITCH_TAB,
        ...(url ? { urlContains: url } : {}),
      };
      const appendResult = session.appendSteps([step]);
      if (appendResult?.truncated) return;
      appendedStepId = step.id;
      // Commit membership, exact document identity, and the background-owned
      // switch step together before the page is allowed to emit events.
      await session.persistRecoveryState?.();
      const started = await broadcastControlToTab(
        tabId,
        REC_CMD.START,
        getStartMeta(),
      );
      if (started === false)
        throw new Error("top-frame recorder did not acknowledge START");
    } catch (e) {
      if (appendedStepId) session.rollbackLastStep?.(appendedStepId);
      if (newlyTracked) {
        session.removeActiveTab(activeInfo.tabId);
      }
      await session.persistRecoveryState?.().catch(() => {});
      console.warn("onActivated handler failed", e);
    }
  });

  chrome.webNavigation.onCommitted?.addListener(async (details) => {
    let appendedStepId = "";
    let mutatedTabId: number | null = null;
    try {
      await session.waitUntilReady?.();
      if (session.getStatus() !== "recording") return;
      if (details.frameId !== 0) return;
      const tabId = details.tabId;
      if (!session.hasActiveTab(tabId)) return;
      mutatedTabId = tabId;

      const documentId =
        typeof details.documentId === "string" &&
        details.documentId.length <= 128
          ? details.documentId
          : await getTopDocumentId(tabId);
      session.setActiveTabDocument?.(tabId, documentId);

      const t = details.transitionType;
      const link = t === "link";
      if (!link) {
        const shouldRecord =
          t === "reload" ||
          t === "typed" ||
          t === "generated" ||
          t === "auto_bookmark" ||
          t === "keyword" ||
          // include form_submit to better capture Enter-to-search navigations
          t === "form_submit";
        if (shouldRecord) {
          const tab = await chrome.tabs.get(tabId);
          const url = tab.url || details.url;
          if (session.getFlow() && url) {
            const step: Step = {
              id: "",
              type: STEP_TYPES.NAVIGATE,
              url,
            } as Step;
            const appendResult = session.appendSteps([step]);
            if (appendResult?.truncated) return;
            appendedStepId = step.id;
          }
        }
      }
      // Publish the new document identity and any background-owned navigation
      // node atomically before START. There is no post-START crash window in
      // which that node exists only in worker memory.
      await session.persistRecoveryState?.();

      await ensureRecorderInjected(tabId);
      const started = await broadcastControlToTab(
        tabId,
        REC_CMD.START,
        getStartMeta(),
      );
      if (started === false)
        throw new Error("top-frame recorder did not acknowledge START");

      if (session.getFlow()) {
        session.broadcastTimelineUpdate();
      }
    } catch (e) {
      if (appendedStepId) session.rollbackLastStep?.(appendedStepId);
      if (mutatedTabId !== null) session.removeActiveTab(mutatedTabId);
      await session.persistRecoveryState?.().catch(() => {});
      console.warn("onCommitted handler failed", e);
    }
  });

  // Remove closed tabs from the active set to avoid stale broadcasts
  chrome.tabs.onRemoved?.addListener((tabId) => {
    try {
      // Also prune while paused/stopping so the stop barrier cannot retain a
      // closed tab that will never acknowledge the final flush.
      session.removeActiveTab(tabId);
      void session.persistRecoveryState?.().catch(() => {});
    } catch (e) {
      console.warn("onRemoved handler failed", e);
    }
  });
}
