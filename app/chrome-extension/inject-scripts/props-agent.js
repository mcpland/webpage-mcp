/* eslint-disable */
// @ts-nocheck
/**
 * Props Agent - MAIN World Script
 *
 * Runtime hacking agent for React props editing.
 * Communicates with ISOLATED world via CustomEvent.
 *
 * Architecture:
 * - Transport: CustomEvent-based request/response
 * - Locator: Simplified ElementLocator resolution
 * - ReactAdapter: DevTools Hook detection/injection + overrideProps
 * - Serializer: Safe Props serialization with type preservation
 * - Handlers: Request operation dispatch
 *
 * @module props-agent
 */
(() => {
  'use strict';

  // =============================================================================
  // Constants & Guards
  // =============================================================================

  const GLOBAL_KEY = '__MCP_WEB_EDITOR_PROPS_AGENT__';
  if (window[GLOBAL_KEY]) return;

  const PROTOCOL_VERSION = 1;
  const LOG_PREFIX = '[PropsAgent]';

  const EVENT_NAME = Object.freeze({
    REQUEST: 'web-editor-props:request',
    RESPONSE: 'web-editor-props:response',
    CLEANUP: 'web-editor-props:cleanup',
  });

  const REACT_HOOK_NAME = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

  const LOCATOR_LIMITS = Object.freeze({
    maxSelectors: 16,
    maxShadowHosts: 16,
    maxSelectorBytes: 4 * 1024,
    maxSelectorSteps: 256,
    maxVisitedElements: 12000,
    maxDepth: 128,
    maxDurationMs: 250,
  });
  const TRANSPORT_LIMITS = Object.freeze({
    maxRequestIdBytes: 128,
    maxRequestBytes: 64 * 1024,
    maxResponseBytes: 256 * 1024,
    maxErrorBytes: 4 * 1024,
    maxPropPathEntries: 32,
    maxPropPathBytes: 4 * 1024,
    maxPropSegmentBytes: 512,
    maxValueBytes: 16 * 1024,
  });
  const SUPPORTED_OPERATIONS = new Set(['probe', 'read', 'write', 'reset', 'cleanup']);
  const NATIVE_ELEMENT_MATCHES = Element.prototype.matches;

  /** @type {'READY' | 'HOOK_PRESENT_NO_RENDERERS' | 'RENDERERS_NO_EDITING' | 'HOOK_MISSING'} */
  const HOOK_STATUS = Object.freeze({
    READY: 'READY',
    HOOK_PRESENT_NO_RENDERERS: 'HOOK_PRESENT_NO_RENDERERS',
    RENDERERS_NO_EDITING: 'RENDERERS_NO_EDITING',
    HOOK_MISSING: 'HOOK_MISSING',
  });

  const SERIALIZE_LIMITS = Object.freeze({
    maxDepth: 4,
    maxEntries: 100,
    maxArrayLength: 50,
    maxStringLength: 1500,
    maxKeyBytes: 512,
    maxNodes: 2000,
    maxBytes: 192 * 1024,
    maxDurationMs: 100,
  });

  // =============================================================================
  // Utilities
  // =============================================================================

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function safeString(value) {
    try {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      return String(value);
    } catch {
      return '';
    }
  }

  function utf8BytesForCodePoint(codePoint) {
    if (codePoint <= 0x7f) return 1;
    if (codePoint <= 0x7ff) return 2;
    if (codePoint <= 0xffff) return 3;
    return 4;
  }

  function utf8ByteLength(value, stopAfter = Number.POSITIVE_INFINITY) {
    let bytes = 0;
    for (const character of typeof value === 'string' ? value : '') {
      bytes += utf8BytesForCodePoint(character.codePointAt(0) || 0);
      if (bytes > stopAfter) return bytes;
    }
    return bytes;
  }

  function truncateUtf8(value, maxBytes, maxCodeUnits = maxBytes) {
    const input = safeString(value);
    let output = '';
    let bytes = 0;
    let codeUnits = 0;
    for (const character of input) {
      const characterBytes = utf8BytesForCodePoint(character.codePointAt(0) || 0);
      if (bytes + characterBytes > maxBytes || codeUnits + character.length > maxCodeUnits) break;
      output += character;
      bytes += characterBytes;
      codeUnits += character.length;
    }
    return output;
  }

  function logWarn(...args) {
    try {
      console.warn(LOG_PREFIX, ...args);
    } catch {
      // Silently ignore
    }
  }

  // =============================================================================
  // Transport Layer
  // =============================================================================

  const Transport = {
    dispatchResponse(detail) {
      try {
        let response = detail;
        const encoded = JSON.stringify(detail);
        if (
          typeof encoded !== 'string' ||
          utf8ByteLength(encoded, TRANSPORT_LIMITS.maxResponseBytes) >
            TRANSPORT_LIMITS.maxResponseBytes
        ) {
          response = this.createResponse(
            truncateUtf8(detail?.requestId, TRANSPORT_LIMITS.maxRequestIdBytes),
            false,
            undefined,
            'Props response exceeded the resource limit',
          );
        }
        window.dispatchEvent(new CustomEvent(EVENT_NAME.RESPONSE, { detail: response }));
      } catch (err) {
        logWarn('Failed to dispatch response:', err);
      }
    },

    createResponse(requestId, success, data, error) {
      const response = {
        v: PROTOCOL_VERSION,
        requestId,
        success: Boolean(success),
      };
      if (data !== undefined) response.data = data;
      if (error !== undefined) {
        response.error = truncateUtf8(error, TRANSPORT_LIMITS.maxErrorBytes);
      }
      return response;
    },

    normalizeRequest(detail) {
      if (!isObject(detail)) return null;
      if (detail.v !== PROTOCOL_VERSION) return null;

      const requestId = typeof detail.requestId === 'string' ? detail.requestId : '';
      const op = typeof detail.op === 'string' ? detail.op : '';
      if (
        !requestId ||
        utf8ByteLength(requestId, TRANSPORT_LIMITS.maxRequestIdBytes) >
          TRANSPORT_LIMITS.maxRequestIdBytes ||
        !SUPPORTED_OPERATIONS.has(op)
      ) {
        return null;
      }

      const locator =
        detail.locator === undefined ? undefined : Locator.copyLocatorEnvelope(detail.locator);
      if (detail.locator !== undefined && !locator) return null;
      if ((op === 'read' || op === 'write' || op === 'reset') && !locator) return null;

      let payload;
      if (op === 'write') {
        if (!isObject(detail.payload)) return null;
        const propPath = normalizePropPath(detail.payload.propPath);
        if (!propPath) return null;
        const propValue = detail.payload.propValue;
        const decodedValue = decodeIncomingValue(propValue);
        if (!Serializer.isEditablePrimitive(decodedValue)) return null;
        if (
          typeof decodedValue === 'string' &&
          utf8ByteLength(decodedValue, TRANSPORT_LIMITS.maxValueBytes) >
            TRANSPORT_LIMITS.maxValueBytes
        ) {
          return null;
        }
        payload = {
          propPath,
          propValue: decodedValue === undefined ? { $we: 'undefined' } : decodedValue,
        };
      }

      const request = {
        v: PROTOCOL_VERSION,
        requestId,
        op,
        locator,
        payload,
      };
      try {
        const encoded = JSON.stringify(request);
        if (
          typeof encoded !== 'string' ||
          utf8ByteLength(encoded, TRANSPORT_LIMITS.maxRequestBytes) >
            TRANSPORT_LIMITS.maxRequestBytes
        ) {
          return null;
        }
      } catch {
        return null;
      }
      return request;
    },
  };

  // =============================================================================
  // Locator - Element Resolution
  // =============================================================================

  const Locator = {
    createBudget() {
      return {
        visited: 0,
        deadline: Date.now() + LOCATOR_LIMITS.maxDurationMs,
      };
    },

    normalizeSelector(value) {
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > LOCATOR_LIMITS.maxSelectorBytes ||
        utf8ByteLength(value, LOCATOR_LIMITS.maxSelectorBytes) >
          LOCATOR_LIMITS.maxSelectorBytes
      ) {
        return null;
      }
      const selector = value.trim();
      if (!selector || /:has\s*\(/i.test(selector)) return null;

      let structuralSteps = 0;
      let inWhitespace = false;
      for (const character of selector) {
        if (/\s/.test(character)) {
          if (!inWhitespace) structuralSteps += 1;
          inWhitespace = true;
        } else {
          inWhitespace = false;
          if ('>+~,[]()'.includes(character)) structuralSteps += 1;
        }
        if (structuralSteps > LOCATOR_LIMITS.maxSelectorSteps) return null;
      }
      return selector;
    },

    findUnique(root, selector, budget) {
      const normalized = this.normalizeSelector(selector);
      if (!root || !normalized || !budget) return null;

      try {
        const first =
          root.nodeType === Node.DOCUMENT_NODE
            ? root.documentElement
            : root.firstElementChild;
        if (!(first instanceof Element)) return null;

        const stack = [{ element: first, depth: 0 }];
        let match = null;
        while (stack.length > 0) {
          if (
            budget.visited >= LOCATOR_LIMITS.maxVisitedElements ||
            Date.now() > budget.deadline
          ) {
            return null;
          }

          const entry = stack.pop();
          if (!entry || entry.depth > LOCATOR_LIMITS.maxDepth) return null;
          const element = entry.element;
          budget.visited += 1;

          if (NATIVE_ELEMENT_MATCHES.call(element, normalized)) {
            // Stop as soon as a second match disproves uniqueness.
            if (match) return null;
            match = element;
          }

          const sibling = element.nextElementSibling;
          if (sibling) stack.push({ element: sibling, depth: entry.depth });
          const child = element.firstElementChild;
          if (child) {
            if (entry.depth >= LOCATOR_LIMITS.maxDepth) return null;
            stack.push({ element: child, depth: entry.depth + 1 });
          }
        }
        return match;
      } catch {
        return null;
      }
    },

    computeFingerprint(element) {
      try {
        const parts = [];
        const tag = element?.tagName ? String(element.tagName).toLowerCase() : 'unknown';
        parts.push(tag);
        const id = element?.id ? String(element.id).trim() : '';
        if (id) parts.push(`id=${id}`);
        return parts.join('|');
      } catch {
        return '';
      }
    },

    verifyFingerprint(element, fingerprint) {
      try {
        const current = this.computeFingerprint(element);
        const storedParts = safeString(fingerprint).split('|');
        const currentParts = current.split('|');

        // Tag must match
        if (storedParts[0] !== currentParts[0]) return false;

        // If stored has id, current must have same id
        const storedId = storedParts.find((p) => p.startsWith('id='));
        const currentId = currentParts.find((p) => p.startsWith('id='));
        if (storedId && storedId !== currentId) return false;

        return true;
      } catch {
        return false;
      }
    },

    normalizeStringArray(value, maximumEntries) {
      if (!Array.isArray(value) || value.length > maximumEntries) return null;
      const output = [];
      for (const item of value) {
        const selector = this.normalizeSelector(item);
        if (!selector) return null;
        output.push(selector);
      }
      return output;
    },

    normalizeLocator(value) {
      if (!isObject(value)) return null;
      const selectors = this.normalizeStringArray(value.selectors || [], LOCATOR_LIMITS.maxSelectors);
      const shadowHostChain = this.normalizeStringArray(
        value.shadowHostChain || [],
        LOCATOR_LIMITS.maxShadowHosts,
      );
      const frameChain = this.normalizeStringArray(
        value.frameChain || [],
        LOCATOR_LIMITS.maxShadowHosts,
      );
      if (!selectors || selectors.length === 0 || !shadowHostChain || !frameChain) return null;

      const fingerprint = typeof value.fingerprint === 'string' ? value.fingerprint : '';
      if (
        utf8ByteLength(fingerprint, LOCATOR_LIMITS.maxSelectorBytes) >
        LOCATOR_LIMITS.maxSelectorBytes
      ) {
        return null;
      }

      const rawPath = value.path === undefined ? [] : value.path;
      if (!Array.isArray(rawPath) || rawPath.length > LOCATOR_LIMITS.maxDepth) return null;
      const path = [];
      for (const index of rawPath) {
        if (!Number.isSafeInteger(index) || index < 0 || index > 1000000) return null;
        path.push(index);
      }

      return { selectors, fingerprint, path, shadowHostChain, frameChain };
    },

    copyLocatorEnvelope(value) {
      if (!isObject(value)) return null;
      const copyArray = (candidate, maximum) => {
        if (!Array.isArray(candidate) || candidate.length > maximum) return null;
        const output = [];
        for (const item of candidate) output.push(item);
        return output;
      };
      const selectors = copyArray(value.selectors || [], LOCATOR_LIMITS.maxSelectors);
      const shadowHostChain = copyArray(
        value.shadowHostChain || [],
        LOCATOR_LIMITS.maxShadowHosts,
      );
      const frameChain = copyArray(value.frameChain || [], LOCATOR_LIMITS.maxShadowHosts);
      const path = copyArray(value.path || [], LOCATOR_LIMITS.maxDepth);
      if (!selectors || !shadowHostChain || !frameChain || !path) return null;
      return {
        selectors,
        fingerprint: value.fingerprint,
        path,
        shadowHostChain,
        frameChain,
      };
    },

    /**
     * Resolve ElementLocator to DOM element
     * Simplified version for MAIN world (no iframe support yet)
     */
    locate(locator, rootDocument = document) {
      try {
        const normalizedLocator = this.normalizeLocator(locator);
        if (!normalizedLocator) return null;

        let queryRoot = rootDocument;
        const budget = this.createBudget();

        // Traverse Shadow DOM host chain
        const shadowHostChain = this.normalizeStringArray(
          normalizedLocator.shadowHostChain,
          LOCATOR_LIMITS.maxShadowHosts,
        );
        if (!shadowHostChain) return null;
        for (const hostSelector of shadowHostChain) {
          const host = this.findUnique(queryRoot, hostSelector, budget);
          if (!host) return null;
          const shadowRoot = host.shadowRoot;
          if (!shadowRoot) return null;
          queryRoot = shadowRoot;
        }

        // Try each selector candidate
        const selectors = this.normalizeStringArray(
          normalizedLocator.selectors,
          LOCATOR_LIMITS.maxSelectors,
        );
        if (!selectors) return null;
        for (const selector of selectors) {
          const element = this.findUnique(queryRoot, selector, budget);
          if (!element) continue;

          // Verify fingerprint if provided
          const fp = normalizedLocator.fingerprint;
          if (fp && !this.verifyFingerprint(element, fp)) continue;

          return element;
        }
      } catch {
        // Best-effort
      }
      return null;
    },
  };

  // =============================================================================
  // React Adapter
  // =============================================================================

  const ReactAdapter = {
    /** Store original values for reset (fiber -> { renderer, originals: Map }) */
    overrideStore: typeof WeakMap === 'function' ? new WeakMap() : null,

    /** Flag to avoid repeated hook installation attempts */
    hookInstallAttempted: false,

    getHook() {
      try {
        return window[REACT_HOOK_NAME] || null;
      } catch {
        return null;
      }
    },

    /**
     * Install minimal DevTools hook if missing.
     * Note: This only helps if React hasn't initialized yet.
     * Only attempts once per session to avoid repeated pollution.
     */
    installMinimalHook() {
      // Only attempt once per session
      if (this.hookInstallAttempted) {
        return { installed: false, hook: this.getHook(), skipped: true };
      }
      this.hookInstallAttempted = true;
      try {
        const existing = window[REACT_HOOK_NAME];
        if (existing && typeof existing.inject === 'function') {
          return { installed: false, hook: existing };
        }

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

          // Required lifecycle callbacks (no-ops)
          onCommitFiberRoot() {},
          onCommitFiberUnmount() {},
          onPostCommitFiberRoot() {},
          setStrictMode() {},
          checkDCE() {},

          // Event emitter
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
            const set = listeners[event];
            if (!set) return;
            for (const fn of Array.from(set)) {
              try {
                fn(data);
              } catch {
                // Listener errors must not break the hook
              }
            }
          },

          sub(event, fn) {
            this.on(event, fn);
            return () => this.off(event, fn);
          },
        };

        window[REACT_HOOK_NAME] = hook;
        return { installed: true, hook };
      } catch (err) {
        return { installed: false, hook: null, error: err };
      }
    },

    /**
     * Normalize hook.renderers to array format
     */
    normalizeRenderers(hook) {
      const result = [];
      if (!hook) return result;

      try {
        const renderers = hook.renderers;
        if (renderers instanceof Map) {
          for (const [id, renderer] of renderers.entries()) {
            if (result.length >= 32) break;
            result.push({ id, renderer });
          }
        } else if (renderers && typeof renderers === 'object') {
          for (const id in renderers) {
            if (result.length >= 32) break;
            if (!Object.prototype.hasOwnProperty.call(renderers, id)) continue;
            result.push({ id, renderer: renderers[id] });
          }
        }
      } catch {
        // Best-effort
      }
      return result;
    },

    /**
     * Detect Hook status (4 states)
     */
    detectStatus() {
      const hook = this.getHook();

      if (!hook || typeof hook.inject !== 'function') {
        return {
          hookStatus: HOOK_STATUS.HOOK_MISSING,
          hook: null,
          renderers: [],
          editableRenderers: [],
        };
      }

      const renderers = this.normalizeRenderers(hook);
      if (!renderers.length) {
        return {
          hookStatus: HOOK_STATUS.HOOK_PRESENT_NO_RENDERERS,
          hook,
          renderers,
          editableRenderers: [],
        };
      }

      const editableRenderers = renderers.filter(
        (r) => r?.renderer && typeof r.renderer.overrideProps === 'function',
      );

      if (editableRenderers.length) {
        return {
          hookStatus: HOOK_STATUS.READY,
          hook,
          renderers,
          editableRenderers,
        };
      }

      return {
        hookStatus: HOOK_STATUS.RENDERERS_NO_EDITING,
        hook,
        renderers,
        editableRenderers: [],
      };
    },

    /**
     * Get React version from renderer or global.
     * Prioritizes specific renderer version for multi-renderer scenarios.
     *
     * @param {object} hookInfo - Result from detectStatus()
     * @param {object} [specificRenderer] - Specific renderer to prefer (from resolveFiberWithRenderer)
     * @returns {string | undefined}
     */
    getVersion(hookInfo, specificRenderer) {
      try {
        // Priority 1: Specific renderer version (for multi-renderer scenarios)
        if (specificRenderer) {
          const version = specificRenderer.version;
          if (typeof version === 'string' && version.trim()) {
            return version.trim();
          }
        }

        // Priority 2: Any renderer with version
        const renderers = hookInfo?.renderers || [];
        for (const item of renderers) {
          const version = item?.renderer?.version;
          if (typeof version === 'string' && version.trim()) {
            return version.trim();
          }
        }

        // Priority 3: Global React object (if exposed)
        if (typeof window !== 'undefined' && window.React?.version) {
          return String(window.React.version).trim();
        }
      } catch {
        // Best-effort
      }
      return undefined;
    },

    /**
     * Find React fiber from DOM node
     */
    findFiberFromDOM(node) {
      try {
        if (!node || typeof node !== 'object') return null;
        let inspected = 0;
        for (const key in node) {
          if (inspected >= 256) break;
          if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
          inspected += 1;
          if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
            return node[key];
          }
        }
      } catch {
        // Best-effort
      }
      return null;
    },

    /**
     * Check if fiber tag is a component (Function/Class/ForwardRef etc.)
     */
    isComponentTag(tag) {
      // 0=FunctionComponent, 1=ClassComponent, 2=IndeterminateComponent,
      // 11=ForwardRef, 14=MemoComponent, 15=SimpleMemoComponent
      return tag === 0 || tag === 1 || tag === 2 || tag === 11 || tag === 14 || tag === 15;
    },

    /**
     * Find nearest component fiber by walking up the fiber tree
     */
    findNearestComponentFiber(fiber) {
      try {
        let current = fiber;
        for (let i = 0; i < 60 && current; i++) {
          if (this.isComponentTag(current.tag)) return current;
          current = current.return;
        }
      } catch {
        // Best-effort
      }
      return null;
    },

    /**
     * Get component display name from fiber
     */
    getComponentName(fiber) {
      try {
        const type = fiber?.type || fiber?.elementType;
        if (!type) return 'Anonymous';
        if (typeof type === 'string') return type;
        return safeString(type.displayName || type.name) || 'Anonymous';
      } catch {
        return 'Anonymous';
      }
    },

    /**
     * Extract debug source from React Fiber.
     * Walks up the fiber tree checking _debugSource and _debugOwner._debugSource.
     *
     * @param {object} fiber - React Fiber node
     * @returns {{ file: string, line?: number, column?: number, componentName?: string } | null}
     */
    getDebugSource(fiber) {
      try {
        let current = fiber;
        for (let i = 0; i < 40 && current; i++) {
          if (!isObject(current)) break;

          // Try direct _debugSource first
          const src = isObject(current._debugSource) ? current._debugSource : null;
          if (src) {
            const file = safeString(src.fileName).trim();
            if (file) {
              return this.buildDebugSourceResult(file, src.lineNumber, src.columnNumber, current);
            }
          }

          // Fallback to _debugOwner._debugSource
          const owner = isObject(current._debugOwner) ? current._debugOwner : null;
          const ownerSrc = owner && isObject(owner._debugSource) ? owner._debugSource : null;
          if (ownerSrc) {
            const ownerFile = safeString(ownerSrc.fileName).trim();
            if (ownerFile) {
              return this.buildDebugSourceResult(
                ownerFile,
                ownerSrc.lineNumber,
                ownerSrc.columnNumber,
                owner,
              );
            }
          }

          current = current.return;
        }
      } catch {
        // Best-effort extraction
      }
      return null;
    },

    /**
     * Build debug source result with validated line/column values.
     * @private
     */
    buildDebugSourceResult(file, lineNumber, columnNumber, fiberForName) {
      const line = Number(lineNumber);
      const column = Number(columnNumber);
      return {
        file,
        line: Number.isFinite(line) && line > 0 ? line : undefined,
        column: Number.isFinite(column) && column > 0 ? column : undefined,
        componentName: this.getComponentName(fiberForName),
      };
    },

    /**
     * Resolve fiber using renderer.findFiberByHostInstance when available
     */
    resolveFiberWithRenderer(element, hookInfo) {
      // Prefer renderer API (returns renderer-owned fiber suitable for overrideProps)
      try {
        const renderers = hookInfo?.renderers || [];
        for (const item of renderers) {
          const renderer = item?.renderer;
          if (!renderer || typeof renderer.findFiberByHostInstance !== 'function') continue;
          try {
            const fiber = renderer.findFiberByHostInstance(element);
            if (fiber) return { fiber, renderer };
          } catch {
            // Try next renderer
          }
        }
      } catch {
        // Best-effort
      }

      // Fallback: DOM-attached fiber reference
      const fallback = this.findFiberFromDOM(element);
      return { fiber: fallback, renderer: null };
    },

    /**
     * Record original value for reset
     */
    recordOriginal(fiber, renderer, path, existed, value) {
      if (!this.overrideStore || !fiber) return;

      try {
        const key = JSON.stringify(path);
        let store = this.overrideStore.get(fiber);

        if (!store) {
          store = { renderer: renderer || null, originals: new Map() };
          this.overrideStore.set(fiber, store);

          // Also store by alternate to improve reset hit rate
          if (fiber.alternate && typeof fiber.alternate === 'object') {
            this.overrideStore.set(fiber.alternate, store);
          }
        }

        if (!store.originals.has(key)) {
          store.originals.set(key, { path, existed, value });
        }

        if (!store.renderer && renderer) {
          store.renderer = renderer;
        }
      } catch {
        // Best-effort
      }
    },

    /**
     * Get stored originals for fiber
     */
    getOriginals(fiber) {
      if (!this.overrideStore || !fiber) return null;
      return this.overrideStore.get(fiber) || null;
    },

    /**
     * Clear stored originals for fiber
     */
    clearOriginals(fiber) {
      if (!this.overrideStore || !fiber) return;
      const store = this.overrideStore.get(fiber);
      if (store?.originals) store.originals.clear();
    },
  };

  // =============================================================================
  // Framework Detector
  // =============================================================================

  const FrameworkDetector = {
    /**
     * Detect framework for element (walks up DOM tree)
     */
    detect(element, maxDepth = 15) {
      let node = element;

      for (let depth = 0; depth < maxDepth && node; depth++) {
        // React first (more common)
        const fiber = ReactAdapter.findFiberFromDOM(node);
        if (fiber) {
          return { framework: 'react', node, data: fiber };
        }

        node = node.parentElement;
      }

      return { framework: 'unknown', node: null, data: null };
    },
  };

  // =============================================================================
  // Serializer
  // =============================================================================

  const Serializer = {
    /**
     * Check if value is a React element
     */
    isReactElement(value) {
      try {
        if (!value || typeof value !== 'object') return false;
        const t = value.$$typeof;
        if (!t) return false;

        if (typeof Symbol === 'function' && Symbol.for) {
          return (
            t === Symbol.for('react.element') ||
            t === Symbol.for('react.transitional.element') ||
            t === Symbol.for('react.portal')
          );
        }

        // Fallback heuristic
        return !!(value.type && value.props);
      } catch {
        return false;
      }
    },

    /**
     * Get React element display string
     */
    reactElementDisplay(value) {
      try {
        const type = value?.type;
        if (typeof type === 'string') return `<${type} />`;
        if (typeof type === 'function') {
          return `<${safeString(type.displayName || type.name) || 'Anonymous'} />`;
        }
        if (type && typeof type === 'object') {
          const name = safeString(type.displayName || type.name) || 'Anonymous';
          return `<${name} />`;
        }
      } catch {
        // ignore
      }
      return '<ReactElement />';
    },

    /**
     * Check if value is an editable primitive
     */
    isEditablePrimitive(value) {
      if (value === null || value === undefined) return true;
      const t = typeof value;
      if (t === 'string' || t === 'boolean') return true;
      if (t === 'number') return Number.isFinite(value);
      return false;
    },

    /**
     * Create serialization context for cycle detection
     */
    createContext() {
      return {
        seen: typeof WeakMap === 'function' ? new WeakMap() : null,
        nextId: 1,
        nodes: 0,
        bytes: 0,
        deadline: Date.now() + SERIALIZE_LIMITS.maxDurationMs,
        exhausted: false,
        reason: '',
      };
    },

    markExhausted(ctx, reason) {
      if (!ctx) return;
      ctx.exhausted = true;
      if (!ctx.reason) ctx.reason = reason;
    },

    consumeNode(ctx, fixedBytes = 48) {
      if (!ctx || ctx.exhausted) return false;
      if (Date.now() > ctx.deadline) {
        this.markExhausted(ctx, 'time');
        return false;
      }
      if (ctx.nodes >= SERIALIZE_LIMITS.maxNodes) {
        this.markExhausted(ctx, 'nodes');
        return false;
      }
      if (ctx.bytes + fixedBytes > SERIALIZE_LIMITS.maxBytes) {
        this.markExhausted(ctx, 'bytes');
        return false;
      }
      ctx.nodes += 1;
      ctx.bytes += fixedBytes;
      return true;
    },

    checkBudget(ctx) {
      if (!ctx || ctx.exhausted) return false;
      if (Date.now() > ctx.deadline) {
        this.markExhausted(ctx, 'time');
        return false;
      }
      if (ctx.bytes > SERIALIZE_LIMITS.maxBytes) {
        this.markExhausted(ctx, 'bytes');
        return false;
      }
      return true;
    },

    takeString(value, ctx, maxLength = SERIALIZE_LIMITS.maxStringLength) {
      if (!this.checkBudget(ctx)) return { value: '', truncated: true };
      const input = safeString(value);
      if (!this.checkBudget(ctx)) return { value: '', truncated: true };
      let output = '';
      let bytes = 0;
      let codeUnits = 0;
      let truncated = false;

      for (const character of input) {
        if ((codeUnits & 63) === 0 && !this.checkBudget(ctx)) {
          truncated = true;
          break;
        }
        const characterBytes = utf8BytesForCodePoint(character.codePointAt(0) || 0);
        if (codeUnits + character.length > maxLength) {
          truncated = true;
          break;
        }
        if (!ctx || ctx.bytes + bytes + characterBytes > SERIALIZE_LIMITS.maxBytes) {
          truncated = true;
          this.markExhausted(ctx, 'bytes');
          break;
        }
        output += character;
        bytes += characterBytes;
        codeUnits += character.length;
      }

      if (ctx) ctx.bytes += bytes;
      return { value: output, truncated: truncated || output.length < input.length };
    },

    resourceLimitValue(ctx) {
      return {
        kind: 'unknown',
        type: 'resource_limit',
        preview: `[Serialization stopped: ${safeString(ctx?.reason) || 'limit'}]`,
      };
    },

    collectOwnEnumerableKeys(value, ctx, maximumEntries = SERIALIZE_LIMITS.maxEntries) {
      const keys = [];
      let truncated = false;
      if (!ctx || ctx.exhausted) return { keys, truncated: true };
      try {
        for (const key in value) {
          if (ctx.exhausted) {
            truncated = true;
            break;
          }
          if (Date.now() > ctx.deadline) {
            this.markExhausted(ctx, 'time');
            truncated = true;
            break;
          }
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (keys.length >= maximumEntries) {
            truncated = true;
            break;
          }
          if (
            key.length > SERIALIZE_LIMITS.maxKeyBytes ||
            utf8ByteLength(key, SERIALIZE_LIMITS.maxKeyBytes) > SERIALIZE_LIMITS.maxKeyBytes
          ) {
            truncated = true;
            continue;
          }
          if (ctx.bytes + utf8ByteLength(key) + 24 > SERIALIZE_LIMITS.maxBytes) {
            this.markExhausted(ctx, 'bytes');
            truncated = true;
            break;
          }
          ctx.bytes += utf8ByteLength(key) + 24;
          keys.push(key);
        }
      } catch {
        truncated = true;
      }
      return { keys, truncated };
    },

    /**
     * Serialize a value with type information
     */
    serializeValue(value, ctx, depth = 0) {
      try {
        if (!this.consumeNode(ctx)) return this.resourceLimitValue(ctx);
        if (value === null) return { kind: 'null' };
        if (value === undefined) return { kind: 'undefined' };

        const t = typeof value;

        if (t === 'string') {
          const taken = this.takeString(value, ctx);
          return taken.truncated
            ? { kind: 'string', value: taken.value, truncated: true, length: value.length }
            : { kind: 'string', value: taken.value };
        }

        if (t === 'number') {
          if (Number.isFinite(value)) return { kind: 'number', value };
          if (Number.isNaN(value)) return { kind: 'number', special: 'NaN' };
          return { kind: 'number', special: value > 0 ? 'Infinity' : '-Infinity' };
        }

        if (t === 'boolean') return { kind: 'boolean', value };
        if (t === 'bigint')
          return { kind: 'bigint', value: this.takeString(value.toString(), ctx).value };
        if (t === 'symbol')
          return { kind: 'symbol', description: this.takeString(value, ctx).value };
        if (t === 'function')
          return { kind: 'function', name: this.takeString(value.name, ctx).value || undefined };

        // Object types
        if (this.isReactElement(value)) {
          return {
            kind: 'react_element',
            display: this.takeString(this.reactElementDisplay(value), ctx).value,
          };
        }

        if (typeof Element !== 'undefined' && value instanceof Element) {
          return {
            kind: 'dom_element',
            tagName: this.takeString(value.tagName, ctx, 128).value.toLowerCase(),
            id: this.takeString(value.id, ctx).value || undefined,
            className: this.takeString(value.className, ctx).value || undefined,
          };
        }

        if (value instanceof Date) {
          let iso = '';
          try {
            iso = value.toISOString();
          } catch {
            iso = safeString(value);
          }
          return { kind: 'date', value: this.takeString(iso, ctx).value };
        }

        if (value instanceof RegExp) {
          return {
            kind: 'regexp',
            source: this.takeString(value.source, ctx).value,
            flags: this.takeString(value.flags, ctx, 32).value,
          };
        }

        if (value instanceof Error) {
          return {
            kind: 'error',
            name: this.takeString(value.name, ctx, 128).value || 'Error',
            message: this.takeString(value.message, ctx).value,
          };
        }

        // Depth limit
        if (depth >= SERIALIZE_LIMITS.maxDepth) {
          return {
            kind: 'max_depth',
            type: this.takeString(Object.prototype.toString.call(value), ctx, 128).value,
            preview: this.takeString(value, ctx).value,
          };
        }

        // Circular reference detection
        if (ctx?.seen) {
          const existingId = ctx.seen.get(value);
          if (existingId) return { kind: 'circular', refId: existingId };
          ctx.seen.set(value, ctx.nextId++);
        }

        // Array
        if (Array.isArray(value)) {
          const max = Math.min(value.length, SERIALIZE_LIMITS.maxArrayLength);
          const items = [];
          for (let i = 0; i < max && !ctx.exhausted; i++) {
            items.push(this.serializeValue(value[i], ctx, depth + 1));
          }
          return {
            kind: 'array',
            length: value.length,
            truncated: value.length > items.length,
            items,
          };
        }

        // Map
        if (value instanceof Map) {
          const entries = [];
          let count = 0;
          for (const [k, v] of value.entries()) {
            if (count >= SERIALIZE_LIMITS.maxEntries || ctx.exhausted) break;
            entries.push({
              key: this.serializeValue(k, ctx, depth + 1),
              value: this.serializeValue(v, ctx, depth + 1),
            });
            count++;
          }
          return {
            kind: 'map',
            size: value.size,
            truncated: value.size > count,
            entries,
          };
        }

        // Set
        if (value instanceof Set) {
          const items = [];
          let count = 0;
          for (const v of value.values()) {
            if (count >= SERIALIZE_LIMITS.maxEntries || ctx.exhausted) break;
            items.push(this.serializeValue(v, ctx, depth + 1));
            count++;
          }
          return {
            kind: 'set',
            size: value.size,
            truncated: value.size > count,
            items,
          };
        }

        // Plain object
        const constructorName = value?.constructor?.name;
        const name =
          typeof constructorName === 'string'
            ? this.takeString(constructorName, ctx, 128).value
            : undefined;
        const keyResult = this.collectOwnEnumerableKeys(value, ctx);
        const entries = [];
        for (const key of keyResult.keys) {
          if (ctx.exhausted) break;
          let raw;
          try {
            raw = value[key];
          } catch {
            raw = undefined;
          }
          entries.push({ key, value: this.serializeValue(raw, ctx, depth + 1) });
        }

        return {
          kind: 'object',
          name: name !== 'Object' ? name : undefined,
          truncated:
            keyResult.truncated || ctx.exhausted || entries.length < keyResult.keys.length,
          entries,
        };
      } catch (err) {
        return {
          kind: 'unknown',
          type: typeof value,
          preview: this.takeString(err, ctx).value,
        };
      }
    },

    /**
     * Serialize props object to structured format
     * @param {object} props - Props object to serialize
     * @param {Record<string, Array<string|number|boolean>>} [enumValuesByKey] - Optional enum values by prop key
     */
    serializeProps(props, enumValuesByKey) {
      const ctx = this.createContext();
      const entries = [];
      const enumMap = isObject(enumValuesByKey) ? enumValuesByKey : null;

      if (!props || (typeof props !== 'object' && typeof props !== 'function')) {
        return { kind: 'props', entries: [] };
      }

      const keyResult = this.collectOwnEnumerableKeys(props, ctx);

      for (const key of keyResult.keys) {
        if (ctx.exhausted || !this.consumeNode(ctx, 64)) break;
        let raw;
        try {
          raw = props[key];
        } catch {
          raw = undefined;
        }

        const entry = {
          key,
          editable: this.isEditablePrimitive(raw),
          value: this.serializeValue(raw, ctx, 0),
        };

        // Attach enum values if available
        const enumValues = enumMap ? enumMap[key] : null;
        if (Array.isArray(enumValues) && enumValues.length > 0) {
          const boundedEnumValues = [];
          for (
            let index = 0;
            index < enumValues.length &&
            index < EnumIntrospection.MAX_ENUM_VALUES &&
            !ctx.exhausted;
            index++
          ) {
            const enumValue = enumValues[index];
            if (typeof enumValue === 'string') {
              boundedEnumValues.push(this.takeString(enumValue, ctx).value);
            } else if (
              typeof enumValue === 'boolean' ||
              (typeof enumValue === 'number' && Number.isFinite(enumValue))
            ) {
              boundedEnumValues.push(enumValue);
            }
          }
          if (boundedEnumValues.length > 0) entry.enumValues = boundedEnumValues;
        }

        entries.push(entry);
      }

      const result = { kind: 'props', entries };
      if (
        keyResult.truncated ||
        ctx.exhausted ||
        entries.length < keyResult.keys.length
      ) {
        result.truncated = true;
      }
      return result;
    },
  };

  // =============================================================================
  // Enum Introspection (Best-effort)
  // =============================================================================

  /**
   * Best-effort enum value extraction from React runtime metadata.
   *
   * React: Relies on __docgenInfo (Storybook/react-docgen output)
   */
  const EnumIntrospection = {
    MAX_ENUM_VALUES: 50,

    /**
     * Normalize a raw enum value to primitive
     */
    normalizeEnumValue(raw) {
      if (raw === null || raw === undefined) return null;

      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

      const s = safeString(raw).trim();
      if (!s) return null;

      // Strip surrounding quotes: "'primary'" -> "primary"
      const m = s.match(/^(['"])(.*)\1$/);
      const unquoted = m ? m[2] : s;

      if (unquoted === 'true') return true;
      if (unquoted === 'false') return false;

      if (/^-?(?:\d+|\d*\.\d+)$/.test(unquoted)) {
        const n = Number(unquoted);
        if (Number.isFinite(n)) return n;
      }

      return unquoted;
    },

    /**
     * Normalize array of enum values, deduplicate
     */
    normalizeEnumList(list) {
      if (!Array.isArray(list)) return [];
      const out = [];
      const seen = new Set();

      for (const item of list) {
        const v = this.normalizeEnumValue(item);
        if (v === null) continue;
        const key =
          typeof v === 'string' ? `s:${v}` : typeof v === 'number' ? `n:${v}` : `b:${v ? 1 : 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
        if (out.length >= this.MAX_ENUM_VALUES) break;
      }

      return out;
    },

    /**
     * Extract enum values from React docgen prop info
     * (e.g., from Storybook's __docgenInfo)
     */
    extractDocgenEnumValues(propInfo) {
      if (!isObject(propInfo)) return [];

      // Check type.name === 'enum' with type.value array
      const t = propInfo.type;
      if (isObject(t) && t.name === 'enum' && Array.isArray(t.value)) {
        const rawList = [];
        for (let index = 0; index < t.value.length && index < this.MAX_ENUM_VALUES; index++) {
          const item = t.value[index];
          rawList.push(isObject(item) && 'value' in item ? item.value : item);
        }
        return this.normalizeEnumList(rawList);
      }

      // Check tsType for TypeScript enums
      const ts = propInfo.tsType;
      if (isObject(ts) && ts.name === 'union' && Array.isArray(ts.elements)) {
        const rawList = [];
        for (let index = 0; index < ts.elements.length && index < this.MAX_ENUM_VALUES; index++) {
          const element = ts.elements[index];
          rawList.push(isObject(element) && 'value' in element ? element.value : element.name);
        }
        return this.normalizeEnumList(rawList);
      }

      return [];
    },

    /**
     * Get enum values map for React component
     */
    getReactEnumValues(componentFiber) {
      try {
        const type = componentFiber?.type || componentFiber?.elementType;
        if (!type) return {};

        const docgen = type.__docgenInfo;
        if (!isObject(docgen) || !isObject(docgen.props)) return {};

        const result = {};
        let inspected = 0;
        for (const key in docgen.props) {
          if (inspected >= SERIALIZE_LIMITS.maxEntries) break;
          if (!Object.prototype.hasOwnProperty.call(docgen.props, key)) continue;
          inspected += 1;
          const info = docgen.props[key];
          const values = this.extractDocgenEnumValues(info);
          if (values.length > 0) result[key] = values;
        }
        return result;
      } catch {
        return {};
      }
    },

  };

  // =============================================================================
  // Value Access Helpers
  // =============================================================================

  function getValueAtPath(root, path) {
    let current = root;

    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      if (!isObject(current) && !Array.isArray(current)) {
        return { ok: false, existed: false, value: undefined };
      }

      const has = Object.prototype.hasOwnProperty.call(current, seg);
      current = current[seg];

      if (!has && i === path.length - 1) {
        return { ok: true, existed: false, value: undefined };
      }
    }

    return { ok: true, existed: true, value: current };
  }

  // Dangerous keys that could cause prototype pollution or unexpected behavior
  const DANGEROUS_KEYS = new Set([
    '__proto__',
    'constructor',
    'prototype',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ]);

  function isDangerousKey(key) {
    return typeof key === 'string' && DANGEROUS_KEYS.has(key);
  }

  function normalizePropPath(value) {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > TRANSPORT_LIMITS.maxPropPathEntries
    ) {
      return null;
    }

    const result = [];
    let totalBytes = 0;
    for (const seg of value) {
      if (typeof seg === 'string') {
        const s = seg.trim();
        if (!s) return null;
        // Reject dangerous keys to prevent prototype pollution
        if (isDangerousKey(s)) return null;
        const bytes = utf8ByteLength(s, TRANSPORT_LIMITS.maxPropSegmentBytes);
        if (bytes > TRANSPORT_LIMITS.maxPropSegmentBytes) return null;
        totalBytes += bytes;
        if (totalBytes > TRANSPORT_LIMITS.maxPropPathBytes) return null;
        result.push(s);
      } else if (typeof seg === 'number' && Number.isInteger(seg) && seg >= 0 && seg <= 1e6) {
        result.push(seg);
      } else {
        return null;
      }
    }
    return result;
  }

  function decodeIncomingValue(raw) {
    // Bridge encodes undefined as { $we: 'undefined' }
    if (isObject(raw) && raw.$we === 'undefined') return undefined;
    return raw;
  }

  // =============================================================================
  // Capabilities Builder
  // =============================================================================

  function makeCapabilities(init) {
    return {
      canRead: Boolean(init?.canRead),
      canWrite: Boolean(init?.canWrite),
      canWriteHooks: Boolean(init?.canWriteHooks),
    };
  }

  function buildResponseData(init) {
    const data = {};
    if (init?.hookStatus) data.hookStatus = init.hookStatus;
    if (typeof init?.needsRefresh === 'boolean') data.needsRefresh = init.needsRefresh;
    if (init?.framework) data.framework = init.framework;
    if (init?.frameworkVersion) {
      data.frameworkVersion = truncateUtf8(init.frameworkVersion, 512);
    }
    if (init?.componentName) data.componentName = truncateUtf8(init.componentName, 512);
    if (isObject(init?.debugSource)) {
      const file = truncateUtf8(init.debugSource.file, 4 * 1024);
      if (file) {
        data.debugSource = {
          file,
          line:
            Number.isSafeInteger(init.debugSource.line) && init.debugSource.line > 0
              ? init.debugSource.line
              : undefined,
          column:
            Number.isSafeInteger(init.debugSource.column) && init.debugSource.column > 0
              ? init.debugSource.column
              : undefined,
          componentName: init.debugSource.componentName
            ? truncateUtf8(init.debugSource.componentName, 512)
            : undefined,
        };
      }
    }
    if (init?.props) data.props = init.props;
    if (init?.capabilities) data.capabilities = init.capabilities;
    if (init?.meta) data.meta = init.meta;
    return data;
  }

  // =============================================================================
  // Request Handlers
  // =============================================================================

  const Handlers = {
    resolveTarget(locator) {
      if (!locator) return null;
      const el = Locator.locate(locator, document);
      // Return element if connected to DOM; otherwise return null
      return el?.isConnected ? el : null;
    },

    /**
     * Handle 'probe' operation - Detect capabilities without reading props
     */
    handleProbe(req) {
      // Check initial hook status
      const preStatus = ReactAdapter.detectStatus();
      const initialHookStatus = preStatus.hookStatus;

      // Try to install hook if missing (only helps if React hasn't initialized)
      if (initialHookStatus === HOOK_STATUS.HOOK_MISSING) {
        ReactAdapter.installMinimalHook();
      }

      const hookInfo = ReactAdapter.detectStatus();
      // Report original status if hook was missing (so UI knows refresh is needed)
      const hookStatus =
        initialHookStatus === HOOK_STATUS.HOOK_MISSING
          ? HOOK_STATUS.HOOK_MISSING
          : hookInfo.hookStatus;

      const target = this.resolveTarget(req.locator);
      const fw = target ? FrameworkDetector.detect(target) : { framework: 'unknown', data: null };

      let componentName;
      let debugSource;
      let canRead = false;
      let canWrite = false;
      let needsRefresh = false;

      let frameworkVersion;

      if (fw.framework === 'react') {
        const fiberInfo = ReactAdapter.resolveFiberWithRenderer(target, hookInfo);
        const componentFiber = fiberInfo.fiber
          ? ReactAdapter.findNearestComponentFiber(fiberInfo.fiber)
          : null;

        componentName = componentFiber ? ReactAdapter.getComponentName(componentFiber) : undefined;
        // Extract debug source from component fiber or raw fiber
        const sourceFiber = componentFiber || fiberInfo.fiber;
        debugSource = sourceFiber ? ReactAdapter.getDebugSource(sourceFiber) : undefined;
        // Pass specific renderer to prioritize its version in multi-renderer scenarios
        frameworkVersion = ReactAdapter.getVersion(hookInfo, fiberInfo.renderer);
        canRead = Boolean(componentFiber);
        canWrite = hookStatus === HOOK_STATUS.READY && Boolean(componentFiber);
        needsRefresh = canRead && hookStatus !== HOOK_STATUS.READY;
      }

      const data = buildResponseData({
        hookStatus,
        framework: fw.framework,
        frameworkVersion,
        componentName,
        debugSource,
        capabilities: makeCapabilities({ canRead, canWrite, canWriteHooks: false }),
        needsRefresh,
      });

      return Transport.createResponse(req.requestId, true, data);
    },

    /**
     * Handle 'read' operation - Read component props
     */
    handleRead(req) {
      const target = this.resolveTarget(req.locator);
      if (!target) {
        return Transport.createResponse(
          req.requestId,
          false,
          undefined,
          'Target element not found',
        );
      }

      const preStatus = ReactAdapter.detectStatus();
      if (preStatus.hookStatus === HOOK_STATUS.HOOK_MISSING) {
        ReactAdapter.installMinimalHook();
      }

      const hookInfo = ReactAdapter.detectStatus();
      const hookStatus =
        preStatus.hookStatus === HOOK_STATUS.HOOK_MISSING
          ? HOOK_STATUS.HOOK_MISSING
          : hookInfo.hookStatus;

      const fw = FrameworkDetector.detect(target);

      if (fw.framework === 'react') {
        const fiberInfo = ReactAdapter.resolveFiberWithRenderer(target, hookInfo);
        const componentFiber = fiberInfo.fiber
          ? ReactAdapter.findNearestComponentFiber(fiberInfo.fiber)
          : null;

        // Extract debug source even if component fiber not found
        const sourceFiber = componentFiber || fiberInfo.fiber;
        const debugSource = sourceFiber ? ReactAdapter.getDebugSource(sourceFiber) : undefined;
        // Pass specific renderer to prioritize its version in multi-renderer scenarios
        const frameworkVersion = ReactAdapter.getVersion(hookInfo, fiberInfo.renderer);

        if (!componentFiber) {
          const data = buildResponseData({
            hookStatus,
            framework: 'react',
            frameworkVersion,
            debugSource,
            capabilities: makeCapabilities({ canRead: false, canWrite: false }),
            needsRefresh: false,
          });
          return Transport.createResponse(
            req.requestId,
            false,
            data,
            'React component fiber not found',
          );
        }

        const props = componentFiber.memoizedProps;
        const enumValuesByKey = EnumIntrospection.getReactEnumValues(componentFiber);
        const serialized = Serializer.serializeProps(props, enumValuesByKey);
        const componentName = ReactAdapter.getComponentName(componentFiber);
        const canWrite = hookStatus === HOOK_STATUS.READY;
        const needsRefresh = hookStatus !== HOOK_STATUS.READY;

        const data = buildResponseData({
          hookStatus,
          framework: 'react',
          frameworkVersion,
          componentName,
          debugSource,
          props: serialized,
          capabilities: makeCapabilities({ canRead: true, canWrite, canWriteHooks: false }),
          needsRefresh,
        });

        return Transport.createResponse(req.requestId, true, data);
      }

      // Unknown framework
      const data = buildResponseData({
        hookStatus,
        framework: 'unknown',
        capabilities: makeCapabilities({ canRead: false, canWrite: false }),
        needsRefresh: false,
      });

      return Transport.createResponse(req.requestId, false, data, 'Not a React component');
    },

    /**
     * Handle 'write' operation - Modify component props
     */
    handleWrite(req) {
      const target = this.resolveTarget(req.locator);
      if (!target) {
        return Transport.createResponse(
          req.requestId,
          false,
          undefined,
          'Target element not found',
        );
      }

      const path = normalizePropPath(req.payload?.propPath);
      if (!path) {
        return Transport.createResponse(req.requestId, false, undefined, 'Invalid propPath');
      }

      const rawValue = req.payload?.propValue;
      const value = decodeIncomingValue(rawValue);
      if (!Serializer.isEditablePrimitive(value)) {
        return Transport.createResponse(
          req.requestId,
          false,
          undefined,
          'Only primitive prop values are supported',
        );
      }

      const preStatus = ReactAdapter.detectStatus();
      if (preStatus.hookStatus === HOOK_STATUS.HOOK_MISSING) {
        ReactAdapter.installMinimalHook();
      }

      const hookInfo = ReactAdapter.detectStatus();
      const hookStatus =
        preStatus.hookStatus === HOOK_STATUS.HOOK_MISSING
          ? HOOK_STATUS.HOOK_MISSING
          : hookInfo.hookStatus;

      const fw = FrameworkDetector.detect(target);

      if (fw.framework === 'react') {
        const fiberInfo = ReactAdapter.resolveFiberWithRenderer(target, hookInfo);
        const componentFiber = fiberInfo.fiber
          ? ReactAdapter.findNearestComponentFiber(fiberInfo.fiber)
          : null;

        const componentName = componentFiber
          ? ReactAdapter.getComponentName(componentFiber)
          : undefined;
        const canRead = Boolean(componentFiber);
        const canWrite = hookStatus === HOOK_STATUS.READY && Boolean(componentFiber);
        const needsRefresh = canRead && hookStatus !== HOOK_STATUS.READY;

        const base = buildResponseData({
          hookStatus,
          framework: 'react',
          componentName,
          capabilities: makeCapabilities({ canRead, canWrite, canWriteHooks: false }),
          needsRefresh,
        });

        if (!componentFiber) {
          return Transport.createResponse(
            req.requestId,
            false,
            base,
            'React component fiber not found',
          );
        }

        if (hookStatus !== HOOK_STATUS.READY) {
          return Transport.createResponse(
            req.requestId,
            false,
            base,
            'React DevTools editing API unavailable. Use a Development build and refresh the page.',
          );
        }

        // Check current value for editability and record original
        const props = componentFiber.memoizedProps;
        const read = getValueAtPath(props, path);
        if (read.ok && read.existed && !Serializer.isEditablePrimitive(read.value)) {
          return Transport.createResponse(
            req.requestId,
            false,
            base,
            'Target prop is not a primitive (read-only)',
          );
        }

        // Try renderers with overrideProps
        const candidates = (hookInfo.editableRenderers || [])
          .map((r) => r.renderer)
          .filter(Boolean);
        const preferred =
          fiberInfo.renderer && typeof fiberInfo.renderer.overrideProps === 'function'
            ? fiberInfo.renderer
            : null;
        const ordered = preferred
          ? [preferred, ...candidates.filter((r) => r !== preferred)]
          : candidates;

        let usedRenderer = null;
        let lastErr = null;

        for (const renderer of ordered) {
          try {
            renderer.overrideProps(componentFiber, path, value);
            usedRenderer = renderer;
            break;
          } catch (err) {
            lastErr = err;
          }
        }

        if (!usedRenderer) {
          base.meta = {
            write: {
              method: 'overrideProps',
              error: truncateUtf8(lastErr, TRANSPORT_LIMITS.maxErrorBytes),
            },
          };
          return Transport.createResponse(
            req.requestId,
            false,
            base,
            'Failed to write props via overrideProps',
          );
        }

        ReactAdapter.recordOriginal(componentFiber, usedRenderer, path, read.existed, read.value);
        base.meta = { write: { method: 'overrideProps' } };

        return Transport.createResponse(req.requestId, true, base);
      }

      return Transport.createResponse(req.requestId, false, undefined, 'Not a React component');
    },

    /**
     * Handle 'reset' operation - Restore original props values
     */
    handleReset(req) {
      const target = this.resolveTarget(req.locator);
      if (!target) {
        return Transport.createResponse(
          req.requestId,
          false,
          undefined,
          'Target element not found',
        );
      }

      const preStatus = ReactAdapter.detectStatus();
      if (preStatus.hookStatus === HOOK_STATUS.HOOK_MISSING) {
        ReactAdapter.installMinimalHook();
      }

      const hookInfo = ReactAdapter.detectStatus();
      const hookStatus =
        preStatus.hookStatus === HOOK_STATUS.HOOK_MISSING
          ? HOOK_STATUS.HOOK_MISSING
          : hookInfo.hookStatus;

      const fw = FrameworkDetector.detect(target);

      if (fw.framework === 'react') {
        const fiberInfo = ReactAdapter.resolveFiberWithRenderer(target, hookInfo);
        const componentFiber = fiberInfo.fiber
          ? ReactAdapter.findNearestComponentFiber(fiberInfo.fiber)
          : null;

        const componentName = componentFiber
          ? ReactAdapter.getComponentName(componentFiber)
          : undefined;
        const canRead = Boolean(componentFiber);
        const canWrite = hookStatus === HOOK_STATUS.READY && Boolean(componentFiber);
        const needsRefresh = canRead && hookStatus !== HOOK_STATUS.READY;

        const base = buildResponseData({
          hookStatus,
          framework: 'react',
          componentName,
          capabilities: makeCapabilities({ canRead, canWrite, canWriteHooks: false }),
          needsRefresh,
        });

        if (!componentFiber) {
          return Transport.createResponse(
            req.requestId,
            false,
            base,
            'React component fiber not found',
          );
        }

        const store = ReactAdapter.getOriginals(componentFiber);
        if (!store?.originals?.size) {
          base.meta = { reset: { method: 'refresh', reason: 'noOverrides' } };
          base.needsRefresh = true;
          return Transport.createResponse(req.requestId, true, base);
        }

        if (hookStatus !== HOOK_STATUS.READY) {
          base.meta = { reset: { method: 'refresh', reason: 'hookNotReady' } };
          base.needsRefresh = true;
          return Transport.createResponse(req.requestId, true, base);
        }

        const renderer = store.renderer;
        if (!renderer || typeof renderer.overrideProps !== 'function') {
          base.meta = { reset: { method: 'refresh', reason: 'missingRenderer' } };
          base.needsRefresh = true;
          return Transport.createResponse(req.requestId, true, base);
        }

        let reverted = 0;
        for (const entry of store.originals.values()) {
          try {
            renderer.overrideProps(componentFiber, entry.path, entry.value);
            reverted++;
          } catch {
            // Continue reverting others
          }
        }

        ReactAdapter.clearOriginals(componentFiber);
        base.meta = { reset: { method: 'overrideProps', reverted } };

        return Transport.createResponse(req.requestId, true, base);
      }

      return Transport.createResponse(req.requestId, false, undefined, 'Not a React component');
    },

    /**
     * Handle 'cleanup' operation - Dispose agent
     */
    handleCleanup(req) {
      const resp = Transport.createResponse(req.requestId, true, {
        meta: { cleanup: { ok: true } },
      });
      Lifecycle.dispose('request');
      return resp;
    },

    /**
     * Route request to appropriate handler
     */
    handle(req) {
      switch (req.op) {
        case 'probe':
          return this.handleProbe(req);
        case 'read':
          return this.handleRead(req);
        case 'write':
          return this.handleWrite(req);
        case 'reset':
          return this.handleReset(req);
        case 'cleanup':
          return this.handleCleanup(req);
        default:
          return Transport.createResponse(
            req.requestId,
            false,
            undefined,
            `Unsupported op: ${safeString(req.op)}`,
          );
      }
    },
  };

  // =============================================================================
  // Lifecycle Management
  // =============================================================================

  const Lifecycle = {
    disposed: false,

    onRequestEvent(event) {
      try {
        if (Lifecycle.disposed) return;

        const detail = event?.detail;
        const req = Transport.normalizeRequest(detail);
        if (!req) return;

        const resp = Handlers.handle(req);
        Transport.dispatchResponse(resp);
      } catch (err) {
        try {
          const requestId = event?.detail?.requestId;
          if (typeof requestId === 'string' && requestId) {
            Transport.dispatchResponse(
              Transport.createResponse(requestId, false, undefined, safeString(err)),
            );
          }
        } catch {
          // ignore
        }
      }
    },

    onCleanupEvent() {
      Lifecycle.dispose('external-event');
    },

    dispose(reason) {
      if (this.disposed) return;
      this.disposed = true;

      try {
        window.removeEventListener(EVENT_NAME.REQUEST, this.onRequestEvent, true);
        window.removeEventListener(EVENT_NAME.CLEANUP, this.onCleanupEvent, true);
      } catch {
        // ignore
      }

      try {
        delete window[GLOBAL_KEY];
      } catch {
        // ignore
      }

      if (reason) {
        logWarn('Disposed:', reason);
      }
    },

    init() {
      // Use capture phase to avoid page stopPropagation interfering
      window.addEventListener(EVENT_NAME.REQUEST, this.onRequestEvent, true);
      window.addEventListener(EVENT_NAME.CLEANUP, this.onCleanupEvent, true);

      window[GLOBAL_KEY] = {
        version: PROTOCOL_VERSION,
        dispose: () => this.dispose('manual'),
      };

      // Early injection: install minimal hook before React loads (document_start)
      // This is critical for capturing React renderers that initialize early
      if (document.readyState === 'loading') {
        try {
          const status = ReactAdapter.detectStatus();
          if (status.hookStatus === HOOK_STATUS.HOOK_MISSING) {
            ReactAdapter.installMinimalHook();
            logWarn('Installed minimal hook during early injection');
          }
        } catch (err) {
          // Best-effort: early injection may fail in some environments
          logWarn('Early hook injection failed:', err);
        }
      }
    },
  };

  // Initialize
  Lifecycle.init();
})();
