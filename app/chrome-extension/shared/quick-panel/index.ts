/**
 * Quick Panel Entry Point
 *
 * This module provides the main controller for Quick Panel functionality.
 * It orchestrates:
 * - Shadow DOM host management
 * - AI Chat panel lifecycle
 * - Agent bridge communication
 * - Keyboard shortcut handling (external)
 *
 * Usage in content script:
 * ```typescript
 * import { createQuickPanelController } from './quick-panel';
 *
 * const controller = createQuickPanelController();
 *
 * // Show panel (e.g., on keyboard shortcut)
 * controller.show();
 *
 * // Hide panel
 * controller.hide();
 *
 * // Toggle visibility
 * controller.toggle();
 *
 * // Cleanup on unload
 * controller.dispose();
 * ```
 */

import { createAgentBridge, type QuickPanelAgentBridge } from './core/agent-bridge';
import {
  mountQuickPanelShadowHost,
  mountQuickPanelAiChatPanel,
  type QuickPanelShadowHostManager,
  type QuickPanelAiChatPanelManager,
} from './ui';

// ============================================================
// Types
// ============================================================

export interface QuickPanelControllerOptions {
  /** Custom host element ID for Shadow DOM. Default: '__mcp_quick_panel_host__' */
  hostId?: string;
  /** Custom z-index for overlay. Default: 2147483647 (highest possible) */
  zIndex?: number;
  /** Panel title. Default: 'Agent' */
  title?: string;
  /** Panel subtitle. Default: 'Quick Panel' */
  subtitle?: string;
  /** Input placeholder. Default: 'Ask the agent...' */
  placeholder?: string;
}

export interface QuickPanelController {
  /** Show the Quick Panel (creates if not exists) */
  show: () => void;
  /** Hide the Quick Panel (disposes UI but keeps bridge alive) */
  hide: () => void;
  /** Toggle Quick Panel visibility */
  toggle: () => void;
  /** Check if panel is currently visible */
  isVisible: () => boolean;
  /** Fully dispose all resources */
  dispose: () => void;
}

// ============================================================
// Constants
// ============================================================

const LOG_PREFIX = '[QuickPanelController]';

// ============================================================
// Main Factory
// ============================================================

/**
 * Create a Quick Panel controller instance.
 *
 * The controller manages the full lifecycle of the Quick Panel UI,
 * including Shadow DOM isolation, AI chat interface, and background
 * communication.
 *
 * @example
 * ```typescript
 * // In content script
 * const quickPanel = createQuickPanelController();
 *
 * // Listen for keyboard shortcut (e.g., Cmd+Shift+K)
 * document.addEventListener('keydown', (e) => {
 *   if (e.metaKey && e.shiftKey && e.key === 'k') {
 *     e.preventDefault();
 *     quickPanel.toggle();
 *   }
 * });
 *
 * // Cleanup on extension unload
 * window.addEventListener('unload', () => {
 *   quickPanel.dispose();
 * });
 * ```
 */
export function createQuickPanelController(
  options: QuickPanelControllerOptions = {},
): QuickPanelController {
  let disposed = false;

  // Shared agent bridge (persists across show/hide cycles)
  let agentBridge: QuickPanelAgentBridge | null = null;

  // UI components (created on show, disposed on hide)
  let shadowHost: QuickPanelShadowHostManager | null = null;
  let chatPanel: QuickPanelAiChatPanelManager | null = null;

  /**
   * Ensure agent bridge is initialized
   */
  function ensureBridge(): QuickPanelAgentBridge {
    if (!agentBridge || agentBridge.isDisposed()) {
      agentBridge = createAgentBridge();
    }
    return agentBridge;
  }

  /**
   * Dispose current UI (keeps bridge alive for potential reuse)
   */
  function disposeUI(): void {
    if (chatPanel) {
      try {
        chatPanel.dispose();
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error disposing chat panel:`, err);
      }
      chatPanel = null;
    }

    if (shadowHost) {
      try {
        shadowHost.dispose();
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error disposing shadow host:`, err);
      }
      shadowHost = null;
    }
  }

  /**
   * Show the Quick Panel
   */
  function show(): void {
    if (disposed) {
      console.warn(`${LOG_PREFIX} Cannot show - controller is disposed`);
      return;
    }

    // Already visible
    if (chatPanel && shadowHost?.getElements()) {
      chatPanel.focusInput();
      return;
    }

    // Clean up any stale UI
    disposeUI();

    // Create shadow host
    shadowHost = mountQuickPanelShadowHost({
      hostId: options.hostId,
      zIndex: options.zIndex,
    });

    const elements = shadowHost.getElements();
    if (!elements) {
      console.error(`${LOG_PREFIX} Failed to create shadow host elements`);
      disposeUI();
      return;
    }

    // Ensure bridge is ready
    const bridge = ensureBridge();

    // Create chat panel
    chatPanel = mountQuickPanelAiChatPanel({
      mount: elements.root,
      agentBridge: bridge,
      title: options.title,
      subtitle: options.subtitle,
      placeholder: options.placeholder,
      autoFocus: true,
      onRequestClose: () => hide(),
    });
  }

  /**
   * Hide the Quick Panel
   */
  function hide(): void {
    if (disposed) return;
    disposeUI();
  }

  /**
   * Toggle Quick Panel visibility
   */
  function toggle(): void {
    if (disposed) return;

    if (isVisible()) {
      hide();
    } else {
      show();
    }
  }

  /**
   * Check if panel is currently visible
   */
  function isVisible(): boolean {
    return chatPanel !== null && shadowHost?.getElements() !== null;
  }

  /**
   * Fully dispose all resources
   */
  function dispose(): void {
    if (disposed) return;
    disposed = true;

    disposeUI();

    if (agentBridge) {
      try {
        agentBridge.dispose();
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error disposing agent bridge:`, err);
      }
      agentBridge = null;
    }
  }

  return {
    show,
    hide,
    toggle,
    isVisible,
    dispose,
  };
}

// ============================================================
// Re-exports for convenience
// ============================================================

// Core types
export {
  DEFAULT_SCOPE,
  QUICK_PANEL_SCOPES,
  normalizeQuickPanelScope,
  parseScopePrefixedQuery,
  normalizeSearchQuery,
} from './core/types';

export type {
  QuickPanelScope,
  QuickPanelScopeDefinition,
  QuickPanelView,
  ParsedScopeQuery,
  QuickPanelIcon,
  SearchResult,
  ActionTone,
  ActionContext,
  Action,
  SearchQuery,
  SearchProviderContext,
  SearchProvider,
  QuickPanelState,
} from './core/types';

// Agent bridge
export { createAgentBridge } from './core/agent-bridge';
export type {
  QuickPanelAgentBridge,
  RequestEventListener,
  AgentBridgeOptions,
} from './core/agent-bridge';

// UI Components
export {
  // Shadow host
  mountQuickPanelShadowHost,
  // Panel shell (unified container)
  mountQuickPanelShell,
  // AI Chat
  mountQuickPanelAiChatPanel,
  createQuickPanelMessageRenderer,
  // Search UI
  createSearchInput,
  createQuickEntries,
  // Styles
  QUICK_PANEL_STYLES,
} from './ui';

export type {
  // Shadow host
  QuickPanelShadowHostElements,
  QuickPanelShadowHostManager,
  QuickPanelShadowHostOptions,
  // Panel shell
  QuickPanelShellElements,
  QuickPanelShellManager,
  QuickPanelShellOptions,
  // AI Chat
  QuickPanelAiChatPanelManager,
  QuickPanelAiChatPanelOptions,
  QuickPanelAiChatPanelState,
  QuickPanelMessageRenderer,
  QuickPanelMessageRendererOptions,
  // Search input
  SearchInputManager,
  SearchInputOptions,
  SearchInputState,
  // Quick entries
  QuickEntriesManager,
  QuickEntriesOptions,
} from './ui';

// Search Engine
export { SearchEngine } from './core/search-engine';
export type {
  SearchEngineOptions,
  SearchEngineRequest,
  SearchEngineResponse,
  SearchProviderError,
} from './core/search-engine';

// Search Providers
export { createTabsProvider } from './providers';
export type { TabsProviderOptions, TabsSearchResultData } from './providers';
