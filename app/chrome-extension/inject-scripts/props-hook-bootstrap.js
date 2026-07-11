/* eslint-disable */
// @ts-nocheck
/**
 * Install the smallest React DevTools-compatible hook needed to observe
 * renderers that initialize before the Web Editor is activated.
 *
 * This document_start script intentionally exposes no command transport.
 * Props operations are authorized in the background and executed one at a
 * time in the exact sender document.
 */
(() => {
  'use strict';

  const HOOK_NAME = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
  try {
    const legacyAgent = window.__MCP_WEB_EDITOR_PROPS_AGENT__;
    if (
      legacyAgent &&
      legacyAgent.version !== 2 &&
      typeof legacyAgent.dispose === 'function'
    ) {
      try {
        legacyAgent.dispose();
      } catch {
        // Always install the inert v2 sentinel below.
      }
    }
    try {
      window.dispatchEvent(new Event('web-editor-props:cleanup'));
    } catch {
      // Legacy cleanup is best-effort.
    }
    window.__MCP_WEB_EDITOR_PROPS_AGENT__ = Object.freeze({
      version: 2,
      transport: 'background-only',
    });
    const existing = window[HOOK_NAME];
    if (existing && typeof existing.inject === 'function') return;

    const listeners = Object.create(null);
    const hook = {
      renderers: new Map(),
      supportsFiber: true,
      inject(renderer) {
        try {
          const id = this.renderers.size + 1;
          this.renderers.set(id, renderer);
          this.emit('renderer', { id, renderer });
          return id;
        } catch {
          return 0;
        }
      },
      onCommitFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      setStrictMode() {},
      checkDCE() {},
      on(event, fn) {
        if (typeof event !== 'string' || typeof fn !== 'function') return;
        if (!listeners[event]) listeners[event] = new Set();
        listeners[event].add(fn);
      },
      off(event, fn) {
        if (typeof event !== 'string' || typeof fn !== 'function') return;
        listeners[event]?.delete(fn);
      },
      emit(event, data) {
        const callbacks = listeners[event];
        if (!callbacks) return;
        for (const callback of Array.from(callbacks)) {
          try {
            callback(data);
          } catch {
            // A renderer listener must not break the hook.
          }
        }
      },
      sub(event, fn) {
        this.on(event, fn);
        return () => this.off(event, fn);
      },
    };

    window[HOOK_NAME] = hook;
  } catch {
    // Early injection is best-effort on pages with unusual globals.
  }
})();
