export async function getActiveCurrentWindowTabId(): Promise<number | undefined> {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return typeof activeTab?.id === "number" && Number.isFinite(activeTab.id)
      ? Math.floor(activeTab.id)
      : undefined;
  } catch {
    return undefined;
  }
}
