/**
 * Components Tree (Phase 3.2)
 *
 * Displays DOM hierarchy for the selected element.
 * Shows:
 * - Ancestor path from document.body to selected element
 * - Direct children of selected element
 * - Highlights selected element in tree
 * - Click to select any visible element
 *
 * MVP Design:
 * - Simple tree structure
 * - No virtual scrolling (limit to reasonable depth)
 * - Compact display with tag#id.class format
 */

import { Disposer } from '../../utils/disposables';

// =============================================================================
// Types
// =============================================================================

export interface ComponentsTreeOptions {
  container: HTMLElement;
  onSelect?: (element: Element) => void;
}

export interface ComponentsTree {
  setTarget(element: Element | null): void;
  refresh(): void;
  dispose(): void;
}

interface TreeNode {
  element: Element;
  label: string;
  depth: number;
  isSelected: boolean;
  isAncestor: boolean;
  isChild: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const MAX_ANCESTORS = 10;
const MAX_CHILDREN = 20;
const MAX_CLASSES = 2;
const MAX_TEXT_LENGTH = 20;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Format element for display: tag#id.class1.class2
 */
function formatElementLabel(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const htmlEl = element as HTMLElement;

  let label = tag;

  // Add ID if present
  const id = htmlEl.id?.trim();
  if (id) {
    label += `#${id}`;
  }

  // Add first few classes
  const classes = Array.from(element.classList ?? [])
    .slice(0, MAX_CLASSES)
    .filter(Boolean);
  if (classes.length > 0) {
    label += `.${classes.join('.')}`;
  }

  // Add text hint for elements with short text content
  if (!element.children.length) {
    const text = element.textContent?.trim() ?? '';
    if (text.length > 0 && text.length <= MAX_TEXT_LENGTH) {
      label += ` "${text}"`;
    } else if (text.length > MAX_TEXT_LENGTH) {
      label += ` "${text.slice(0, MAX_TEXT_LENGTH - 3)}..."`;
    }
  }

  return label;
}

/**
 * Get ancestor chain from body to element
 */
function getAncestorChain(element: Element): Element[] {
  const ancestors: Element[] = [];
  let current: Element | null = element.parentElement;

  while (current && ancestors.length < MAX_ANCESTORS) {
    // Stop at body or html
    if (current === document.body || current === document.documentElement) {
      ancestors.unshift(current);
      break;
    }

    // Skip shadow hosts for now (MVP)
    if (current.shadowRoot) {
      break;
    }

    ancestors.unshift(current);
    current = current.parentElement;
  }

  return ancestors;
}

/**
 * Get direct children
 */
function getDirectChildren(element: Element): Element[] {
  return Array.from(element.children).slice(0, MAX_CHILDREN);
}

/**
 * Build tree nodes for display
 */
function buildTreeNodes(target: Element | null): TreeNode[] {
  if (!target || !target.isConnected) {
    return [];
  }

  const nodes: TreeNode[] = [];
  const ancestors = getAncestorChain(target);

  // Add ancestors
  for (let i = 0; i < ancestors.length; i++) {
    nodes.push({
      element: ancestors[i],
      label: formatElementLabel(ancestors[i]),
      depth: i,
      isSelected: false,
      isAncestor: true,
      isChild: false,
    });
  }

  // Add selected element
  const selectedDepth = ancestors.length;
  nodes.push({
    element: target,
    label: formatElementLabel(target),
    depth: selectedDepth,
    isSelected: true,
    isAncestor: false,
    isChild: false,
  });

  // Add children
  const children = getDirectChildren(target);
  for (const child of children) {
    nodes.push({
      element: child,
      label: formatElementLabel(child),
      depth: selectedDepth + 1,
      isSelected: false,
      isAncestor: false,
      isChild: true,
    });
  }

  return nodes;
}

// =============================================================================
// Factory
// =============================================================================

export function createComponentsTree(options: ComponentsTreeOptions): ComponentsTree {
  const { container, onSelect } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;

  // Root container
  const root = document.createElement('div');
  root.className = 'we-tree';

  // Empty state
  const emptyState = document.createElement('div');
  emptyState.className = 'we-tree-empty';
  emptyState.textContent = 'Select an element to view its DOM hierarchy.';

  // Tree list
  const treeList = document.createElement('div');
  treeList.className = 'we-tree-list';
  treeList.setAttribute('role', 'tree');

  root.append(emptyState, treeList);
  container.append(root);
  disposer.add(() => root.remove());

  // ==========================================================================
  // Render
  // ==========================================================================

  function render(): void {
    const nodes = buildTreeNodes(currentTarget);

    // Update visibility
    const hasTarget = nodes.length > 0;
    emptyState.hidden = hasTarget;
    treeList.hidden = !hasTarget;

    if (!hasTarget) {
      treeList.innerHTML = '';
      return;
    }

    // Build tree items
    treeList.innerHTML = '';

    for (const node of nodes) {
      const item = document.createElement('div');
      item.className = 'we-tree-item';
      item.setAttribute('role', 'treeitem');
      item.style.paddingLeft = `${8 + node.depth * 16}px`;

      if (node.isSelected) {
        item.classList.add('we-tree-item--selected');
        item.setAttribute('aria-selected', 'true');
      }

      if (node.isAncestor) {
        item.classList.add('we-tree-item--ancestor');
      }

      if (node.isChild) {
        item.classList.add('we-tree-item--child');
      }

      // Indent marker
      if (node.depth > 0) {
        const indent = document.createElement('span');
        indent.className = 'we-tree-indent';
        indent.textContent = node.isChild ? '└' : '├';
        item.append(indent);
      }

      // Tag icon
      const icon = document.createElement('span');
      icon.className = 'we-tree-icon';
      icon.textContent = '◇';
      item.append(icon);

      // Label
      const label = document.createElement('span');
      label.className = 'we-tree-label';
      label.textContent = node.label;
      item.append(label);

      // Click handler
      disposer.listen(item, 'click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (node.element.isConnected && onSelect) {
          onSelect(node.element);
        }
      });

      // Hover effect - highlight element
      disposer.listen(item, 'mouseenter', () => {
        if (node.element.isConnected) {
          node.element.classList.add('we-tree-hover-highlight');
        }
      });

      disposer.listen(item, 'mouseleave', () => {
        node.element.classList.remove('we-tree-hover-highlight');
      });

      treeList.append(item);
    }
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;
    currentTarget = element;
    render();
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    render();
  }

  function dispose(): void {
    currentTarget = null;
    disposer.dispose();
  }

  // Initial render
  render();

  return {
    setTarget,
    refresh,
    dispose,
  };
}
