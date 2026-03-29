import { createErrorResponse, ToolResult } from '@/common/tool-handler';
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

interface TraceSessionState {
  recording: boolean;
  events: any[];
  startedAt: number;
  pageUrl?: string;
  listener: DebuggeeEvent;
  stopResolver?: (value: { completed: boolean }) => void;
  stopPromise?: Promise<{ completed: boolean }>;
}

const sessions = new Map<number, TraceSessionState>();
const LAST_RESULTS = new Map<
  number,
  {
    events: any[];
    startedAt: number;
    endedAt: number;
    tabUrl: string;
    saved?: { downloadId?: number; filename?: string; fullPath?: string };
    metrics?: Record<string, number>;
  }
>();
const TRACE_STOP_TIMEOUT_MS = 10000;
const PERFORMANCE_TRACE_PUBLIC_PAGE_ERROR =
  'Only http:// and https:// pages are supported by performance trace tools';

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

async function saveTraceToDownloads(
  json: string,
  filenamePrefix = 'performance_trace',
): Promise<{ downloadId?: number; filename?: string; fullPath?: string }> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${filenamePrefix}_${timestamp}.json`;
    const dataUrl = `data:application/json;base64,${btoa(unescape(encodeURIComponent(json)))}`;
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
): Promise<{ filename?: string; fullPath?: string } | undefined> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${filenamePrefix}_${timestamp}.json`;
    const base64 = btoa(unescape(encodeURIComponent(json)));

    const requestId = `trace-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = 30000;
    const resp = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error('Native temp save timed out'));
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
            payload: {
              action: 'prepareFile',
              base64Data: base64,
              fileName: filename,
            },
          },
        })
        .catch((err) => {
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          reject(err);
        });
    });

    if (resp && resp.success && resp.filePath) {
      return { filename, fullPath: resp.filePath };
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

function getOrCreateStopPromise(session: TraceSessionState): Promise<{ completed: boolean }> {
  if (session.stopPromise) return session.stopPromise;
  session.stopPromise = new Promise((resolve) => {
    session.stopResolver = resolve;
  });
  return session.stopPromise;
}

async function waitForTraceCompletion(
  session: TraceSessionState,
): Promise<{ completed: boolean }> {
  const stopPromise = getOrCreateStopPromise(session);

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for performance trace completion after ${TRACE_STOP_TIMEOUT_MS}ms`,
        ),
      );
    }, TRACE_STOP_TIMEOUT_MS);

    stopPromise.then(
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

async function cleanupTraceSession(
  tabId: number,
  session?: TraceSessionState,
): Promise<void> {
  const activeSession = session ?? sessions.get(tabId);

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

  sessions.delete(tabId);
}

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
      if (existed?.recording) {
        return {
          content: [{ type: 'text', text: 'Error: a performance trace is already running.' }],
          isError: true,
        };
      }

      await cdpSessionManager.attach(tabId, 'performance');

      state = {
        recording: true,
        events: [],
        startedAt: Date.now(),
        pageUrl: activeTab.url || '',
        listener: (source, method, params) => {
          if (source.tabId !== tabId) return;
          if (method === 'Tracing.dataCollected' && params?.value) {
            try {
              state.events.push(...(params.value as any[]));
            } catch {
              // ignore
            }
          } else if (method === 'Tracing.tracingComplete') {
            state.recording = false;
            state.stopResolver?.({ completed: true });
          }
        },
      };
      chrome.debugger.onEvent.addListener(state.listener);
      sessions.set(tabId, state);

      // Start tracing with categories
      const cats = tracingCategories().join(',');
      await cdpSessionManager.sendCommand(tabId, 'Tracing.start', {
        categories: cats,
        options: 'record-as-much-as-possible',
        transferMode: 'ReportEvents',
      });

      if (reload) {
        try {
          await cdpSessionManager.sendCommand(tabId, 'Page.reload', { ignoreCache: true });
        } catch {
          // best effort; ignore if fails
        }
      }

      if (autoStop) {
        setTimeout(
          async () => {
            try {
              await cdpSessionManager.sendCommand(tabId, 'Tracing.end');
            } catch {
              // ignore
            }
          },
          Math.max(1000, Math.min(durationMs, 60000)),
        );
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
        await cdpSessionManager.sendCommand(tabId, 'Tracing.end');
        stopResult = await waitForTraceCompletion(session);
      } else {
        // Already auto-stopped; proceed to finalize without waiting
        stopResult = { completed: true };
      }

      const endedAt = Date.now();
      if (discardNonPublicTrace) {
        LAST_RESULTS.delete(tabId);
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
                durationMs: endedAt - session.startedAt,
                tracingCompleted: stopResult?.completed === true,
              }),
            },
          ],
          isError: false,
        };
      }

      // Fetch metrics before detach
      const metrics = await enablePerformanceMetrics(tabId);

      const trace = { traceEvents: session.events };
      const json = JSON.stringify(trace);

      let saved: { downloadId?: number; filename?: string; fullPath?: string } | undefined;
      if (saveToDownloads) {
        saved = await saveTraceToDownloads(json, filenamePrefix || 'performance_trace');
      } else {
        // Persist to native temp directory so that analysis can run without Downloads permission
        const tempSaved = await saveTraceToNativeTemp(json, filenamePrefix || 'performance_trace');
        if (tempSaved) {
          saved = { ...tempSaved } as any;
        }
      }

      LAST_RESULTS.set(tabId, {
        events: session.events,
        startedAt: session.startedAt,
        endedAt,
        tabUrl: session.pageUrl || '',
        saved,
        metrics,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'The performance trace has been stopped.',
              eventCount: session.events.length,
              saved,
              metrics,
              startedAt: session.startedAt,
              endedAt,
              durationMs: endedAt - session.startedAt,
              url: session.pageUrl || '',
              tracingCompleted: stopResult?.completed === true,
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
      const result = LAST_RESULTS.get(tabId);
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
        LAST_RESULTS.delete(tabId);
        return createErrorResponse(
          'Performance traces recorded on non-public pages are not available via public tools',
        );
      }

      // Prefer native-side deep analysis when we have a saved file path
      const fullPath = (result.saved && (result.saved as any).fullPath) || undefined;
      if (fullPath) {
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
            // Best-effort cleanup for temp files (Downloads paths are ignored by native cleaner)
            await cleanupNativeTempFile(fullPath);
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
                    saved: result.saved,
                    summary: resp.summary,
                    insight: resp.insight,
                  }),
                },
              ],
              isError: false,
            };
          }
          // If native returned error, fall through to lightweight analysis
        } catch (e) {
          // Fallback to lightweight analysis below
        }
      }

      // Lightweight fallback (when no saved file path)
      const counts = new Map<string, number>();
      for (const ev of result.events.slice(0, 100000)) {
        const n = typeof (ev as any)?.name === 'string' ? (ev as any).name : 'unknown';
        counts.set(n, (counts.get(n) || 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([name, count]) => ({ name, count }));

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
              topEventNames: top,
              saved: result.saved,
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
