/** Chrome exposes canonical URLs. A provisional navigation can already be replacing the document. */
export async function findTabsByExactUrl(url: URL): Promise<chrome.tabs.Tab[]> {
  return (await chrome.tabs.query({})).filter(
    (tab) => tab.url === url.href && (!tab.pendingUrl || tab.pendingUrl === url.href),
  );
}

export async function findTabsByUrlPattern(pattern: unknown): Promise<chrome.tabs.Tab[]> {
  if (typeof pattern !== 'string' || !/^(?:https?|\*):\/\//i.test(pattern)) {
    throw new Error('urlPattern must be an HTTP(S) Chrome match pattern');
  }
  const tabs = await chrome.tabs.query({ url: pattern });
  return tabs.filter(
    (tab) => /^https?:\/\//i.test(tab.url || '') && (!tab.pendingUrl || tab.pendingUrl === tab.url),
  );
}
