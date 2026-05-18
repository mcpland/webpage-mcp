// rr-utils.ts — shared helpers for record-replay runner
// Note: comments in English

import {
  TOOL_NAMES,
  topoOrder as sharedTopoOrder,
  mapNodeToStep as sharedMapNodeToStep,
} from 'webpage-mcp-shared';
import type { Edge as DagEdge, NodeBase as DagNode, Step } from './types';
import { handleCallTool } from '../tools';
import { EDGE_LABELS } from 'webpage-mcp-shared';

export function applyAssign(
  target: Record<string, any>,
  source: any,
  assign: Record<string, string>,
) {
  const getByPath = (obj: any, path: string) => {
    try {
      const parts = path
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .filter(Boolean);
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return undefined;
        cur = (cur as any)[p as any];
      }
      return cur;
    } catch {
      return undefined;
    }
  };
  for (const [k, v] of Object.entries(assign || {})) {
    target[k] = getByPath(source, String(v));
  }
}

export function expandTemplatesDeep<T = any>(value: T, scope: Record<string, any>): T {
  const replaceOne = (s: string) =>
    s.replace(/\{([^}]+)\}/g, (_m, k) => (scope[k] ?? '').toString());
  const walk = (v: any): any => {
    if (v == null) return v;
    if (typeof v === 'string') return replaceOne(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (typeof v === 'object') {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

export async function ensureTab(options: {
  tabTarget?: 'current' | 'new';
  tabId?: number;
  startUrl?: string;
  refresh?: boolean;
  background?: boolean;
}): Promise<{ tabId: number; url?: string }> {
  const target = options.tabTarget || 'current';
  const explicitTabId = options.tabId;
  const startUrl = options.startUrl;
  const background = options.background === true;
  const isWebUrl = (u?: string | null) => !!u && /^(https?:|file:)/i.test(u);

  const explicitTab =
    typeof explicitTabId === 'number' ? await chrome.tabs.get(explicitTabId).catch(() => null) : null;
  if (explicitTab?.id) {
    if (startUrl) {
      await handleCallTool({
        name: TOOL_NAMES.BROWSER.NAVIGATE,
        // Replay startup navigates the explicit tab in place; default flipped
        // to new_tab so the in-place intent must be declared.
        args: {
          url: startUrl,
          tabId: explicitTab.id,
          background: true,
          openMode: 'current_tab',
        },
      });
    } else if (options.refresh) {
      await handleCallTool({
        name: TOOL_NAMES.BROWSER.NAVIGATE,
        args: { refresh: true, tabId: explicitTab.id, background: true },
      });
    }
    const updated = await chrome.tabs.get(explicitTab.id);
    return { tabId: updated.id!, url: updated.url };
  }

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const [active] = tabs.filter((t) => t.active);

  if (target === 'new') {
    let urlToOpen = startUrl;
    if (!urlToOpen) urlToOpen = isWebUrl(active?.url) ? active!.url! : 'about:blank';
    const created = await chrome.tabs.create({ url: urlToOpen, active: !background });
    await new Promise((r) => setTimeout(r, 300));
    return { tabId: created.id!, url: created.url };
  }

  // current tab target
  if (startUrl) {
    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      // Workflow startup with tabTarget='current' wants to reuse the active
      // tab; declare in-place explicitly now that new_tab is the default.
      args: {
        url: startUrl,
        ...(typeof active?.id === 'number' ? { tabId: active.id } : {}),
        background: true,
        openMode: 'current_tab',
      },
    });
  } else if (options.refresh) {
    // only refresh if current tab is a web page
    if (isWebUrl(active?.url))
      await handleCallTool({
        name: TOOL_NAMES.BROWSER.NAVIGATE,
        args: {
          refresh: true,
          ...(typeof active?.id === 'number' ? { tabId: active.id } : {}),
          background: true,
        },
      });
  }

  // Re-evaluate active after potential navigation
  const cur = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  let tabId = cur?.id;
  let url = cur?.url;

  // If still on extension/internal page and no startUrl, try switch to an existing web tab
  if (!isWebUrl(url) && !startUrl) {
    const candidate = tabs.find((t) => isWebUrl(t.url));
    if (candidate?.id) {
      if (!background) {
        await chrome.tabs.update(candidate.id, { active: true });
      }
      tabId = candidate.id;
      url = candidate.url;
    }
  }
  return { tabId: tabId!, url };
}

export async function waitForNetworkIdle(
  totalTimeoutMs: number,
  idleThresholdMs: number,
  tabId?: number,
) {
  const deadline = Date.now() + Math.max(500, totalTimeoutMs);
  const threshold = Math.max(200, idleThresholdMs);
  while (Date.now() < deadline) {
    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_START,
      args: {
        ...(typeof tabId === 'number' ? { tabId } : {}),
        includeStatic: false,
        // Ensure capture remains active until we explicitly stop it
        maxCaptureTime: Math.min(60_000, Math.max(threshold + 500, 2_000)),
        inactivityTimeout: 0,
      },
    });
    await new Promise((r) => setTimeout(r, threshold + 200));
    const stopRes = await handleCallTool({
      name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_STOP,
      args: {
        ...(typeof tabId === 'number' ? { tabId } : {}),
      },
    });
    const text = (stopRes as any)?.content?.find((c: any) => c.type === 'text')?.text;
    try {
      const json = text ? JSON.parse(text) : null;
      const captureEnd = Number(json?.captureEndTime) || Date.now();
      const reqs: any[] = Array.isArray(json?.requests) ? json.requests : [];
      const lastActivity = reqs.reduce(
        (acc, r) => {
          const t = Number(r.responseTime || r.requestTime || 0);
          return t > acc ? t : acc;
        },
        Number(json?.captureStartTime || 0),
      );
      if (captureEnd - lastActivity >= threshold) return; // idle reached
    } catch {
      // ignore parse errors
    }
    await new Promise((r) => setTimeout(r, Math.min(500, threshold)));
  }
  throw new Error('wait for network idle timed out');
}

// Event-driven navigation wait helper
// Waits for top-frame navigation completion or SPA history updates on a target tab.
// Falls back to short network idle on timeout.
export async function waitForNavigation(
  timeoutMs?: number,
  prevUrl?: string,
  preferredTabId?: number,
): Promise<void> {
  let tabId = preferredTabId;
  if (typeof tabId === 'number') {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id) {
      throw new Error(`Workflow tab ${tabId} not found`);
    }
  }
  if (typeof tabId !== 'number') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs?.[0]?.id;
  }
  if (typeof tabId !== 'number') throw new Error('Active tab not found');
  const timeout = Math.max(1000, Math.min(timeoutMs || 15000, 30000));
  const startedAt = Date.now();

  await new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: any = null;
    const cleanup = () => {
      try {
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
      } catch {}
      try {
        chrome.webNavigation.onCompleted.removeListener(onCompleted);
      } catch {}
      try {
        (chrome.webNavigation as any).onHistoryStateUpdated?.removeListener?.(
          onHistoryStateUpdated,
        );
      } catch {}
      try {
        chrome.tabs.onUpdated.removeListener(onTabUpdated);
      } catch {}
      if (timer) {
        try {
          clearTimeout(timer);
        } catch {}
      }
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const onCommitted = (details: any) => {
      if (
        details &&
        details.tabId === tabId &&
        details.frameId === 0 &&
        details.timeStamp >= startedAt
      ) {
        // committed observed; we'll wait for completion or SPA fallback
      }
    };
    const onCompleted = (details: any) => {
      if (
        details &&
        details.tabId === tabId &&
        details.frameId === 0 &&
        details.timeStamp >= startedAt
      )
        finish();
    };
    const onHistoryStateUpdated = (details: any) => {
      if (
        details &&
        details.tabId === tabId &&
        details.frameId === 0 &&
        details.timeStamp >= startedAt
      )
        finish();
    };
    const onTabUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') finish();
      if (typeof changeInfo.url === 'string' && (!prevUrl || changeInfo.url !== prevUrl)) finish();
    };
    const onTimeout = async () => {
      cleanup();
      try {
        await waitForNetworkIdle(2000, 800, tabId);
        resolve();
      } catch {
        reject(new Error('navigation timeout'));
      }
    };

    chrome.webNavigation.onCommitted.addListener(onCommitted);
    chrome.webNavigation.onCompleted.addListener(onCompleted);
    try {
      (chrome.webNavigation as any).onHistoryStateUpdated?.addListener?.(onHistoryStateUpdated);
    } catch {}
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    timer = setTimeout(onTimeout, timeout);
  });
}

export function topoOrder(nodes: DagNode[], edges: DagEdge[]): DagNode[] {
  return sharedTopoOrder(nodes, edges as any);
}

// Helper: filter only default edges (no label or label === 'default')
export function defaultEdgesOnly(edges: DagEdge[] = []): DagEdge[] {
  return (edges || []).filter((e) => !e.label || e.label === EDGE_LABELS.DEFAULT);
}

export function mapDagNodeToStep(n: DagNode): Step {
  const s: any = sharedMapNodeToStep(n as any);
  if ((n as any)?.type === 'if') {
    // forward extended conditional config for DAG mode
    const cfg: any = (n as any).config || {};
    if (Array.isArray(cfg.branches)) s.branches = cfg.branches;
    if ('else' in cfg) s.else = cfg.else;
    if (cfg.condition && !s.condition) s.condition = cfg.condition; // backward-compat
  }
  return s as Step;
}
