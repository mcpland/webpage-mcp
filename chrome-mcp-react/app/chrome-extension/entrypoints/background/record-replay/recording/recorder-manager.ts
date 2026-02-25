import type { Flow } from '../types';
import { saveFlow } from '../flow-store';
import { broadcastControlToTab, ensureRecorderInjected, REC_CMD } from './content-injection';
import { recordingSession as session } from './session-manager';
import { createInitialFlow, addNavigationStep } from './flow-builder';
import { initBrowserEventListeners } from './browser-event-listener';
import { initContentMessageHandler } from './content-message-handler';

/** Timeout for waiting for the top-frame content script to acknowledge stop. */
const STOP_BARRIER_TOP_TIMEOUT_MS = 5000;

/** Best-effort stop timeout for subframes (keeps top-frame still listening). */
const STOP_BARRIER_SUBFRAME_TIMEOUT_MS = 1500;

/** Small grace period for in-flight messages after all ACKs. */
const STOP_BARRIER_GRACE_MS = 150;

/** Types for stop barrier results */
interface StopAckStats {
  ack: boolean;
  steps: number;
  variables: number;
}

interface StopFrameAck {
  frameId: number;
  ack: boolean;
  timedOut: boolean;
  error?: string;
  stats?: StopAckStats;
}

interface StopTabBarrierResult {
  tabId: number;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  top?: StopFrameAck;
  subframes: StopFrameAck[];
}

/**
 * List frameIds for a tab. Always includes 0 (main frame).
 */
async function listFrameIds(tabId: number): Promise<number[]> {
  try {
    const res = await chrome.webNavigation.getAllFrames({ tabId });
    const ids = Array.isArray(res)
      ? res.map((f) => f.frameId).filter((n) => typeof n === 'number')
      : [];
    if (!ids.includes(0)) ids.unshift(0);
    return Array.from(new Set(ids)).sort((a, b) => a - b);
  } catch {
    return [0];
  }
}

/**
 * Send stop command to a specific frame and wait for acknowledgment.
 */
async function sendStopToFrameWithAck(
  tabId: number,
  sessionId: string,
  frameId: number,
  timeoutMs: number,
): Promise<StopFrameAck> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      resolve({ frameId, ack: false, timedOut: true });
    }, timeoutMs);

    chrome.tabs
      .sendMessage(
        tabId,
        {
          action: REC_CMD.STOP,
          sessionId,
          requireAck: true,
        },
        { frameId },
      )
      .then((response) => {
        clearTimeout(t);
        const ack = !!(response && response.ack);
        const stats = response && response.stats ? (response.stats as StopAckStats) : undefined;
        resolve({ frameId, ack, timedOut: false, stats });
      })
      .catch((err) => {
        clearTimeout(t);
        resolve({ frameId, ack: false, timedOut: false, error: String(err) });
      });
  });
}

/**
 * Stop a tab with full barrier support.
 * 1. Stop subframes first (so they can finalize and postMessage to top while top is still listening)
 * 2. Stop the main frame (top) and wait for ACK
 */
async function stopTabWithBarrier(tabId: number, sessionId: string): Promise<StopTabBarrierResult> {
  // If the tab is already gone, don't block stop.
  try {
    await chrome.tabs.get(tabId);
  } catch {
    return { tabId, ok: true, skipped: true, reason: 'tab not found', subframes: [] };
  }

  // Ensure recorder is available in frames (best-effort).
  try {
    await ensureRecorderInjected(tabId);
  } catch {}

  const frameIds = await listFrameIds(tabId);
  const subframeIds = frameIds.filter((id) => id !== 0);

  // Stop subframes first so they can finalize and postMessage to top while top is still listening.
  const subframes = await Promise.all(
    subframeIds.map((fid) =>
      sendStopToFrameWithAck(tabId, sessionId, fid, STOP_BARRIER_SUBFRAME_TIMEOUT_MS),
    ),
  );

  // Stop the main frame (top) with longer timeout
  const top = await sendStopToFrameWithAck(tabId, sessionId, 0, STOP_BARRIER_TOP_TIMEOUT_MS);

  return { tabId, ok: top.ack, top, subframes };
}

class RecorderManagerImpl {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    initBrowserEventListeners(session);
    initContentMessageHandler(session);
    this.initialized = true;
  }

  async start(meta?: Partial<Flow>): Promise<{ success: boolean; error?: string }> {
    if (session.getStatus() !== 'idle')
      return { success: false, error: 'Recording already active' };
    // Resolve active tab
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active?.id) return { success: false, error: 'Active tab not found' };

    // Initialize flow & session
    const flow: Flow = createInitialFlow(meta);
    await session.startSession(flow, active.id);

    // Ensure recorder available and start listening
    await ensureRecorderInjected(active.id);
    await broadcastControlToTab(active.id, REC_CMD.START, {
      id: flow.id,
      name: flow.name,
      description: flow.description,
      sessionId: session.getSession().sessionId,
    });
    // Track active tab for targeted STOP broadcasts
    session.addActiveTab(active.id);

    // Record first step
    const url = active.url;
    if (url) {
      addNavigationStep(flow, url);
      try {
        await saveFlow(flow);
      } catch (e) {
        console.warn('RecorderManager: initial saveFlow failed', e);
      }
    }

    return { success: true };
  }

  /**
   * Stop recording with reliable step collection using barrier protocol.
   *
   * Flow:
   * 1. Transition to 'stopping' state (still accepts final steps)
   * 2. For each tab: stop subframes first (best-effort), then stop main frame
   * 3. Wait for main frame ACK (required) with timeout
   * 4. Grace period for any final messages in flight
   * 5. Finalize session and save flow with barrier metadata
   *
   * The barrier ensures:
   * - All tabs have flushed their data before save
   * - Subframes finalize to top before top stops
   * - Barrier status is recorded in flow.meta for debugging
   */
  async stop(): Promise<{ success: boolean; error?: string; flow?: Flow }> {
    const currentStatus = session.getStatus();
    if (currentStatus === 'idle' || !session.getFlow()) {
      return { success: false, error: 'No active recording' };
    }

    // Already stopping - don't double-stop
    if (currentStatus === 'stopping') {
      return { success: false, error: 'Stop already in progress' };
    }

    // Step 1: Transition to stopping state
    const sessionId = session.beginStopping();
    const tabs = session.getActiveTabs();

    // Step 2: Send stop commands to all tabs with full barrier support
    // Each tab: stop subframes first, then stop main frame and wait for ACK
    let results: StopTabBarrierResult[] = [];
    try {
      results = await Promise.all(tabs.map((tabId) => stopTabWithBarrier(tabId, sessionId)));
    } catch (e) {
      console.warn('RecorderManager: Error during stop broadcast:', e);
    }

    // Step 3: Allow a small grace period for any final messages in flight
    await new Promise((resolve) => setTimeout(resolve, STOP_BARRIER_GRACE_MS));

    // Step 4: Finalize - clear session state and save with barrier metadata
    const flow = await session.stopSession();
    const barrierOk = results.length === tabs.length && results.every((r) => r.ok || r.skipped);
    const stoppedAt = new Date().toISOString();

    if (flow) {
      // Add barrier metadata to flow
      try {
        if (!flow.meta) flow.meta = { createdAt: stoppedAt, updatedAt: stoppedAt };
        const failed = results
          .filter((r) => !r.ok || r.skipped || r.subframes.some((sf) => !sf.ack))
          .map((r) => ({
            tabId: r.tabId,
            skipped: r.skipped || undefined,
            reason: r.reason || undefined,
            topTimedOut: r.top?.timedOut || undefined,
            topError: r.top?.error || undefined,
            subframesFailed: r.subframes.filter((sf) => !sf.ack).length || undefined,
          }))
          .slice(0, 20); // Limit to first 20 to avoid bloating metadata

        flow.meta.stopBarrier = {
          ok: barrierOk,
          sessionId,
          stoppedAt,
          failed: failed.length ? failed : undefined,
        };
      } catch {}

      await saveFlow(flow);
    }

    // Return with barrier status
    if (!barrierOk) {
      const failedTabs = results.filter((r) => !r.ok && !r.skipped).map((r) => r.tabId);
      return {
        success: true, // Flow is still saved, but with incomplete barrier
        flow: flow || undefined,
        error: failedTabs.length
          ? `Stop barrier incomplete; missing ACK from tabs: ${failedTabs.join(', ')}`
          : 'Stop barrier incomplete; missing ACK(s)',
      };
    }

    return flow ? { success: true, flow } : { success: true };
  }

  /**
   * Pause recording. Steps are not collected while paused.
   */
  async pause(): Promise<{ success: boolean; error?: string }> {
    if (session.getStatus() !== 'recording') {
      return { success: false, error: 'Not currently recording' };
    }

    session.pause();

    // Broadcast pause to all active tabs
    const tabs = session.getActiveTabs();
    try {
      await Promise.all(tabs.map((id) => broadcastControlToTab(id, REC_CMD.PAUSE)));
    } catch (e) {
      console.warn('RecorderManager: Error during pause broadcast:', e);
    }

    return { success: true };
  }

  /**
   * Resume recording after pause.
   */
  async resume(): Promise<{ success: boolean; error?: string }> {
    if (session.getStatus() !== 'paused') {
      return { success: false, error: 'Not currently paused' };
    }

    session.resume();

    // Broadcast resume to all active tabs
    const tabs = session.getActiveTabs();
    try {
      await Promise.all(tabs.map((id) => broadcastControlToTab(id, REC_CMD.RESUME)));
    } catch (e) {
      console.warn('RecorderManager: Error during resume broadcast:', e);
    }

    return { success: true };
  }
}

export const RecorderManager = new RecorderManagerImpl();
