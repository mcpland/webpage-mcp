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

const RECENT_DOWNLOAD_GRACE_MS = 5000;

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

  async execute(args: HandleDownloadParams): Promise<ToolResult> {
    const filenameContains = String(args?.filenameContains || '').trim();
    const waitForComplete = args?.waitForComplete !== false;
    const timeoutMs = Math.max(1000, Math.min(Number(args?.timeoutMs ?? 60000), 300000));

    try {
      const result = await waitForDownload({ filenameContains, waitForComplete, timeoutMs });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, download: result }) }],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Handle download failed: ${e?.message || String(e)}`);
    }
  }
}

async function waitForDownload(opts: {
  filenameContains?: string;
  waitForComplete: boolean;
  timeoutMs: number;
}) {
  const { filenameContains, waitForComplete, timeoutMs } = opts;
  const observationStartedAt = Date.now();
  return new Promise<any>((resolve, reject) => {
    let timer: any = null;
    const onError = (err: any) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const cleanup = () => {
      try {
        if (timer) clearTimeout(timer);
      } catch {}
      try {
        chrome.downloads.onCreated.removeListener(onCreated);
      } catch {}
      try {
        chrome.downloads.onChanged.removeListener(onChanged);
      } catch {}
    };
    const matches = (item: chrome.downloads.DownloadItem) => {
      if (!filenameContains) return true;
      const name = (item.filename || '').split(/[/\\]/).pop() || '';
      return name.includes(filenameContains) || (item.url || '').includes(filenameContains);
    };
    const parseDownloadTimestamp = (value?: string | null): number | null => {
      if (typeof value !== 'string' || !value.trim()) {
        return null;
      }

      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const getDownloadActivityTimestamp = (item: chrome.downloads.DownloadItem): number => {
      const endTime = parseDownloadTimestamp((item as any).endTime);
      const startTime = parseDownloadTimestamp(item.startTime);
      return Math.max(endTime ?? -1, startTime ?? -1);
    };
    const isRecentDownload = (item: chrome.downloads.DownloadItem): boolean => {
      const activityAt = getDownloadActivityTimestamp(item);
      return activityAt >= observationStartedAt - RECENT_DOWNLOAD_GRACE_MS;
    };
    const selectInitialMatch = (
      items: chrome.downloads.DownloadItem[],
    ): chrome.downloads.DownloadItem | null => {
      const matchingItems = items.filter((item) => matches(item));
      if (!matchingItems.length) {
        return null;
      }

      const freshItems = matchingItems.filter(
        (item) => item.state === 'in_progress' || isRecentDownload(item),
      );
      const candidates = freshItems.length > 0 ? freshItems : [];

      if (!candidates.length) {
        return null;
      }

      if (waitForComplete) {
        const completed = candidates.filter((item) => item.state === 'complete');
        if (!completed.length) {
          return null;
        }

        return completed.sort(
          (left, right) => getDownloadActivityTimestamp(right) - getDownloadActivityTimestamp(left),
        )[0];
      }

      return candidates.sort(
        (left, right) => getDownloadActivityTimestamp(right) - getDownloadActivityTimestamp(left),
      )[0];
    };
    const fulfill = async (item: chrome.downloads.DownloadItem) => {
      // try to fill more details via downloads.search
      try {
        const [found] = await chrome.downloads.search({ id: item.id });
        const out = found || item;
        cleanup();
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
        return;
      } catch {
        cleanup();
        resolve({
          id: item.id,
          filename: toDownloadDisplayName(item.filename),
          state: item.state,
          pathRedacted: true,
          ...toPublicDownloadUrl(item.url),
        });
      }
    };
    const onCreated = (item: chrome.downloads.DownloadItem) => {
      try {
        if (!matches(item)) return;
        if (!waitForComplete) {
          fulfill(item);
        }
      } catch {}
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      try {
        if (!delta || typeof delta.id !== 'number') return;
        // pull item and check
        chrome.downloads
          .search({ id: delta.id })
          .then((arr) => {
            const item = arr && arr[0];
            if (!item) return;
            if (!matches(item)) return;
            if (waitForComplete && item.state === 'complete') fulfill(item);
          })
          .catch(() => {});
      } catch {}
    };
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => onError(new Error('Download wait timed out')), timeoutMs);
    // Try to find a matching download that started or completed around this invocation.
    chrome.downloads
      .search({})
      .then((arr) => {
        const hit = selectInitialMatch(arr || []);
        if (hit) fulfill(hit);
      })
      .catch(() => {});
  });
}

export const handleDownloadTool = new HandleDownloadTool();
