interface FrameLookup {
  lookupId?: unknown;
  href?: unknown;
}

type ListFrames = (tabId: number) => Promise<ReadonlyArray<{ frameId: number; url: string }> | null>;

/** A ref is local to the isolated document that produced it. Chrome supplies its frameId. */
export async function resolveLookupFrame(
  tabId: number,
  lookup: FrameLookup,
  listFrames: ListFrames = (id) => chrome.webNavigation.getAllFrames({ tabId: id }),
): Promise<number | undefined> {
  if (typeof lookup.lookupId === 'string' && lookup.lookupId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      injectImmediately: true,
      func: (id: string) =>
        (window as Window & { __webpageFrameLookup?: string }).__webpageFrameLookup === id,
      args: [lookup.lookupId],
    });
    const owners = results.filter((frame) => frame.result && frame.frameId > 0);
    if (owners.length === 1) return owners[0].frameId;
    throw new Error('The iframe that resolved the selector could not be identified');
  }
  // Helpers already installed before an extension update may only provide the URL.
  if (typeof lookup.href !== 'string' || !lookup.href) return undefined;
  const frames = await listFrames(tabId);
  const matches = frames?.filter((frame) => frame.url === lookup.href);
  if (matches?.length === 1) return matches[0].frameId;
  throw new Error('The selector did not identify a unique iframe');
}
