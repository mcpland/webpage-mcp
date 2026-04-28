export async function getActiveCurrentWindowTab(): Promise<
  chrome.tabs.Tab | undefined
> {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return activeTab;
  } catch {
    return undefined;
  }
}

export async function getActiveCurrentWindowTabId(): Promise<
  number | undefined
> {
  const activeTab = await getActiveCurrentWindowTab();
  return typeof activeTab?.id === "number" && Number.isFinite(activeTab.id)
    ? Math.floor(activeTab.id)
    : undefined;
}
