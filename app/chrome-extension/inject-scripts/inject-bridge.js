
(() => {
  // Prevent duplicate injection of the bridge itself.
  if (window.__INJECT_SCRIPT_TOOL_UNIVERSAL_BRIDGE_LOADED__) return;
  window.__INJECT_SCRIPT_TOOL_UNIVERSAL_BRIDGE_LOADED__ = true;
  const EVENT_NAME = {
    RESPONSE: 'webpage-mcp:response',
    CLEANUP: 'webpage-mcp:cleanup',
    EXECUTE: 'webpage-mcp:execute',
  };
  const REQUEST_TIMEOUT_MS = 30_000;
  const pendingRequests = new Map();

  const settlePendingRequest = (requestId, response) => {
    const pending = pendingRequests.get(requestId);
    if (!pending) return false;

    pendingRequests.delete(requestId);
    window.clearTimeout(pending.timeoutId);
    try {
      pending.sendResponse(response);
    } catch {
      // The runtime channel may already be closed during tab teardown.
    }
    return true;
  };

  const rejectPendingRequests = (message) => {
    for (const requestId of Array.from(pendingRequests.keys())) {
      settlePendingRequest(requestId, { error: message });
    }
  };

  const messageHandler = (request, _sender, sendResponse) => {
    // --- Lifecycle Command ---
    if (request.type === EVENT_NAME.CLEANUP) {
      window.dispatchEvent(new CustomEvent(EVENT_NAME.CLEANUP));
      // Acknowledge cleanup signal received, but don't hold the connection.
      sendResponse({ success: true });
      return true;
    }

    // --- Execution Command for MAIN world ---
    if (request.targetWorld === 'MAIN') {
      const requestId = `req-${Date.now()}-${Math.random()}`;
      const timeoutId = window.setTimeout(() => {
        settlePendingRequest(requestId, {
          error: `MAIN world userscript request timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        });
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(requestId, { sendResponse, timeoutId });

      try {
        window.dispatchEvent(
          new CustomEvent(EVENT_NAME.EXECUTE, {
            detail: {
              action: request.action,
              payload: request.payload,
              scriptId: request.scriptId,
              requestId: requestId,
            },
          }),
        );
      } catch (error) {
        settlePendingRequest(requestId, {
          error: String(error?.message || error || 'Failed to dispatch MAIN world request.'),
        });
      }
      return true; // Async response is expected.
    }
    // Note: Requests for ISOLATED world are handled by the user's isolatedWorldCode script directly.
    // This listener won't process them unless it's the only script in ISOLATED world.
  };

  chrome.runtime.onMessage.addListener(messageHandler);

  // Listen for responses coming back from the MAIN world.
  const responseHandler = (event) => {
    const { requestId, data, error } = event.detail || {};
    settlePendingRequest(requestId, { data, error });
  };
  window.addEventListener(EVENT_NAME.RESPONSE, responseHandler);

  // --- Self Cleanup ---
  let disposed = false;
  const dispose = (pendingError) => {
    if (disposed) return;
    disposed = true;
    rejectPendingRequests(pendingError);
    chrome.runtime.onMessage.removeListener(messageHandler);
    window.removeEventListener(EVENT_NAME.RESPONSE, responseHandler);
    window.removeEventListener(EVENT_NAME.CLEANUP, cleanupHandler);
    window.removeEventListener('pagehide', pageHideHandler);
    delete window.__INJECT_SCRIPT_TOOL_UNIVERSAL_BRIDGE_LOADED__;
  };

  // When the cleanup signal arrives, this bridge must also clean itself up.
  const cleanupHandler = () => {
    dispose('Userscript bridge was cleaned up before receiving a response.');
  };
  const pageHideHandler = () => {
    dispose('Userscript bridge page unloaded before receiving a response.');
  };
  window.addEventListener(EVENT_NAME.CLEANUP, cleanupHandler);
  window.addEventListener('pagehide', pageHideHandler, { once: true });
})();
