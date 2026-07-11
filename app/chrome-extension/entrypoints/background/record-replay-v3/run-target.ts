import {
  enforcesPublicPageRestrictions,
  isAllowedPublicFlowTabUrl,
  isHttpUrl,
  PUBLIC_FLOW_RUN_TARGET_ERROR,
} from "@/entrypoints/background/record-replay/public-pages";
import type { ExecutionFlags } from "@/entrypoints/background/replay-actions";

const RUN_POLL_INTERVAL_MS = 150;
const TAB_RESOLUTION_WAIT_TIMEOUT_MS = 3_000;

export type RunTargetPreference = "current" | "new";

export interface RunTargetOptions {
  tabId?: number;
  tabTarget?: RunTargetPreference;
  startUrl?: string;
  refresh?: boolean;
  execution?: ExecutionFlags;
  signal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTargetAbortError(): Error {
  const error = new Error("Workflow target resolution cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfTargetAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createTargetAbortError();
}

function waitForTargetPoll(signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(RUN_POLL_INTERVAL_MS);
  throwIfTargetAborted(signal);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", handleAbort);
      if (error) reject(error);
      else resolve();
    };
    const handleAbort = (): void => finish(createTargetAbortError());
    const timer = setTimeout(() => finish(), RUN_POLL_INTERVAL_MS);
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) handleAbort();
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isWebUrl(url?: string | null, execution?: ExecutionFlags): boolean {
  return enforcesPublicPageRestrictions(execution)
    ? isAllowedPublicFlowTabUrl(url)
    : isHttpUrl(url) || (typeof url === "string" && /^file:/i.test(url));
}

function normalizeRunTarget(target: unknown): RunTargetPreference {
  return target === "new" ? "new" : "current";
}

function normalizeStartUrl(url: unknown): string | undefined {
  return typeof url === "string" && url.trim() ? url.trim() : undefined;
}

function prefersBackgroundTabs(execution?: ExecutionFlags): boolean {
  return execution?.backgroundTabs === true;
}

async function waitForTabReady(
  tabId: number,
  options: {
    previousUrl?: string;
    targetUrl?: string;
    signal?: AbortSignal;
  } = {},
): Promise<chrome.tabs.Tab> {
  throwIfTargetAborted(options.signal);
  const deadline = Date.now() + TAB_RESOLUTION_WAIT_TIMEOUT_MS;
  let lastSeen = await chrome.tabs.get(tabId);
  throwIfTargetAborted(options.signal);
  let sawNavigationSignal = false;

  while (Date.now() < deadline) {
    throwIfTargetAborted(options.signal);
    const current = await chrome.tabs.get(tabId);
    throwIfTargetAborted(options.signal);
    lastSeen = current;
    const pendingUrl =
      (current as chrome.tabs.Tab & { pendingUrl?: string }).pendingUrl || "";
    const currentUrl = current.url || "";
    const observedUrl = pendingUrl || currentUrl;

    if (options.targetUrl && observedUrl === options.targetUrl) {
      sawNavigationSignal = true;
      if (current.status === "complete") {
        return current;
      }
    }

    if (
      options.previousUrl &&
      observedUrl &&
      observedUrl !== options.previousUrl
    ) {
      sawNavigationSignal = true;
      if (current.status === "complete") {
        return current;
      }
    }

    if (current.status !== "complete") {
      sawNavigationSignal = true;
    }

    if (current.status === "complete") {
      if (!options.targetUrl && !options.previousUrl) {
        return current;
      }
      if (sawNavigationSignal) {
        return current;
      }
    }

    await waitForTargetPoll(options.signal);
  }

  return lastSeen;
}

async function createFallbackRunTab(
  background: boolean,
  signal?: AbortSignal,
): Promise<number> {
  throwIfTargetAborted(signal);
  const created = await chrome.tabs.create({
    url: "about:blank",
    active: !background,
  });
  if (created.id === undefined) {
    throw new Error("chrome.tabs.create returned a tab without id");
  }
  try {
    await waitForTabReady(created.id, {
      targetUrl: "about:blank",
      signal,
    });
    return created.id;
  } catch (error) {
    if (signal?.aborted) {
      await chrome.tabs.remove(created.id).catch(() => {});
    }
    throw error;
  }
}

export async function resolveRunTargetTab(
  input: RunTargetOptions,
): Promise<number | undefined> {
  throwIfTargetAborted(input.signal);
  const explicitTabId = isFiniteNumber(input.tabId)
    ? Math.floor(input.tabId)
    : undefined;
  const tabTarget = normalizeRunTarget(input.tabTarget);
  const startUrl = normalizeStartUrl(input.startUrl);
  const shouldRefresh = input.refresh === true;
  const background = prefersBackgroundTabs(input.execution);
  if (
    startUrl &&
    enforcesPublicPageRestrictions(input.execution) &&
    !isAllowedPublicFlowTabUrl(startUrl)
  ) {
    throw new Error(PUBLIC_FLOW_RUN_TARGET_ERROR);
  }

  const explicitTab =
    explicitTabId !== undefined
      ? await chrome.tabs.get(explicitTabId).catch(() => null)
      : null;
  throwIfTargetAborted(input.signal);

  if (explicitTab?.id !== undefined) {
    if (startUrl) {
      throwIfTargetAborted(input.signal);
      await chrome.tabs.update(explicitTab.id, { url: startUrl });
      await waitForTabReady(explicitTab.id, {
        previousUrl: explicitTab.url || undefined,
        targetUrl: startUrl,
        signal: input.signal,
      });
    } else if (!isWebUrl(explicitTab.url, input.execution)) {
      if (enforcesPublicPageRestrictions(input.execution)) {
        throw new Error(PUBLIC_FLOW_RUN_TARGET_ERROR);
      }
      return createFallbackRunTab(background, input.signal);
    } else if (shouldRefresh && isWebUrl(explicitTab.url, input.execution)) {
      throwIfTargetAborted(input.signal);
      await chrome.tabs.reload(explicitTab.id);
      await waitForTabReady(explicitTab.id, {
        previousUrl: explicitTab.url || undefined,
        signal: input.signal,
      });
    }
    return explicitTab.id;
  }

  const currentWindowTabsRaw = await chrome.tabs.query({ currentWindow: true });
  throwIfTargetAborted(input.signal);
  const currentWindowTabs = Array.isArray(currentWindowTabsRaw)
    ? currentWindowTabsRaw
    : [];
  const activeTabsRaw = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  throwIfTargetAborted(input.signal);
  const activeTabs = Array.isArray(activeTabsRaw) ? activeTabsRaw : [];
  const activeTab =
    currentWindowTabs.find((tab) => tab.active) ??
    activeTabs.at(0);

  if (tabTarget === "new") {
    const activeTabUrl = activeTab?.url;
    const urlToOpen =
      startUrl ??
      (isWebUrl(activeTabUrl, input.execution) ? activeTabUrl : "about:blank");
    throwIfTargetAborted(input.signal);
    const created = await chrome.tabs.create({
      active: !background,
      url: urlToOpen,
    });
    if (created.id === undefined) {
      throw new Error("chrome.tabs.create returned a tab without id");
    }
    try {
      await waitForTabReady(created.id, {
        previousUrl: activeTab?.url || undefined,
        targetUrl: urlToOpen,
        signal: input.signal,
      });
      return created.id;
    } catch (error) {
      if (input.signal?.aborted) {
        await chrome.tabs.remove(created.id).catch(() => {});
      }
      throw error;
    }
  }

  let targetTab: chrome.tabs.Tab | null =
    activeTab && activeTab.id !== undefined
      ? activeTab
      : (currentWindowTabs.find((tab) => tab.id !== undefined) ?? null);

  if (!startUrl && !isWebUrl(targetTab?.url, input.execution)) {
    const webCandidate = currentWindowTabs.find(
      (tab) => tab.id !== undefined && isWebUrl(tab.url, input.execution),
    );
    if (webCandidate?.id !== undefined) {
      if (background) {
        targetTab = webCandidate;
      } else {
        throwIfTargetAborted(input.signal);
        const activatedTab = await chrome.tabs
          .update(webCandidate.id, { active: true })
          .catch(() => null);
        targetTab = activatedTab ?? webCandidate;
      }
    }
  }

  if (startUrl) {
    if (targetTab?.id !== undefined) {
      throwIfTargetAborted(input.signal);
      await chrome.tabs.update(
        targetTab.id,
        background ? { url: startUrl } : { url: startUrl, active: true },
      );
      await waitForTabReady(targetTab.id, {
        previousUrl: targetTab.url || undefined,
        targetUrl: startUrl,
        signal: input.signal,
      });
      return targetTab.id;
    }

    throwIfTargetAborted(input.signal);
    const created = await chrome.tabs.create({ url: startUrl, active: !background });
    if (created.id === undefined) {
      throw new Error("chrome.tabs.create returned a tab without id");
    }
    try {
      await waitForTabReady(created.id, {
        targetUrl: startUrl,
        signal: input.signal,
      });
      return created.id;
    } catch (error) {
      if (input.signal?.aborted) {
        await chrome.tabs.remove(created.id).catch(() => {});
      }
      throw error;
    }
  }

  if (targetTab?.id !== undefined) {
    if (!isWebUrl(targetTab.url, input.execution)) {
      if (enforcesPublicPageRestrictions(input.execution)) {
        throw new Error(PUBLIC_FLOW_RUN_TARGET_ERROR);
      }
      return createFallbackRunTab(background, input.signal);
    }
    if (shouldRefresh && isWebUrl(targetTab.url, input.execution)) {
      throwIfTargetAborted(input.signal);
      await chrome.tabs.reload(targetTab.id);
      await waitForTabReady(targetTab.id, {
        previousUrl: targetTab.url || undefined,
        signal: input.signal,
      });
    }
    return targetTab.id;
  }

  return createFallbackRunTab(background, input.signal);
}
