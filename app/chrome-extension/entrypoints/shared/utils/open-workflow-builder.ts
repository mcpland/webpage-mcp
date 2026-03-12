export interface OpenWorkflowBuilderOptions {
  flowId?: string;
  createNew?: boolean;
  focusNodeId?: string;
}

export async function openWorkflowBuilder(
  options: OpenWorkflowBuilderOptions = {},
): Promise<chrome.tabs.Tab> {
  const params = new URLSearchParams();

  if (options.flowId) {
    params.set("flowId", options.flowId);
  } else if (options.createNew) {
    params.set("new", "1");
  }

  if (options.focusNodeId) {
    params.set("focus", options.focusNodeId);
  }

  const query = params.toString();
  return chrome.tabs.create({
    url: chrome.runtime.getURL(
      query ? `builder.html?${query}` : "builder.html",
    ),
    active: true,
  });
}
