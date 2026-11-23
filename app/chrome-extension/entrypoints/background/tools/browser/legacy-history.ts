type Frame = chrome.webNavigation.GetAllFrameResultDetails;
type Update = chrome.webNavigation.WebNavigationTransitionCallbackDetails;

// Old opaque documents can consume popstate before every extension listener.
// Corroborate Chrome's frame event with its tab load cycle and local history visit.
export function watchLegacyFrameVisits(tabId: number, frames: Frame[], legacy: Map<string, boolean>, signal: AbortSignal) {
  const originals = new Map(frames.filter(frame => frame.frameId && /^https?:/.test(frame.url))
    .map(frame => [frame.documentId, frame]));
  if (!originals.size || !chrome.history?.onVisited || !chrome.tabs.onUpdated ||
      !chrome.webNavigation.onHistoryStateUpdated) return;

  const urls = new Set([...originals.values()].map(frame => frame.url));
  const events = new Map<string, number>();
  const visits = new Map<string, number | undefined>();
  const completed = new Map<string, string>();
  const checked = new Set<string>();
  const confirmed = new Set<string>();
  let cycle: { changes: number; candidate?: Update } | undefined;
  const onVisit = (item: chrome.history.HistoryItem) => {
    if (item.url && urls.has(item.url)) {
      visits.set(item.url, visits.has(item.url) ? undefined : item.lastVisitTime);
    }
  };
  const onEvent = (event: { tabId: number; url: string }) => {
    // Visits have no tab ID. A second navigation to the URL makes attribution ambiguous.
    if (urls.has(event.url)) events.set(event.url, (events.get(event.url) ?? 0) + 1);
    if (cycle && event.tabId === tabId) cycle.changes++;
  };
  const onHistory = (event: Update) => {
    onEvent(event);
    if (!event.documentId || event.tabId !== tabId || !cycle || event.transitionType !== 'auto_subframe') return;
    const frame = originals.get(event.documentId);
    if (frame?.frameId === event.frameId && frame.url === event.url) {
      cycle.candidate = event;
    }
  };
  const onTab = (id: number, change: chrome.tabs.TabChangeInfo) => {
    if (id !== tabId) return;
    if (change.status === 'loading') cycle = { changes: 0 };
    if (change.status !== 'complete') return;
    const event = cycle?.changes === 1 && cycle.candidate;
    cycle = undefined;
    if (event && event.documentId) completed.set(event.documentId, event.url);
  };
  const navigation = chrome.webNavigation;
  const others = [navigation.onBeforeNavigate, navigation.onCommitted, navigation.onReferenceFragmentUpdated, navigation.onErrorOccurred];
  chrome.history.onVisited.addListener(onVisit);
  chrome.tabs.onUpdated.addListener(onTab);
  navigation.onHistoryStateUpdated.addListener(onHistory);
  for (const event of others) event?.addListener(onEvent);
  signal.addEventListener('abort', () => {
    chrome.history.onVisited.removeListener(onVisit);
    chrome.tabs.onUpdated.removeListener(onTab);
    navigation.onHistoryStateUpdated.removeListener(onHistory);
    for (const event of others) event?.removeListener(onEvent);
  }, { once: true });
  return (documentId: string) => {
    const url = completed.get(documentId);
    if (!legacy.has(documentId) || !url || events.get(url) !== 1) return false;
    const time = visits.get(url);
    if (time === undefined) return false;
    if (!checked.has(url)) {
      checked.add(url);
      // A replaceState can report auto_subframe but does not create a local visit.
      // Both timestamps below identify the very same Chrome history record.
      void chrome.history.getVisits({ url }).then(items => {
        if (!signal.aborted && items.some(item => 'isLocal' in item && item.isLocal === true &&
            item.visitTime === time && item.transition === 'auto_subframe')) confirmed.add(url);
      }).catch(() => {});
    }
    return confirmed.has(url);
  };
}
