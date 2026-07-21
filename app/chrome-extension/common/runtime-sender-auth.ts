function extensionLocation(): { root: string; origin: string } | null {
  const root = chrome.runtime.getURL("");
  if (typeof root !== "string" || !root.startsWith("chrome-extension://"))
    return null;
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return { root: normalizedRoot, origin: normalizedRoot.slice(0, -1) };
}

function senderHasExtensionOrigin(
  sender: chrome.runtime.MessageSender,
): boolean {
  const expected = extensionLocation();
  if (!expected) return false;
  if (sender.origin !== undefined && sender.origin !== expected.origin)
    return false;
  if (sender.url !== undefined && !sender.url.startsWith(expected.root))
    return false;
  return sender.origin === expected.origin || typeof sender.url === "string";
}

/**
 * A document owned by this extension, whether hosted in a tab, popup, side
 * panel, or offscreen document. A tab is not a content-script discriminator:
 * extension pages opened with chrome.tabs.create() carry sender.tab too.
 */
export function isExtensionPageSender(
  sender: chrome.runtime.MessageSender | undefined,
): boolean {
  return Boolean(
    sender &&
    sender.id === chrome.runtime.id &&
    senderHasExtensionOrigin(sender),
  );
}

/** Same-extension runtime context, including a background service worker without a URL. */
export function isExtensionRuntimeSender(
  sender: chrome.runtime.MessageSender | undefined,
): boolean {
  if (!sender || sender.id !== chrome.runtime.id || sender.tab !== undefined)
    return false;
  if (sender.url === undefined && sender.origin === undefined) return true;
  return senderHasExtensionOrigin(sender);
}

/** The extension's background service worker, excluding every document context. */
export function isExtensionBackgroundSender(
  sender: chrome.runtime.MessageSender | undefined,
): boolean {
  return Boolean(
    sender &&
    sender.id === chrome.runtime.id &&
    sender.tab === undefined &&
    sender.url === undefined &&
    sender.origin === undefined &&
    sender.documentId === undefined &&
    sender.documentLifecycle === undefined,
  );
}

/** The one extension offscreen document used by the keepalive channel. */
export function isOffscreenDocumentSender(
  sender: chrome.runtime.MessageSender | undefined,
): boolean {
  if (
    !sender ||
    sender.tab !== undefined ||
    !isExtensionPageSender(sender) ||
    !sender.url
  ) {
    return false;
  }
  const actual = sender.url.split(/[?#]/, 1)[0];
  return actual === chrome.runtime.getURL("offscreen.html");
}
