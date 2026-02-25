/**
 * Property Panel Types
 *
 * Type definitions for the property panel component.
 * The panel displays Design controls and DOM tree for the selected element.
 */

import type { TransactionManager } from '../../core/transaction-manager';
import type { PropsBridge } from '../../core/props-bridge';
import type { DesignTokensService } from '../../core/design-tokens';
import type { FloatingPosition } from '../floating-drag';

// =============================================================================
// Tab Types
// =============================================================================

/** Property panel tab identifiers */
export type PropertyPanelTab = 'design' | 'css' | 'props' | 'dom';

// =============================================================================
// Options Types
// =============================================================================

/** Options for creating the property panel */
export interface PropertyPanelOptions {
  /** Shadow UI container element (elements.uiRoot from shadow-host) */
  container: HTMLElement;

  /** Transaction manager for applying style changes with undo/redo support */
  transactionManager: TransactionManager;

  /** Bridge to the MAIN-world props agent (Phase 7) */
  propsBridge: PropsBridge;

  /**
   * Callback when user selects an element from the Components tree (DOM tab).
   * Used to update the editor's selection state.
   */
  onSelectElement: (element: Element) => void;

  /**
   * Optional callback to close the editor.
   * If provided, a close button will be shown in the header.
   */
  onRequestClose?: () => void;

  /**
   * Initial floating position (viewport coordinates).
   * When provided, the panel uses left/top positioning and becomes draggable.
   */
  initialPosition?: FloatingPosition | null;

  /**
   * Called whenever the floating position changes.
   * Use null to indicate the panel is in its default anchored position.
   */
  onPositionChange?: (position: FloatingPosition | null) => void;

  /** Initial tab to display (default: 'design') */
  defaultTab?: PropertyPanelTab;

  /** Optional: Design tokens service for TokenPill/TokenPicker integration (Phase 5.3) */
  tokensService?: DesignTokensService;
}

// =============================================================================
// Panel Interface
// =============================================================================

/** Property panel public interface */
export interface PropertyPanel {
  /**
   * Update the panel to display properties for the given element.
   * Pass null to show empty state.
   */
  setTarget(element: Element | null): void;

  /** Switch to a specific tab */
  setTab(tab: PropertyPanelTab): void;

  /** Get the currently active tab */
  getTab(): PropertyPanelTab;

  /** Force refresh the current controls (e.g., after external style change) */
  refresh(): void;

  /** Get current floating position (viewport coordinates), null when anchored */
  getPosition(): FloatingPosition | null;

  /** Set floating position (viewport coordinates), pass null to reset to anchored */
  setPosition(position: FloatingPosition | null): void;

  /** Cleanup and remove the panel */
  dispose(): void;
}

// =============================================================================
// Control Types
// =============================================================================

/** Common interface for design controls (Size, Spacing, Position, etc.) */
export interface DesignControl {
  /** Update the control to display values for the given element */
  setTarget(element: Element | null): void;

  /** Refresh control values from current element styles */
  refresh(): void;

  /** Cleanup the control */
  dispose(): void;
}

/** Factory function type for creating design controls */
export type DesignControlFactory = (options: {
  container: HTMLElement;
  transactionManager: TransactionManager;
}) => DesignControl;

// =============================================================================
// Group Types
// =============================================================================

/** State for a collapsible control group */
export interface ControlGroupState {
  /** Whether the group is collapsed */
  collapsed: boolean;
}

/** Collapsible control group interface */
export interface ControlGroup {
  /** The root element of the group */
  root: HTMLElement;

  /** The body container where controls are mounted */
  body: HTMLElement;

  /** Optional: Container for header action buttons (e.g., add button) */
  headerActions?: HTMLElement;

  /** Set collapsed state */
  setCollapsed(collapsed: boolean): void;

  /** Get current collapsed state */
  isCollapsed(): boolean;

  /** Toggle collapsed state */
  toggle(): void;
}
