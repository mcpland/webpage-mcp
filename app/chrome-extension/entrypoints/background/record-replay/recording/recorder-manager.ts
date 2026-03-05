import type { Flow } from '../types';
import { saveFlow } from '../flow-store';
import { broadcastControlToTab, ensureRecorderInjected, REC_CMD } from './content-injection';
import { recordingSession as session } from './session-manager';
import { createInitialFlow, addNavigationStep } from './flow-builder';
import { initBrowserEventListeners } from './browser-event-listener';
import { initContentMessageHandler } from './content-message-handler';
import { broadcastRecordingStateChanged } from './recording-state';
import { recordingNetworkTracker } from './network-tracker';

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

function sanitizeVariableKey(raw: string, fallback: string): string {
  const normalized = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return fallback;
  if (/^[0-9]/.test(normalized)) return `${fallback}_${normalized}`;
  return normalized;
}

function deriveKeyFromSelector(selector: string, fallback: string): string {
  const byName = selector.match(/\[name="([^"]+)"\]/i)?.[1];
  if (byName) return sanitizeVariableKey(byName, fallback);
  const byId = selector.match(/#([a-zA-Z0-9_-]+)/)?.[1];
  if (byId) return sanitizeVariableKey(byId, fallback);
  return fallback;
}

function collectParameterSuggestions(flow: Flow): Array<{
  nodeId: string;
  kind: 'fill' | 'navigate';
  suggestedKey: string;
  currentValue: string;
}> {
  const suggestions: Array<{
    nodeId: string;
    kind: 'fill' | 'navigate';
    suggestedKey: string;
    currentValue: string;
  }> = [];
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  let seq = 1;

  for (const node of nodes) {
    if (!node || !node.id) continue;
    const cfg = node.config && typeof node.config === 'object' ? (node.config as Record<string, unknown>) : {};

    if (node.type === 'fill') {
      const rawValue = typeof cfg.value === 'string' ? cfg.value.trim() : '';
      if (!rawValue) continue;
      if (/^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(rawValue)) continue;
      const selector =
        cfg.target && typeof cfg.target === 'object' && typeof (cfg.target as any).selector === 'string'
          ? String((cfg.target as any).selector)
          : '';
      const key = deriveKeyFromSelector(selector, `input_${seq}`);
      suggestions.push({
        nodeId: node.id,
        kind: 'fill',
        suggestedKey: key,
        currentValue: rawValue,
      });
      seq += 1;
      if (suggestions.length >= 25) break;
      continue;
    }

    if (node.type === 'navigate') {
      const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
      if (!url) continue;
      try {
        const parsed = new URL(url);
        for (const [param, value] of parsed.searchParams.entries()) {
          const trimmedValue = String(value || '').trim();
          if (!trimmedValue) continue;
          suggestions.push({
            nodeId: node.id,
            kind: 'navigate',
            suggestedKey: sanitizeVariableKey(param, `url_param_${seq}`),
            currentValue: trimmedValue,
          });
          seq += 1;
          if (suggestions.length >= 25) break;
        }
      } catch {
        // ignore invalid URLs
      }
      if (suggestions.length >= 25) break;
    }
  }

  return suggestions;
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
    recordingNetworkTracker.init();
    this.initialized = true;
  }

  async start(
    meta?: Partial<Flow>,
    tabId?: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (session.getStatus() !== 'idle')
      return { success: false, error: 'Recording already active' };
    // Resolve target tab (explicit tabId preferred, otherwise active tab)
    let active: chrome.tabs.Tab | null = null;
    if (typeof tabId === 'number') {
      try {
        active = await chrome.tabs.get(tabId);
      } catch {
        return { success: false, error: `Target tab not found: ${tabId}` };
      }
    } else {
      const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
      active = currentActive ?? null;
    }
    if (!active?.id) return { success: false, error: 'Active tab not found' };

    // Initialize flow & session
    const flow: Flow = createInitialFlow(meta);
    try {
      const startedAt = new Date().toISOString();
      const originUrl = typeof active.url === 'string' ? active.url : undefined;
      const originTitle = typeof active.title === 'string' ? active.title : undefined;
      const userAgent =
        typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
          ? navigator.userAgent
          : undefined;
      if (!flow.meta) {
        flow.meta = { createdAt: startedAt, updatedAt: startedAt };
      }
      flow.meta.recording = {
        ...(flow.meta.recording || {}),
        startedAt,
        originUrl,
        originTitle,
        originTabId: active.id,
        browser: 'chrome',
        userAgent,
      };
      if (!flow.meta.domain && originUrl) {
        try {
          flow.meta.domain = new URL(originUrl).hostname;
        } catch {
          // ignore invalid URL
        }
      }
    } catch {
      // ignore metadata enrichment errors
    }
    await session.startSession(flow, active.id);
    broadcastRecordingStateChanged();

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
      broadcastRecordingStateChanged();
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
    broadcastRecordingStateChanged();
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
    broadcastRecordingStateChanged();
    const barrierOk = results.length === tabs.length && results.every((r) => r.ok || r.skipped);
    const stoppedAt = new Date().toISOString();

    if (flow) {
      // Add barrier metadata to flow
      try {
        if (!flow.meta) flow.meta = { createdAt: stoppedAt, updatedAt: stoppedAt };
        const startIso = flow.meta.recording?.startedAt || flow.meta.createdAt;
        const startMs = startIso ? Date.parse(startIso) : NaN;
        const durationMs = Number.isFinite(startMs) ? Math.max(0, Date.now() - startMs) : undefined;
        const stepCount = Array.isArray(flow.nodes)
          ? flow.nodes.length
          : Array.isArray(flow.steps)
            ? flow.steps.length
            : 0;
        const parameterSuggestions = collectParameterSuggestions(flow);
        flow.meta.recording = {
          ...(flow.meta.recording || {}),
          stoppedAt,
          durationMs,
          stepCount,
          parameterSuggestions: parameterSuggestions.length ? parameterSuggestions : undefined,
        };
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
    broadcastRecordingStateChanged();

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
    broadcastRecordingStateChanged();

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
