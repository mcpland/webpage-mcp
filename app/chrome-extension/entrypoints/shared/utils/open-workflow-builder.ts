import { getActiveCurrentWindowTab } from "./active-tab";

export interface OpenWorkflowBuilderOptions {
  flowId?: string;
  createNew?: boolean;
  focusNodeId?: string;
  sourceTabId?: number;
  preserveActiveTabContext?: boolean;
}

function normalizeTabId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

export function isWorkflowRunTargetTabUrl(
  url: string | null | undefined,
): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

function getTabNavigationUrl(
  tab: chrome.tabs.Tab | undefined,
): string | undefined {
  const candidate = tab as
    | (chrome.tabs.Tab & { pendingUrl?: string })
    | undefined;
  return candidate?.pendingUrl || tab?.url || undefined;
}

export async function openWorkflowBuilder(
  options: OpenWorkflowBuilderOptions = {},
): Promise<chrome.tabs.Tab> {
  const params = new URLSearchParams();
  let sourceTabId = normalizeTabId(options.sourceTabId);

  if (sourceTabId === undefined && options.preserveActiveTabContext === true) {
    const sourceTab = await getActiveCurrentWindowTab();
    if (isWorkflowRunTargetTabUrl(getTabNavigationUrl(sourceTab))) {
      sourceTabId = normalizeTabId(sourceTab?.id);
    }
  }

  if (options.flowId) {
    params.set("flowId", options.flowId);
  } else if (options.createNew) {
    params.set("new", "1");
  }

  if (options.focusNodeId) {
    params.set("focus", options.focusNodeId);
  }

  if (sourceTabId !== undefined) {
    params.set("sourceTabId", String(sourceTabId));
  }

  const query = params.toString();
  return chrome.tabs.create({
    url: chrome.runtime.getURL(
      query ? `builder.html?${query}` : "builder.html",
    ),
    active: true,
  });
}
