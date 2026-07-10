import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type {
  UpsertMarkerRequest,
  ElementMarker,
  MarkerValidationRequest,
  MarkerValidationAction,
} from '@/common/element-marker-types';
import {
  deleteMarker,
  listAllMarkers,
  listMarkersForUrl,
  saveMarker,
  updateMarker,
} from './element-marker-storage';
import { computerTool } from '@/entrypoints/background/tools/browser/computer';
import { clickTool } from '@/entrypoints/background/tools/browser/interaction';
import { keyboardTool } from '@/entrypoints/background/tools/browser/keyboard';

const CONTEXT_MENU_ID = 'element_marker_mark';
const TOP_FRAME_ID = 0;

interface MarkerDocumentTarget {
  tabId: number;
  frameId: number;
  documentId: string;
}

interface MarkerSession extends MarkerDocumentTarget {
  sessionId: string;
}

// Marker validation can cause real browser input. Keep a fail-closed,
// document-scoped capability for the in-page overlay instead of trusting the
// tab that happens to be active when the message reaches the service worker.
const markerSessions = new Map<number, MarkerSession>();

function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.tab || sender.id !== chrome.runtime.id) return false;

  const extensionRoot = chrome.runtime.getURL('');
  const extensionOrigin = new URL(extensionRoot).origin;
  return sender.origin === extensionOrigin || sender.url?.startsWith(extensionRoot) === true;
}

async function getTopDocumentTarget(tabId: number): Promise<MarkerDocumentTarget> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const topFrame = frames?.find((frame) => frame.frameId === TOP_FRAME_ID);
  const documentId = topFrame?.documentId;

  if (!documentId) {
    throw new Error('marker target document is unavailable');
  }

  return { tabId, frameId: TOP_FRAME_ID, documentId };
}

async function assertTargetIsCurrent(target: MarkerDocumentTarget): Promise<void> {
  const current = await getTopDocumentTarget(target.tabId);
  if (current.frameId !== target.frameId || current.documentId !== target.documentId) {
    markerSessions.delete(target.tabId);
    throw new Error('marker target document changed; start the marker again');
  }
}

function isSenderBoundToSession(
  sender: chrome.runtime.MessageSender,
  session: MarkerSession,
  sessionId: unknown,
): boolean {
  return (
    sessionId === session.sessionId &&
    sender.tab?.id === session.tabId &&
    sender.frameId === session.frameId &&
    sender.documentId === session.documentId
  );
}

async function authorizeValidationTarget(
  request: MarkerValidationRequest,
  sender: chrome.runtime.MessageSender,
): Promise<MarkerDocumentTarget> {
  if (sender.tab) {
    return authorizeMarkerSessionSender(request.markerSessionId, sender);
  }

  if (!isExtensionPageSender(sender) || typeof request.tabId !== 'number') {
    throw new Error('marker validation requires an explicit target tab');
  }

  return getTopDocumentTarget(request.tabId);
}

async function authorizeMarkerSessionSender(
  sessionId: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<MarkerSession> {
  const tabId = sender.tab?.id;
  const session = typeof tabId === 'number' ? markerSessions.get(tabId) : undefined;
  if (!session || !isSenderBoundToSession(sender, session, sessionId)) {
    throw new Error('marker session does not match the sender document');
  }
  await assertTargetIsCurrent(session);
  return session;
}

function assertExtensionPageMarkerAccess(sender: chrome.runtime.MessageSender): void {
  if (!isExtensionPageSender(sender)) {
    throw new Error('marker management requires an extension page');
  }
}

function normalizeDocumentUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

async function authorizeMarkerSave(
  request: { markerSessionId?: unknown },
  marker: UpsertMarkerRequest,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  if (isExtensionPageSender(sender)) return;

  await authorizeMarkerSessionSender(request.markerSessionId, sender);
  const markerUrl = normalizeDocumentUrl(marker?.url);
  const senderUrl = normalizeDocumentUrl(sender.url);
  if (!markerUrl || markerUrl !== senderUrl) {
    throw new Error('marker URL does not match the sender document');
  }
}

/**
 * Extract error message from MCP tool result
 */
function extractToolError(result: any): string | undefined {
  if (!result) return undefined;

  // Check for error in result content array
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.text) {
        try {
          const parsed = JSON.parse(item.text);
          if (parsed?.error) return parsed.error;
          if (parsed?.message) return parsed.message;
        } catch {
          // Not JSON, use as-is
          return item.text;
        }
      }
    }
  }

  // Fallback to direct error field
  return result.error || (result.isError ? 'unknown tool error' : undefined);
}

async function ensureContextMenu() {
  try {
    // Guard: contextMenus permission may be missing
    if (!(chrome as any).contextMenus?.create) return;
    // Remove and re-create our single menu to avoid duplication
    try {
      await chrome.contextMenus.remove(CONTEXT_MENU_ID);
    } catch {}
    await chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'label element',
      contexts: ['all'],
    });
  } catch (e) {
    console.warn('ElementMarker: ensureContextMenu failed:', e);
  }
}

/**
 * Check if element-marker.js is already injected in the tab
 * Uses a short timeout to avoid hanging on unresponsive tabs
 */
async function isMarkerInjected(target: MarkerDocumentTarget): Promise<boolean> {
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(
        target.tabId,
        { action: 'element_marker_ping' },
        { documentId: target.documentId },
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
    ]);
    return response?.status === 'pong';
  } catch {
    return false;
  }
}

/**
 * Inject element-marker.js into the tab if not already injected
 */
async function injectMarkerHelper(tabId: number): Promise<MarkerSession> {
  const initialTarget = await getTopDocumentTarget(tabId);

  // Check if already injected via ping
  const alreadyInjected = await isMarkerInjected(initialTarget);

  if (!alreadyInjected) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['inject-scripts/element-marker.js'],
      world: 'ISOLATED',
    } as any);
  }

  // The tab may have navigated while the helper was being injected. Resolve
  // it again and refuse to start against a different document.
  await assertTargetIsCurrent(initialTarget);
  const session: MarkerSession = {
    ...initialTarget,
    sessionId: crypto.randomUUID(),
  };
  markerSessions.set(tabId, session);

  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { action: 'element_marker_start', markerSessionId: session.sessionId } as any,
      { documentId: session.documentId },
    );
    if (response?.ok !== true) {
      throw new Error(response?.error || 'marker overlay did not start');
    }
  } catch (e) {
    if (markerSessions.get(tabId)?.sessionId === session.sessionId) {
      markerSessions.delete(tabId);
    }
    throw e;
  }

  await assertTargetIsCurrent(session);
  return session;
}

export function initElementMarkerListeners() {
  // Ensure context menu on startup
  ensureContextMenu().catch(() => {});

  // Respond to RR triggers refresh by re-ensuring our menu a bit later
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      switch (message?.type) {
        // Handle element marker start from popup
        case BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_START: {
          if (!isExtensionPageSender(sender)) {
            sendResponse({ success: false, error: 'marker start requires an extension page' });
            return true;
          }
          const tabId = message.tabId;
          if (typeof tabId !== 'number') {
            sendResponse({ success: false, error: 'invalid tabId' });
            return true;
          }
          injectMarkerHelper(tabId)
            .then((session) =>
              sendResponse({ success: true, markerSessionId: session.sessionId }),
            )
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_STOP: {
          const session =
            typeof sender.tab?.id === 'number' ? markerSessions.get(sender.tab.id) : undefined;
          if (!session || !isSenderBoundToSession(sender, session, message.markerSessionId)) {
            sendResponse({ success: false, error: 'marker session does not match the sender document' });
            return true;
          }
          markerSessions.delete(session.tabId);
          sendResponse({ success: true });
          return false;
        }
        case BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_LIST_ALL: {
          assertExtensionPageMarkerAccess(sender);
          listAllMarkers()
            .then((markers) => sendResponse({ success: true, markers }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_LIST_FOR_URL: {
          assertExtensionPageMarkerAccess(sender);
          const url = String(message.url || '');
          listMarkersForUrl(url)
            .then((markers) => sendResponse({ success: true, markers }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE: {
          const req = message.marker as UpsertMarkerRequest;
          authorizeMarkerSave(message, req, sender)
            .then(() => saveMarker(req))
            .then((marker) => sendResponse({ success: true, marker }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_UPDATE: {
          assertExtensionPageMarkerAccess(sender);
          const marker = message.marker as ElementMarker;
          updateMarker(marker)
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_DELETE: {
          assertExtensionPageMarkerAccess(sender);
          const id = String(message.id || '');
          if (!id) {
            sendResponse({ success: false, error: 'invalid id' });
            return true;
          }
          deleteMarker(id)
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_VALIDATE: {
          // Validate via MCP tool chain
          (async () => {
            const req = message as MarkerValidationRequest;
            const selector = String(req.selector || '').trim();
            const selectorType = (req.selectorType || 'css') as 'css' | 'xpath';
            const action = req.action as MarkerValidationAction;
            if (!selector) return sendResponse({ success: false, error: 'selector is required' });
            let target: MarkerDocumentTarget;
            try {
              target = await authorizeValidationTarget(req, sender);
            } catch (error) {
              return sendResponse({
                success: false,
                error: String(error instanceof Error ? error.message : error),
              });
            }

            // 1) Ensure helper
            try {
              await chrome.scripting.executeScript({
                target: { tabId: target.tabId, allFrames: true },
                files: ['inject-scripts/accessibility-tree-helper.js'],
                world: 'ISOLATED',
              } as any);
            } catch {}

            // 2) Resolve selector -> ref/center via helper (same as tools)
            let ensured: any;
            try {
              ensured = await chrome.tabs.sendMessage(
                target.tabId,
                {
                  action: 'ensureRefForSelector',
                  selector,
                  isXPath: selectorType === 'xpath',
                  allowMultiple: !!req.listMode,
                } as any,
                { documentId: target.documentId },
              );
            } catch (e) {
              return sendResponse({
                success: false,
                error: String(e instanceof Error ? e.message : e),
              });
            }
            if (!ensured || !ensured.success || !ensured.ref) {
              return sendResponse({
                success: false,
                error: ensured?.error || 'failed to resolve selector',
              });
            }

            try {
              await assertTargetIsCurrent(target);
            } catch (error) {
              return sendResponse({
                success: false,
                error: String(error instanceof Error ? error.message : error),
              });
            }

            const base = {
              success: true,
              resolved: true,
              ref: ensured.ref,
              center: ensured.center,
            } as any;

            // Compute optional coordinates from offsets
            let coords: { x: number; y: number } | undefined = undefined;
            if (
              req.coordinates &&
              typeof req.coordinates.x === 'number' &&
              typeof req.coordinates.y === 'number'
            ) {
              coords = { x: Math.round(req.coordinates.x), y: Math.round(req.coordinates.y) };
            } else if (
              req.relativeTo === 'element' &&
              ensured.center &&
              (typeof req.offsetX === 'number' || typeof req.offsetY === 'number')
            ) {
              const dx = typeof req.offsetX === 'number' && Number.isFinite(req.offsetX) ? req.offsetX : 0;
              const dy = typeof req.offsetY === 'number' && Number.isFinite(req.offsetY) ? req.offsetY : 0;
              coords = { x: ensured.center.x + dx, y: ensured.center.y + dy };
            }

            // 3) Dispatch to appropriate tool for end-to-end validation
            try {
              switch (action) {
                case 'hover': {
                  const r = await computerTool.execute(
                    coords
                      ? { action: 'hover', coordinates: coords, tabId: target.tabId }
                      : ({ action: 'hover', ref: ensured.ref, tabId: target.tabId } as any),
                  );
                  const error = r.isError ? extractToolError(r) : undefined;
                  base.tool = { name: 'computer.hover', ok: !r.isError, error };
                  break;
                }
                case 'left_click': {
                  const timeout =
                    typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs)
                      ? req.timeoutMs
                      : 3000;
                  const r = await clickTool.execute({
                    ...(coords ? { coordinates: coords } : { ref: ensured.ref }),
                    waitForNavigation: !!req.waitForNavigation,
                    timeout,
                    button: (req.button || 'left') as any,
                    modifiers: req.modifiers || {},
                    tabId: target.tabId,
                  } as any);
                  const error = r.isError ? extractToolError(r) : undefined;
                  base.tool = { name: 'interaction.click', ok: !r.isError, error };
                  break;
                }
                case 'double_click': {
                  const timeout =
                    typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs)
                      ? req.timeoutMs
                      : 3000;
                  const r = await clickTool.execute({
                    ...(coords ? { coordinates: coords } : { ref: ensured.ref }),
                    double: true,
                    waitForNavigation: !!req.waitForNavigation,
                    timeout,
                    button: (req.button || 'left') as any,
                    modifiers: req.modifiers || {},
                    tabId: target.tabId,
                  } as any);
                  const error = r.isError ? extractToolError(r) : undefined;
                  base.tool = { name: 'interaction.click(double)', ok: !r.isError, error };
                  break;
                }
                case 'right_click': {
                  const timeout =
                    typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs)
                      ? req.timeoutMs
                      : 3000;
                  const r = await clickTool.execute({
                    ...(coords ? { coordinates: coords } : { ref: ensured.ref }),
                    waitForNavigation: !!req.waitForNavigation,
                    timeout,
                    button: 'right',
                    modifiers: req.modifiers || {},
                    tabId: target.tabId,
                  } as any);
                  const error = r.isError ? extractToolError(r) : undefined;
                  base.tool = { name: 'interaction.click(right)', ok: !r.isError, error };
                  break;
                }
                case 'scroll': {
                  const direction = (req as any).scrollDirection || 'down';
                  const amount = Number.isFinite((req as any).scrollAmount)
                    ? Number((req as any).scrollAmount)
                    : 300;
                  const payload = coords
                    ? {
                        action: 'scroll',
                        scrollDirection: direction,
                        scrollAmount: amount,
                        coordinates: coords,
                        tabId: target.tabId,
                      }
                    : ({
                        action: 'scroll',
                        scrollDirection: direction,
                        scrollAmount: amount,
                        ref: ensured.ref,
                        tabId: target.tabId,
                      } as any);
                  const r = await computerTool.execute(payload as any);
                  const error = r.isError ? extractToolError(r) : undefined;
                  base.tool = { name: 'computer.scroll', ok: !r.isError, error };
                  break;
                }
                case 'type_text': {
                  const text = String(req.text || '');
                  const r = await computerTool.execute({
                    action: 'type',
                    ref: ensured.ref,
                    text,
                    tabId: target.tabId,
                  });
                  const error = r.isError ? extractToolError(r) : undefined;
                  base.tool = { name: 'computer.type', ok: !r.isError, error };
                  break;
                }
                case 'press_keys': {
                  const keys = String(req.keys || '');
                  // Focus first by ref to ensure key target
                  try {
                    await clickTool.execute({
                      ref: ensured.ref,
                      waitForNavigation: false,
                      timeout: 2000,
                      tabId: target.tabId,
                    });
                  } catch {}
                  const r = await keyboardTool.execute({
                    keys,
                    delay: 0,
                    tabId: target.tabId,
                  } as any);
                  const error = r.isError ? extractToolError(r) : undefined;
                  base.tool = { name: 'keyboard.simulate', ok: !r.isError, error };
                  break;
                }
                default: {
                  base.tool = { name: 'noop', ok: true };
                }
              }
            } catch (e) {
              console.warn('[ElementMarker] Validation failed before tool execution', e);
              base.tool = {
                name: 'unknown',
                ok: false,
                error: String(e instanceof Error ? e.message : e),
              };
            }

            // Log tool failures for debugging
            if (base.tool && base.tool.ok === false) {
              console.warn('[ElementMarker] Tool validation failure', {
                action,
                toolName: base.tool.name,
                error: base.tool.error,
                selector,
                selectorType,
              });
            }

            return sendResponse(base);
          })();
          return true;
        }
        // When RR refresh (or similar) happens, re-add our menu
        case BACKGROUND_MESSAGE_TYPES.RR_REFRESH_TRIGGERS:
        case BACKGROUND_MESSAGE_TYPES.RR_SAVE_TRIGGER:
        case BACKGROUND_MESSAGE_TYPES.RR_DELETE_TRIGGER: {
          setTimeout(() => ensureContextMenu().catch(() => {}), 300);
          break;
        }
      }
    } catch (e) {
      sendResponse({ success: false, error: (e as any)?.message || String(e) });
    }
    return false;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    markerSessions.delete(tabId);
  });

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === TOP_FRAME_ID) {
      markerSessions.delete(details.tabId);
    }
  });

  // Context menu click routing
  if ((chrome as any).contextMenus?.onClicked?.addListener) {
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      try {
        if (info.menuItemId === CONTEXT_MENU_ID && tab?.id) {
          await injectMarkerHelper(tab.id);
        }
      } catch (e) {
        console.warn('ElementMarker: context menu click failed:', e);
      }
    });
  }
}
