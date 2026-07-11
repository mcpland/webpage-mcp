import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { toPublicDownloadLocation } from '@/entrypoints/background/download-paths';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

type OwnerTag = 'performance';

interface StartTraceParams {
  reload?: boolean; // whether to reload the page after starting trace
  autoStop?: boolean; // whether to auto stop after a short duration
  durationMs?: number; // custom duration when autoStop is true (default 5000)
  tabId?: number;
  windowId?: number;
}

interface StopTraceParams {
  saveToDownloads?: boolean; // save trace to Downloads as JSON (default true)
  filenamePrefix?: string; // filename prefix (default 'performance_trace')
  tabId?: number;
  windowId?: number;
}

interface AnalyzeInsightParams {
  insightName?: string; // placeholder for future deep insights
  tabId?: number;
  windowId?: number;
}

type DebuggeeEvent = (source: chrome.debugger.Debuggee, method: string, params?: any) => void;

type TraceTruncationReason =
  | 'max_duration'
  | 'max_event_count'
  | 'max_serialized_bytes'
  | 'debugger_detached';
type TraceStopReason = TraceTruncationReason | 'manual' | 'auto_stop' | 'tab_closed';

const TRACE_STOP_TIMEOUT_MS = 10000;
const TRACE_MAX_DURATION_MS = 60_000;
const TRACE_MAX_EVENTS = 50_000;
const TRACE_MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;
const TRACE_EMPTY_JSON_BYTES = utf8ByteLength('{"traceEvents":[]}');
const LAST_RESULTS_MAX_ENTRIES = 5;
const LAST_RESULTS_TTL_MS = 10 * 60_000;
const TRACE_ALARM_PREFIX = 'performance-trace-stop:';
const RESULT_ALARM_PREFIX = 'performance-trace-result-expiry:';

interface TraceSessionState {
  recording: boolean;
  serializedEvents: string[];
  eventNameCounts: Map<string, number>;
  observedEventCount: number;
  serializedBytes: number;
  startedAt: number;
  pageUrl?: string;
  listener: DebuggeeEvent;
  stopResolver: (value: { completed: boolean }) => void;
  stopPromise: Promise<{ completed: boolean }>;
  traceCompleted: boolean;
  endRequested: boolean;
  endRequestPromise?: Promise<void>;
  alarmName: string;
  timedStopReason: 'auto_stop' | 'max_duration';
  truncated: boolean;
  truncationReason?: TraceTruncationReason;
  stopReason?: TraceStopReason;
}

function createTraceSessionState(
  tabId: number,
  pageUrl: string,
  timedStopReason: 'auto_stop' | 'max_duration',
): TraceSessionState {
  let stopResolver!: (value: { completed: boolean }) => void;
  const stopPromise = new Promise<{ completed: boolean }>((resolve) => {
    stopResolver = resolve;
  });
  const state: TraceSessionState = {
    recording: true,
    serializedEvents: [],
    eventNameCounts: new Map(),
    observedEventCount: 0,
    serializedBytes: TRACE_EMPTY_JSON_BYTES,
    startedAt: Date.now(),
    pageUrl,
    listener: () => undefined,
    stopResolver,
    stopPromise,
    traceCompleted: false,
    endRequested: false,
    alarmName: `${TRACE_ALARM_PREFIX}${tabId}`,
    timedStopReason,
    truncated: false,
  };

  state.listener = (source, method, params) => {
    if (source.tabId !== tabId) return;
    if (method === 'Tracing.dataCollected' && Array.isArray(params?.value)) {
      collectTraceEvents(tabId, state, params.value as any[]);
    } else if (method === 'Tracing.tracingComplete') {
      state.recording = false;
      state.traceCompleted = true;
      state.stopResolver({ completed: true });
      void chrome.alarms.clear(state.alarmName);
    }
  };

  return state;
}

type SavedTraceArtifact = {
  downloadId?: number;
  filename?: string;
  fullPath?: string;
  temporary?: boolean;
};

interface LastTraceResult {
  eventCount: number;
  observedEventCount: number;
  serializedBytes: number;
  topEventNames: Array<{ name: string; count: number }>;
  startedAt: number;
  endedAt: number;
  expiresAt: number;
  tabUrl: string;
  saved?: SavedTraceArtifact;
  /** Native-host private copy used for one-shot deep analysis. */
  analysisFilePath?: string;
  metrics?: Record<string, number>;
  truncated: boolean;
  truncationReason?: TraceTruncationReason;
  stopReason?: TraceStopReason;
}

const sessions = new Map<number, TraceSessionState>();
const LAST_RESULTS = new Map<number, LastTraceResult>();
const PERFORMANCE_TRACE_PUBLIC_PAGE_ERROR =
  'Only http:// and https:// pages are supported by performance trace tools';

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function traceLimitMetadata(session: TraceSessionState | LastTraceResult) {
  const retainedEventCount =
    'eventCount' in session ? session.eventCount : session.serializedEvents.length;
  return {
    truncated: session.truncated,
    truncationReason: session.truncationReason || null,
    stopReason: session.stopReason || null,
    observedEventCount: session.observedEventCount,
    droppedEventCount: Math.max(0, session.observedEventCount - retainedEventCount),
    serializedBytes: session.serializedBytes,
    limits: {
      maxDurationMs: TRACE_MAX_DURATION_MS,
      maxEventCount: TRACE_MAX_EVENTS,
      maxSerializedBytes: TRACE_MAX_SERIALIZED_BYTES,
    },
  };
}

function markTraceTruncated(state: TraceSessionState, reason: TraceTruncationReason): void {
  if (!state.truncated) {
    state.truncated = true;
    state.truncationReason = reason;
  }
  state.stopReason ||= reason;
}

function collectTraceEvents(tabId: number, state: TraceSessionState, values: any[]): void {
  if (!state.recording || state.endRequested || sessions.get(tabId) !== state) {
    return;
  }

  state.observedEventCount += values.length;
  let limitReason: TraceTruncationReason | undefined;

  for (const event of values) {
    if (state.serializedEvents.length >= TRACE_MAX_EVENTS) {
      limitReason = 'max_event_count';
      break;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(event) ?? 'null';
    } catch {
      continue;
    }

    const additionalBytes =
      utf8ByteLength(serialized) + (state.serializedEvents.length > 0 ? 1 : 0);
    if (state.serializedBytes + additionalBytes > TRACE_MAX_SERIALIZED_BYTES) {
      limitReason = 'max_serialized_bytes';
      break;
    }

    state.serializedEvents.push(serialized);
    state.serializedBytes += additionalBytes;
    const eventName = typeof event?.name === 'string' ? event.name : 'unknown';
    state.eventNameCounts.set(eventName, (state.eventNameCounts.get(eventName) || 0) + 1);

    if (state.serializedEvents.length >= TRACE_MAX_EVENTS) {
      limitReason = 'max_event_count';
      break;
    }
    if (state.serializedBytes >= TRACE_MAX_SERIALIZED_BYTES) {
      limitReason = 'max_serialized_bytes';
      break;
    }
  }

  if (limitReason) {
    markTraceTruncated(state, limitReason);
    void requestTraceEnd(tabId, state, limitReason).catch(() => cleanupTraceSession(tabId, state));
  }
}

function hasDisallowedPublicPageScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== 'http' && protocol !== 'https';
}

function isNonPublicPageUrl(url: string | undefined): boolean {
  return typeof url === 'string' && hasDisallowedPublicPageScheme(url);
}

function tracingCategories(): string[] {
  // Keep broadly consistent with other project
  return [
    '-*',
    'blink.console',
    'blink.user_timing',
    'devtools.timeline',
    'disabled-by-default-devtools.screenshot',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.invalidationTracking',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-v8.cpu_profiler',
    'disabled-by-default-v8.cpu_profiler.hires',
    'latencyInfo',
    'loading',
    'disabled-by-default-lighthouse',
    'v8.execute',
    'v8',
  ];
}

async function enablePerformanceMetrics(tabId: number): Promise<Record<string, number>> {
  try {
    await cdpSessionManager.sendCommand(tabId, 'Performance.enable');
    const result = (await cdpSessionManager.sendCommand(tabId, 'Performance.getMetrics')) as {
      metrics: Array<{ name: string; value: number }>;
    };
    await cdpSessionManager.sendCommand(tabId, 'Performance.disable');
    const map: Record<string, number> = {};
    for (const m of result.metrics || []) map[m.name] = m.value;
    return map;
  } catch (e) {
    return {};
  }
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

async function saveTraceToDownloads(
  json: string,
  filenamePrefix = 'performance_trace',
): Promise<SavedTraceArtifact> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${filenamePrefix}_${timestamp}.json`;
    const dataUrl = `data:application/json;base64,${utf8ToBase64(json)}`;
    const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    // Attempt to resolve full path
    try {
      await new Promise((r) => setTimeout(r, 120));
      const [item] = await chrome.downloads.search({ id: downloadId });
      return { downloadId, filename, fullPath: item?.filename };
    } catch {
      return { downloadId, filename };
    }
  } catch {
    return {};
  }
}

async function saveTraceToNativeTemp(
  json: string,
  filenamePrefix = 'performance_trace',
): Promise<SavedTraceArtifact | undefined> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${filenamePrefix}_${timestamp}.json`;
    const base64 = utf8ToBase64(json);

    const requestId = `trace-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = 30000;
    const resp = await new Promise<any>((resolve, reject) => {
      let settled = false;
      const finish = (result: { ok: true; value: any } | { ok: false; error: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        if (result.ok) resolve(result.value);
        else reject(result.error);
      };
      const timer = setTimeout(() => {
        finish({ ok: false, error: new Error('Native temp save timed out') });
      }, timeoutMs);
      const listener = (message: any) => {
        if (
          message &&
          message.type === 'file_operation_response' &&
          message.responseToRequestId === requestId
        ) {
          finish({ ok: true, value: message.payload });
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      let acknowledgement: Promise<any>;
      try {
        acknowledgement = chrome.runtime.sendMessage({
          type: 'forward_to_native',
          message: {
            type: 'file_operation',
            requestId,
            payload: {
              action: 'prepareFile',
              base64Data: base64,
              fileName: filename,
            },
          },
        });
      } catch (error) {
        finish({ ok: false, error });
        return;
      }
      acknowledgement
        .then((ack) => {
          if (!ack || ack.success !== true) {
            finish({
              ok: false,
              error: new Error(ack?.error || 'Native host did not accept trace preparation'),
            });
          }
        })
        .catch((error) => {
          finish({ ok: false, error });
        });
    });

    if (resp && resp.success && resp.filePath) {
      return { filename, fullPath: resp.filePath, temporary: true };
    }
  } catch {
    // ignore, fallback will apply
  }
  return undefined;
}

async function cleanupNativeTempFile(filePath: string): Promise<void> {
  if (!filePath) return;
  try {
    const requestId = `trace-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = 10000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve(); // best-effort
      }, timeoutMs);
      const listener = (message: any) => {
        if (
          message &&
          message.type === 'file_operation_response' &&
          message.responseToRequestId === requestId
        ) {
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          resolve();
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.runtime
        .sendMessage({
          type: 'forward_to_native',
          message: {
            type: 'file_operation',
            requestId,
            payload: {
              action: 'cleanupFile',
              filePath,
            },
          },
        })
        .catch(() => {
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          resolve();
        });
    });
  } catch {
    // ignore
  }
}

function toPublicSavedTraceArtifact(saved?: SavedTraceArtifact): {
  downloadId?: number;
  filename?: string;
  pathRedacted: true;
} | undefined {
  if (!saved) {
    return undefined;
  }

  return {
    ...(typeof saved.downloadId === 'number' ? { downloadId: saved.downloadId } : {}),
    ...toPublicDownloadLocation(saved),
  };
}

async function waitForTraceCompletion(session: TraceSessionState): Promise<{ completed: boolean }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for performance trace completion after ${TRACE_STOP_TIMEOUT_MS}ms`,
        ),
      );
    }, TRACE_STOP_TIMEOUT_MS);

    session.stopPromise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function requestTraceEnd(
  tabId: number,
  session: TraceSessionState,
  reason: TraceStopReason,
): Promise<void> {
  if (session.endRequestPromise) {
    return session.endRequestPromise;
  }
  if (!session.recording || session.traceCompleted || sessions.get(tabId) !== session) {
    return Promise.resolve();
  }

  session.endRequested = true;
  session.stopReason ||= reason;
  session.endRequestPromise = cdpSessionManager
    .sendCommand(tabId, 'Tracing.end')
    .then(() => undefined);
  return session.endRequestPromise;
}

function summarizeEventNames(
  counts: ReadonlyMap<string, number>,
): Array<{ name: string; count: number }> {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));
}

function resultAlarmName(tabId: number): string {
  return `${RESULT_ALARM_PREFIX}${tabId}`;
}

function disposeLastResult(tabId: number, result: LastTraceResult): void {
  void chrome.alarms.clear(resultAlarmName(tabId));
  if (result.analysisFilePath) {
    const analysisFilePath = result.analysisFilePath;
    result.analysisFilePath = undefined;
    void cleanupNativeTempFile(analysisFilePath);
  }
}

function deleteLastResult(tabId: number): void {
  const result = LAST_RESULTS.get(tabId);
  if (!result) return;
  LAST_RESULTS.delete(tabId);
  disposeLastResult(tabId, result);
}

function pruneLastResults(now = Date.now()): void {
  for (const [tabId, result] of LAST_RESULTS) {
    if (result.expiresAt <= now) {
      deleteLastResult(tabId);
    }
  }

  while (LAST_RESULTS.size > LAST_RESULTS_MAX_ENTRIES) {
    const oldestTabId = LAST_RESULTS.keys().next().value as number | undefined;
    if (typeof oldestTabId !== 'number') break;
    deleteLastResult(oldestTabId);
  }
}

function storeLastResult(tabId: number, result: LastTraceResult): void {
  const previous = LAST_RESULTS.get(tabId);
  if (previous) {
    LAST_RESULTS.delete(tabId);
    if (previous.analysisFilePath) {
      const analysisFilePath = previous.analysisFilePath;
      previous.analysisFilePath = undefined;
      void cleanupNativeTempFile(analysisFilePath);
    }
  }
  LAST_RESULTS.set(tabId, result);
  pruneLastResults();
  // Creating an alarm with the same name atomically replaces the prior expiry.
  void chrome.alarms.create(resultAlarmName(tabId), { when: result.expiresAt });
}

function getLastResult(tabId: number): LastTraceResult | undefined {
  pruneLastResults();
  const result = LAST_RESULTS.get(tabId);
  if (!result) return undefined;

  // Refresh insertion order for strict LRU without extending the absolute TTL.
  LAST_RESULTS.delete(tabId);
  LAST_RESULTS.set(tabId, result);
  return result;
}

async function cleanupTraceSession(tabId: number, session?: TraceSessionState): Promise<void> {
  const activeSession = session ?? sessions.get(tabId);

  if (activeSession && sessions.get(tabId) === activeSession) {
    sessions.delete(tabId);
  }

  if (activeSession) {
    activeSession.recording = false;
    activeSession.stopResolver({ completed: activeSession.traceCompleted });
    activeSession.serializedEvents.length = 0;
    activeSession.eventNameCounts.clear();
    try {
      await chrome.alarms.clear(activeSession.alarmName);
    } catch {
      // ignore
    }
  }

  try {
    if (activeSession) {
      chrome.debugger.onEvent.removeListener(activeSession.listener);
    }
  } catch {
    // ignore
  }

  try {
    await cdpSessionManager.detach(tabId, 'performance');
  } catch {
    // ignore
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(TRACE_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(TRACE_ALARM_PREFIX.length));
    const session = sessions.get(tabId);
    if (!session) return;

    if (session.timedStopReason === 'max_duration') {
      markTraceTruncated(session, 'max_duration');
    }
    void requestTraceEnd(tabId, session, session.timedStopReason).catch(() =>
      cleanupTraceSession(tabId, session),
    );
    return;
  }

  if (alarm.name.startsWith(RESULT_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(RESULT_ALARM_PREFIX.length));
    const result = LAST_RESULTS.get(tabId);
    if (!result) return;
    if (result.expiresAt <= Date.now()) {
      deleteLastResult(tabId);
    } else {
      void chrome.alarms.create(resultAlarmName(tabId), {
        when: result.expiresAt,
      });
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  deleteLastResult(tabId);
  const session = sessions.get(tabId);
  if (!session) return;
  session.stopReason ||= 'tab_closed';
  void cleanupTraceSession(tabId, session);
});

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId !== 'number') return;
  const session = sessions.get(source.tabId);
  if (!session) return;
  markTraceTruncated(session, 'debugger_detached');
  void cleanupTraceSession(source.tabId, session);
});

/**
 * Start performance trace
 */
class PerformanceStartTraceTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PERFORMANCE_START_TRACE;

  async execute(args: StartTraceParams): Promise<ToolResult> {
    const {
      reload = false,
      autoStop = false,
      durationMs = 5000,
      tabId: targetTabIdParam,
      windowId,
    } = args || {};

    let tabId: number | undefined;
    let state: TraceSessionState | undefined;

    try {
      const explicit = await this.tryGetTab(targetTabIdParam);
      const activeTab = explicit || (await this.getActiveTabInWindow(windowId));
      if (!activeTab?.id) {
        return createErrorResponse('No active tab found');
      }
      if (isNonPublicPageUrl(activeTab.url)) {
        return createErrorResponse(PERFORMANCE_TRACE_PUBLIC_PAGE_ERROR);
      }
      tabId = activeTab.id;
      const existed = sessions.get(tabId);
      if (existed) {
        return {
          content: [{ type: 'text', text: 'Error: a performance trace is already running.' }],
          isError: true,
        };
      }

      await cdpSessionManager.attach(tabId, 'performance');

      const requestedDurationMs =
        typeof durationMs === 'number' && Number.isFinite(durationMs)
          ? Math.max(1000, durationMs)
          : 5000;
      const effectiveDurationMs = autoStop
        ? Math.min(requestedDurationMs, TRACE_MAX_DURATION_MS)
        : TRACE_MAX_DURATION_MS;
      const timedStopReason =
        autoStop && requestedDurationMs <= TRACE_MAX_DURATION_MS ? 'auto_stop' : 'max_duration';

      state = createTraceSessionState(tabId, activeTab.url || '', timedStopReason);
      chrome.debugger.onEvent.addListener(state.listener);
      sessions.set(tabId, state);

      // Start tracing with categories
      const cats = tracingCategories().join(',');
      await cdpSessionManager.sendCommand(tabId, 'Tracing.start', {
        categories: cats,
        options: 'record-as-much-as-possible',
        transferMode: 'ReportEvents',
      });

      await chrome.alarms.create(state.alarmName, {
        when: state.startedAt + effectiveDurationMs,
      });

      if (reload) {
        try {
          await cdpSessionManager.sendCommand(tabId, 'Page.reload', { ignoreCache: true });
        } catch {
          // best effort; ignore if fails
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Performance trace is recording. Use performance_stop_trace to stop it.',
              reload,
              autoStop,
              durationMs: effectiveDurationMs,
              limits: {
                maxDurationMs: TRACE_MAX_DURATION_MS,
                maxEventCount: TRACE_MAX_EVENTS,
                maxSerializedBytes: TRACE_MAX_SERIALIZED_BYTES,
              },
            }),
          },
        ],
        isError: false,
      };
    } catch (e: any) {
      if (typeof tabId === 'number') {
        await cleanupTraceSession(tabId, state);
      }
      return createErrorResponse(`Failed to start performance trace: ${e?.message || e}`);
    }
  }
}

/**
 * Stop performance trace
 */
class PerformanceStopTraceTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PERFORMANCE_STOP_TRACE;

  async execute(args: StopTraceParams): Promise<ToolResult> {
    const {
      saveToDownloads = true,
      filenamePrefix,
      tabId: targetTabIdParam,
      windowId,
    } = args || {};
    let tabId: number | undefined;
    let session: TraceSessionState | undefined;

    try {
      const explicit = await this.tryGetTab(targetTabIdParam);
      const activeTab = explicit || (await this.getActiveTabInWindow(windowId));
      if (!activeTab?.id) return createErrorResponse('No active tab found');
      tabId = activeTab.id;
      session = sessions.get(tabId);
      if (!session) {
        return {
          content: [
            { type: 'text', text: 'No performance trace session found for the current tab.' },
          ],
          isError: false,
        };
      }

      const discardNonPublicTrace =
        isNonPublicPageUrl(activeTab.url) || isNonPublicPageUrl(session.pageUrl);

      let stopResult: { completed: boolean } = { completed: false };
      if (session.recording) {
        // End tracing and wait for completion signal
        await requestTraceEnd(tabId, session, 'manual');
        stopResult = session.traceCompleted
          ? { completed: true }
          : await waitForTraceCompletion(session);
      } else {
        // Already auto-stopped; proceed to finalize without waiting
        stopResult = { completed: session.traceCompleted };
      }

      if (sessions.get(tabId) !== session) {
        return createErrorResponse('Performance trace session ended before it could be finalized');
      }

      const endedAt = Date.now();
      if (discardNonPublicTrace) {
        deleteLastResult(tabId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                discarded: true,
                message:
                  'Stopped a performance trace on a non-public page. Trace data was discarded.',
                startedAt: session.startedAt,
                endedAt,
                eventCount: session.serializedEvents.length,
                durationMs: endedAt - session.startedAt,
                tracingCompleted: stopResult?.completed === true,
                ...traceLimitMetadata(session),
              }),
            },
          ],
          isError: false,
        };
      }

      // Fetch metrics before detach
      const metrics = await enablePerformanceMetrics(tabId);

      const eventCount = session.serializedEvents.length;
      const topEventNames = summarizeEventNames(session.eventNameCounts);
      let json = `{"traceEvents":[${session.serializedEvents.join(',')}]}`;
      const actualSerializedBytes = utf8ByteLength(json);
      if (actualSerializedBytes > TRACE_MAX_SERIALIZED_BYTES) {
        throw new Error('Performance trace exceeded its serialized byte limit');
      }
      session.serializedBytes = actualSerializedBytes;

      let saved: SavedTraceArtifact | undefined;
      let analysisFilePath: string | undefined;
      if (saveToDownloads) {
        saved = await saveTraceToDownloads(json, filenamePrefix || 'performance_trace');
        // Downloads paths are outside the native host's private directory. Preserve deep
        // analysis by creating a bounded private copy while the trace JSON is still in memory.
        analysisFilePath = (
          await saveTraceToNativeTemp(json, `${filenamePrefix || 'performance_trace'}_analysis`)
        )?.fullPath;
      } else {
        // Persist to native temp directory so that analysis can run without Downloads permission
        const tempSaved = await saveTraceToNativeTemp(json, filenamePrefix || 'performance_trace');
        if (tempSaved) {
          saved = tempSaved;
          analysisFilePath = tempSaved.fullPath;
        }
      }
      json = '';

      const publicSaved = toPublicSavedTraceArtifact(saved);

      storeLastResult(tabId, {
        eventCount,
        observedEventCount: session.observedEventCount,
        serializedBytes: session.serializedBytes,
        topEventNames,
        startedAt: session.startedAt,
        endedAt,
        expiresAt: endedAt + LAST_RESULTS_TTL_MS,
        tabUrl: session.pageUrl || '',
        saved,
        analysisFilePath,
        metrics,
        truncated: session.truncated,
        truncationReason: session.truncationReason,
        stopReason: session.stopReason,
      });

      // Raw trace strings are only needed while saving. Keep summaries in LAST_RESULTS.
      session.serializedEvents.length = 0;
      session.eventNameCounts.clear();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'The performance trace has been stopped.',
              eventCount,
              saved: publicSaved,
              metrics,
              startedAt: session.startedAt,
              endedAt,
              durationMs: endedAt - session.startedAt,
              url: session.pageUrl || '',
              tracingCompleted: stopResult?.completed === true,
              ...traceLimitMetadata(session),
            }),
          },
        ],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Failed to stop performance trace: ${e?.message || e}`);
    } finally {
      if (typeof tabId === 'number' && session) {
        await cleanupTraceSession(tabId, session);
      }
    }
  }
}

/**
 * Analyze last trace (lightweight)
 * Note: Deep insights require DevTools front-end trace engine on the native side; this is a
 * pragmatic first step returning basic metrics and a quick event histogram.
 */
class PerformanceAnalyzeInsightTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PERFORMANCE_ANALYZE_INSIGHT;

  async execute(args: AnalyzeInsightParams & { timeoutMs?: number }): Promise<ToolResult> {
    const { insightName, tabId: targetTabIdParam, windowId } = args || {};
    try {
      const explicit = await this.tryGetTab(targetTabIdParam);
      const activeTab = explicit || (await this.getActiveTabInWindow(windowId));
      if (!activeTab?.id) return createErrorResponse('No active tab found');
      if (isNonPublicPageUrl(activeTab.url)) {
        return createErrorResponse(PERFORMANCE_TRACE_PUBLIC_PAGE_ERROR);
      }
      const tabId = activeTab.id;
      const result = getLastResult(tabId);
      if (!result) {
        return {
          content: [
            {
              type: 'text',
              text: 'No recorded traces found. Start and stop a performance trace first.',
            },
          ],
          isError: false,
        };
      }
      if (isNonPublicPageUrl(result.tabUrl)) {
        deleteLastResult(tabId);
        return createErrorResponse(
          'Performance traces recorded on non-public pages are not available via public tools',
        );
      }

      // Prefer native-side deep analysis when we have a saved file path
      const fullPath = result.analysisFilePath;
      if (fullPath) {
        const temporarySavedArtifact =
          result.saved?.temporary === true && result.saved.fullPath === fullPath;
        try {
          const requestId = `trace-analyze-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const timeoutMs = Math.max(10000, Math.min((args as any)?.timeoutMs ?? 60000, 300000));
          const resp = await new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
              chrome.runtime.onMessage.removeListener(listener);
              reject(new Error('Native trace analysis timed out'));
            }, timeoutMs);
            const listener = (message: any) => {
              if (
                message &&
                message.type === 'file_operation_response' &&
                message.responseToRequestId === requestId
              ) {
                clearTimeout(timer);
                chrome.runtime.onMessage.removeListener(listener);
                resolve(message.payload);
              }
            };
            chrome.runtime.onMessage.addListener(listener);
            chrome.runtime
              .sendMessage({
                type: 'forward_to_native',
                message: {
                  type: 'file_operation',
                  requestId,
                  payload: { action: 'analyzeTrace', traceFilePath: fullPath, insightName },
                },
              })
              .catch((err) => {
                clearTimeout(timer);
                chrome.runtime.onMessage.removeListener(listener);
                reject(err);
              });
          });
          if (resp && resp.success) {
            const publicSaved = toPublicSavedTraceArtifact(result.saved);
            if (temporarySavedArtifact) {
              result.saved = publicSaved
                ? { filename: publicSaved.filename, temporary: false }
                : undefined;
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    url: result.tabUrl,
                    startedAt: result.startedAt,
                    endedAt: result.endedAt,
                    durationMs: result.endedAt - result.startedAt,
                    metrics: result.metrics || {},
                    saved: publicSaved,
                    summary: resp.summary,
                    insight: resp.insight,
                    eventCount: result.eventCount,
                    ...traceLimitMetadata(result),
                  }),
                },
              ],
              isError: false,
            };
          }
          // If native returned error, fall through to lightweight analysis
        } catch (e) {
          // Fallback to lightweight analysis below
        } finally {
          // Deep analysis is one-shot. Always release the private native artifact, including
          // parser failures and messaging timeouts; download artifacts remain untouched.
          if (result.analysisFilePath === fullPath) {
            result.analysisFilePath = undefined;
          }
          await cleanupNativeTempFile(fullPath);
          if (temporarySavedArtifact && result.saved?.temporary) {
            result.saved = result.saved.filename
              ? { filename: result.saved.filename, temporary: false }
              : undefined;
          }
        }
      }

      // Lightweight fallback (when no saved file path)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              info: 'Lightweight analysis (no saved file path). Native-side deep analysis unavailable.',
              requestedInsight: insightName || null,
              url: result.tabUrl,
              startedAt: result.startedAt,
              endedAt: result.endedAt,
              durationMs: result.endedAt - result.startedAt,
              metrics: result.metrics || {},
              eventCount: result.eventCount,
              topEventNames: result.topEventNames,
              saved: toPublicSavedTraceArtifact(result.saved),
              ...traceLimitMetadata(result),
            }),
          },
        ],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Failed to analyze trace: ${e?.message || e}`);
    }
  }
}

export const performanceStartTraceTool = new PerformanceStartTraceTool();
export const performanceStopTraceTool = new PerformanceStopTraceTool();
export const performanceAnalyzeInsightTool = new PerformanceAnalyzeInsightTool();
