/**
 * DOM Path - DOM Path calculation and positioning
 *
 * DOM The path is the index path of the element in the DOM tree and is used for:
 * - Element position tracking
 * - Quick recovery after selector failure
 * - Element comparison and validation
 */

// =============================================================================
// Types
// =============================================================================

/**
 * DOM Path: array of child element indices from the root to the target element
 *
 * @example
 * ```
 * [0, 2, 1] means:
 * root
 *  └─ children[0]
 *      └─ children[2]
 *          └─ children[1]  <- target element
 * ```
 */
export type DomPath = number[];

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Calculate the path of an element in the DOM tree
 *
 * Traverse upward from the target element to the root node (Document or ShadowRoot),
 * Record the index of each layer in the parent element children.
 *
 * @example
 * ```ts
 * const path = computeDomPath(button);
 * // => [0, 2, 1] - Path starting from body/shadowRoot
 * ```
 */
export function computeDomPath(element: Element): DomPath {
  const path: DomPath = [];
  let current: Element | null = element;

  while (current) {
    const parent: Element | null = current.parentElement;

    if (parent) {
      // normal parent element
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(current);
      if (index >= 0) {
        path.unshift(index);
      }
      current = parent;
      continue;
    }

    // Checks if it is a direct child of ShadowRoot or Document
    const parentNode = current.parentNode;
    if (parentNode instanceof ShadowRoot || parentNode instanceof Document) {
      const children = Array.from(parentNode.children);
      const index = children.indexOf(current);
      if (index >= 0) {
        path.unshift(index);
      }
    }

    // Reach the root node and stop traversing
    break;
  }

  return path;
}

/**
 * Locate elements based on DOM path
 *
 * @param root - Query the root node (Document or ShadowRoot)
 * @param path - DOM path
 * @returns The element found, or null if the path is invalid
 *
 * @example
 * ```ts
 * const element = locateByDomPath(document, [0, 2, 1]);
 * // => return body > children[0] > children[2] > children[1]
 * ```
 */
export function locateByDomPath(root: Document | ShadowRoot, path: DomPath): Element | null {
  if (path.length === 0) {
    return null;
  }

  let current: Element | null = root.children[path[0]] ?? null;

  for (let i = 1; i < path.length && current; i++) {
    const index = path[i];
    current = current.children[index] ?? null;
  }

  return current;
}

/**
 * Compare two DOM paths
 *
 * @returns Contains results for equality and common prefix length
 *
 * @example
 * ```ts
 * const result = compareDomPaths([0, 2, 1], [0, 2, 3]);
 * // => { same: false, commonPrefixLength: 2 }
 * ```
 */
export function compareDomPaths(
  a: DomPath,
  b: DomPath,
): { same: boolean; commonPrefixLength: number } {
  const minLen = Math.min(a.length, b.length);
  let commonPrefixLength = 0;

  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) {
      commonPrefixLength++;
    } else {
      break;
    }
  }

  const same = a.length === b.length && commonPrefixLength === a.length;

  return { same, commonPrefixLength };
}

/**
 * Check if path A is an ancestor of path B
 *
 * @example
 * ```ts
 * isAncestorPath([0, 2], [0, 2, 1]); // true
 * isAncestorPath([0, 2, 1], [0, 2]); // false
 * ```
 */
export function isAncestorPath(ancestor: DomPath, descendant: DomPath): boolean {
  if (ancestor.length >= descendant.length) {
    return false;
  }

  for (let i = 0; i < ancestor.length; i++) {
    if (ancestor[i] !== descendant[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Get relative path from ancestor path to descendant path
 *
 * @example
 * ```ts
 * getRelativePath([0, 2], [0, 2, 1, 3]); // [1, 3]
 * ```
 */
export function getRelativePath(ancestor: DomPath, descendant: DomPath): DomPath | null {
  if (!isAncestorPath(ancestor, descendant)) {
    return null;
  }

  return descendant.slice(ancestor.length);
}
