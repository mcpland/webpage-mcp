import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { toDownloadDisplayName } from '@/entrypoints/background/download-paths';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { hasDisallowedPublicUrlScheme } from './common';

interface HandleDownloadParams {
  filenameContains?: string;
  timeoutMs?: number; // default 60000
  waitForComplete?: boolean; // default true
}

// How far back handle_download looks for a download the agent already triggered.
const RECENT_DOWNLOAD_LOOKBACK_MS = 60_000;
const MAX_REPORTED_DOWNLOAD_IDS = 100;
// Downloads already returned to a caller; each download is reported once.
const reportedDownloadIds = new Set<number>();

function toPublicDownloadUrl(url?: string | null): { url?: string | null; urlRedacted?: true } {
  if (typeof url !== 'string' || !url.trim()) {
    return {};
  }

  if (hasDisallowedPublicUrlScheme(url)) {
    return {
      url: null,
      urlRedacted: true,
    };
  }

  return { url };
}

/**
 * Tool: wait for a download and return info
 */
class HandleDownloadTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD as any;

  async execute(
    args: HandleDownloadParams,
    context?: { signal?: AbortSignal },
  ): Promise<ToolResult> {
    const filenameContains = String(args?.filenameContains || '').trim();
    const waitForComplete = args?.waitForComplete !== false;
    const timeoutMs = Math.max(1000, Math.min(Number(args?.timeoutMs ?? 60000), 300000));

    try {
      const result = await waitForDownload({
        filenameContains,
        waitForComplete,
        timeoutMs,
        signal: context?.signal,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, download: result }) }],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Handle download failed: ${e?.message || String(e)}`);
    }
  }
}

export interface WaitForDownloadOptions {
  filenameContains?: string;
  waitForComplete: boolean;
  timeoutMs: number;
  /** Ignore downloads that already exist; only report one created after arming. */
  onlyNew?: boolean;
  signal?: AbortSignal;
}

function parseDownloadTimestamp(value?: string | null): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Test hook: forget which downloads were already reported. */
export function resetReportedDownloadsForTests(): void {
  reportedDownloadIds.clear();
}

function rememberReported(id: number): void {
  reportedDownloadIds.add(id);
  while (reportedDownloadIds.size > MAX_REPORTED_DOWNLOAD_IDS) {
    const oldest = reportedDownloadIds.values().next().value;
    if (oldest === undefined) break;
    reportedDownloadIds.delete(oldest);
  }
}

/**
 * Wait for a download and return its sanitized details.
 *
 * Agents usually click first and ask about the download in a later turn, so a
 * recent download that was not reported before is returned immediately (the
 * newest one wins). Otherwise the next matching download is awaited.
 */
export function waitForDownload(opts: WaitForDownloadOptions): Promise<any> {
  const { filenameContains, waitForComplete, timeoutMs, onlyNew, signal } = opts;
  const armedAt = Date.now();
  return new Promise<any>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    // A specific in-progress download we are waiting to finish.
    let awaitedId: number | undefined;
    // Track downloads created after arming so onChanged can tell newly started
    // downloads apart from stale historical items (e.g. deleted from disk).
    const createdSinceArming = new Set<number>();
    const lookbackStart = armedAt - RECENT_DOWNLOAD_LOOKBACK_MS;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try {
        chrome.downloads.onCreated.removeListener(onCreated);
      } catch {}
      try {
        chrome.downloads.onChanged.removeListener(onChanged);
      } catch {}
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onAbort = () => fail(new Error('Download wait cancelled'));
    const matches = (item: chrome.downloads.DownloadItem) => {
      if (!filenameContains) return true;
      const name = (item.filename || '').split(/[/\\]/).pop() || '';
      return name.includes(filenameContains) || (item.url || '').includes(filenameContains);
    };
    const isFinished = (item: chrome.downloads.DownloadItem) =>
      item.state === 'complete' || item.state === 'interrupted';
    const fulfill = async (item: chrome.downloads.DownloadItem) => {
      if (settled) return;
      settled = true;
      cleanup();
      rememberReported(item.id);
      try {
        const [found] = await chrome.downloads.search({ id: item.id });
        const out = found || item;
        resolve({
          id: out.id,
          filename: toDownloadDisplayName(out.filename),
          mime: (out as any).mime || undefined,
          fileSize: out.fileSize ?? out.totalBytes ?? undefined,
          state: out.state,
          danger: out.danger,
          startTime: out.startTime,
          endTime: (out as any).endTime || undefined,
          exists: (out as any).exists,
          pathRedacted: true,
          ...toPublicDownloadUrl(out.url),
        });
      } catch {
        resolve({
          id: item.id,
          filename: toDownloadDisplayName(item.filename),
          state: item.state,
          pathRedacted: true,
          ...toPublicDownloadUrl(item.url),
        });
      }
    };
    const isEligible = (item: chrome.downloads.DownloadItem) => {
      if (createdSinceArming.has(item.id)) return true;
      if (onlyNew) return false;
      if (typeof awaitedId === 'number' && item.id === awaitedId) return true;
      return (parseDownloadTimestamp(item.startTime) ?? 0) >= lookbackStart;
    };
    const consider = (item: chrome.downloads.DownloadItem) => {
      if (settled || !isEligible(item) || !matches(item) || reportedDownloadIds.has(item.id)) return;
      if (typeof awaitedId === 'number' && item.id !== awaitedId) return;
      if (!waitForComplete || isFinished(item)) {
        void fulfill(item);
      } else {
        awaitedId = item.id;
      }
    };
    const onCreated = (item: chrome.downloads.DownloadItem) => {
      try {
        createdSinceArming.add(item.id);
        consider(item);
      } catch {}
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      try {
        if (!delta || typeof delta.id !== 'number') return;
        if (onlyNew && !createdSinceArming.has(delta.id)) return;
        chrome.downloads
          .search({ id: delta.id })
          .then((arr) => {
            const item = arr && arr[0];
            if (item) consider(item);
          })
          .catch(() => {});
      } catch {}
    };

    if (signal?.aborted) {
      fail(new Error('Download wait cancelled'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => fail(new Error('Download wait timed out')), timeoutMs);
    if (onlyNew) return;

    chrome.downloads
      .search({
        startedAfter: new Date(armedAt - RECENT_DOWNLOAD_LOOKBACK_MS).toISOString(),
      } as chrome.downloads.DownloadQuery)
      .then((items) => {
        const lookbackStart = armedAt - RECENT_DOWNLOAD_LOOKBACK_MS;
        const recent = (items || [])
          .filter(
            (item) =>
              matches(item) &&
              !reportedDownloadIds.has(item.id) &&
              (parseDownloadTimestamp(item.startTime) ?? 0) >= lookbackStart,
          )
          .sort(
            (left, right) =>
              (parseDownloadTimestamp(right.startTime) ?? 0) -
              (parseDownloadTimestamp(left.startTime) ?? 0),
          );
        if (recent.length > 0 && typeof awaitedId !== 'number') consider(recent[0]);
      })
      .catch(() => {});
  });
}

export const handleDownloadTool = new HandleDownloadTool();
