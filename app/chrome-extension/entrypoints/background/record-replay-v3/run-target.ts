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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  options: { previousUrl?: string; targetUrl?: string } = {},
): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + TAB_RESOLUTION_WAIT_TIMEOUT_MS;
  let lastSeen = await chrome.tabs.get(tabId);
  let sawNavigationSignal = false;

  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tabId);
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

    await sleep(RUN_POLL_INTERVAL_MS);
  }

  return lastSeen;
}

async function createFallbackRunTab(background: boolean): Promise<number> {
  const created = await chrome.tabs.create({
    url: "about:blank",
    active: !background,
  });
  if (created.id === undefined) {
    throw new Error("chrome.tabs.create returned a tab without id");
  }
  await waitForTabReady(created.id, { targetUrl: "about:blank" });
  return created.id;
}

export async function resolveRunTargetTab(
  input: RunTargetOptions,
): Promise<number | undefined> {
  const explicitTabId = isFiniteNumber(input.tabId)
    ? Math.floor(input.tabId)
    : undefined;
  const tabTarget = normalizeRunTarget(input.tabTarget);
  const startUrl = normalizeStartUrl(input.startUrl);
  const shouldRefresh = input.refresh === true;
  const background = prefersBackgroundTabs(input.execution);

  const explicitTab =
    explicitTabId !== undefined
      ? await chrome.tabs.get(explicitTabId).catch(() => null)
      : null;

  if (explicitTab?.id !== undefined) {
    if (startUrl) {
      await chrome.tabs.update(explicitTab.id, { url: startUrl });
      await waitForTabReady(explicitTab.id, {
        previousUrl: explicitTab.url || undefined,
        targetUrl: startUrl,
      });
    } else if (!isWebUrl(explicitTab.url, input.execution)) {
      if (enforcesPublicPageRestrictions(input.execution)) {
        throw new Error(PUBLIC_FLOW_RUN_TARGET_ERROR);
      }
      return createFallbackRunTab(background);
    } else if (shouldRefresh && isWebUrl(explicitTab.url, input.execution)) {
      await chrome.tabs.reload(explicitTab.id);
      await waitForTabReady(explicitTab.id, {
        previousUrl: explicitTab.url || undefined,
      });
    }
    return explicitTab.id;
  }

  const currentWindowTabsRaw = await chrome.tabs.query({ currentWindow: true });
  const currentWindowTabs = Array.isArray(currentWindowTabsRaw)
    ? currentWindowTabsRaw
    : [];
  const activeTabsRaw = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const activeTabs = Array.isArray(activeTabsRaw) ? activeTabsRaw : [];
  const activeTab =
    currentWindowTabs.find((tab) => tab.active) ??
    activeTabs.at(0);

  if (tabTarget === "new") {
    const activeTabUrl = activeTab?.url;
    const urlToOpen =
      startUrl ??
      (isWebUrl(activeTabUrl, input.execution) ? activeTabUrl : "about:blank");
    const created = await chrome.tabs.create({
      active: !background,
      url: urlToOpen,
    });
    if (created.id === undefined) {
      throw new Error("chrome.tabs.create returned a tab without id");
    }
    await waitForTabReady(created.id, {
      previousUrl: activeTab?.url || undefined,
      targetUrl: urlToOpen,
    });
    return created.id;
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
        const activatedTab = await chrome.tabs
          .update(webCandidate.id, { active: true })
          .catch(() => null);
        targetTab = activatedTab ?? webCandidate;
      }
    }
  }

  if (startUrl) {
    if (targetTab?.id !== undefined) {
      await chrome.tabs.update(
        targetTab.id,
        background ? { url: startUrl } : { url: startUrl, active: true },
      );
      await waitForTabReady(targetTab.id, {
        previousUrl: targetTab.url || undefined,
        targetUrl: startUrl,
      });
      return targetTab.id;
    }

    const created = await chrome.tabs.create({ url: startUrl, active: !background });
    if (created.id === undefined) {
      throw new Error("chrome.tabs.create returned a tab without id");
    }
    await waitForTabReady(created.id, { targetUrl: startUrl });
    return created.id;
  }

  if (targetTab?.id !== undefined) {
    if (!isWebUrl(targetTab.url, input.execution)) {
      if (enforcesPublicPageRestrictions(input.execution)) {
        throw new Error(PUBLIC_FLOW_RUN_TARGET_ERROR);
      }
      return createFallbackRunTab(background);
    }
    if (shouldRefresh && isWebUrl(targetTab.url, input.execution)) {
      await chrome.tabs.reload(targetTab.id);
      await waitForTabReady(targetTab.id, {
        previousUrl: targetTab.url || undefined,
      });
    }
    return targetTab.id;
  }

  return createFallbackRunTab(background);
}
