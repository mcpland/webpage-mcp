/**
 * Resource-bounded DOM traversal helpers for Web Editor operations.
 *
 * These helpers intentionally avoid live/static collection snapshots. A caller
 * must be able to finish its bounded walk before a result is considered valid.
 */

export const WEB_EDITOR_DOM_LIMITS = {
  maxClasses: 256,
  maxDepth: 128,
  maxDirectChildren: 4_096,
  maxElements: 20_000,
  maxSelectorLength: 4_096,
  maxTraversalMs: 200,
} as const;

export interface DomTraversalBudget {
  deadline: number;
  remainingElements: number;
}

export interface DomTraversalBudgetOptions {
  maxElements?: number;
  maxTraversalMs?: number;
}

export interface ElementInsertionReference {
  complete: boolean;
  reference: Element | null;
}

function finiteLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value ?? fallback));
}

export function createDomTraversalBudget(
  options: DomTraversalBudgetOptions = {},
): DomTraversalBudget {
  const maxElements = finiteLimit(options.maxElements, WEB_EDITOR_DOM_LIMITS.maxElements);
  const maxTraversalMs = finiteLimit(
    options.maxTraversalMs,
    WEB_EDITOR_DOM_LIMITS.maxTraversalMs,
  );
  return {
    deadline: Date.now() + maxTraversalMs,
    remainingElements: maxElements,
  };
}

function consumeElement(budget: DomTraversalBudget): boolean {
  if (budget.remainingElements <= 0 || Date.now() > budget.deadline) return false;
  budget.remainingElements -= 1;
  return true;
}

interface TraversalCursor {
  element: Element;
  depth: number;
}

function nextElementWithin(
  root: ParentNode,
  current: Element,
  depth: number,
): TraversalCursor | null {
  if (depth < WEB_EDITOR_DOM_LIMITS.maxDepth && current.firstElementChild) {
    return { element: current.firstElementChild, depth: depth + 1 };
  }

  let cursor = current;
  let cursorDepth = depth;
  while (cursorDepth > 0) {
    if (cursor.nextElementSibling) {
      return { element: cursor.nextElementSibling, depth: cursorDepth };
    }

    const parent = cursor.parentElement;
    if (!parent || parent === root) return null;
    cursor = parent;
    cursorDepth -= 1;
  }

  return null;
}

/**
 * Visit descendant elements without materializing an HTMLCollection/NodeList.
 * Returns false when the walk could not finish within the shared budget.
 */
export function visitDescendantElements(
  root: ParentNode,
  visitor: (element: Element) => void,
  budget: DomTraversalBudget = createDomTraversalBudget(),
): boolean {
  let cursor = root.firstElementChild
    ? { element: root.firstElementChild, depth: 1 }
    : null;

  while (cursor) {
    if (!consumeElement(budget)) return false;
    visitor(cursor.element);
    if (
      cursor.depth >= WEB_EDITOR_DOM_LIMITS.maxDepth &&
      cursor.element.firstElementChild
    ) {
      return false;
    }
    cursor = nextElementWithin(root, cursor.element, cursor.depth);
  }

  return true;
}

/**
 * Find exactly one match while retaining at most one Element reference.
 * Returns null for zero/multiple matches, invalid/oversized selectors, or an
 * exhausted traversal budget.
 */
export function findUniqueElement(
  root: ParentNode,
  selector: string,
  budget: DomTraversalBudget = createDomTraversalBudget(),
): Element | null {
  if (
    typeof selector !== 'string' ||
    selector.length === 0 ||
    selector.length > WEB_EDITOR_DOM_LIMITS.maxSelectorLength
  ) {
    return null;
  }

  let match: Element | null = null;
  let cursor = root.firstElementChild
    ? { element: root.firstElementChild, depth: 1 }
    : null;

  try {
    while (cursor) {
      if (!consumeElement(budget)) return null;
      if (cursor.element.matches(selector)) {
        if (match) return null;
        match = cursor.element;
      }
      if (
        cursor.depth >= WEB_EDITOR_DOM_LIMITS.maxDepth &&
        cursor.element.firstElementChild
      ) {
        return null;
      }
      cursor = nextElementWithin(root, cursor.element, cursor.depth);
    }

    return match;
  } catch {
    return null;
  }
}

/**
 * Resolve a child-index path without walking unrelated descendant subtrees.
 * Every inspected child still consumes the caller's shared traversal budget.
 */
export function findElementByPath(
  root: ParentNode,
  path: readonly number[],
  budget: DomTraversalBudget = createDomTraversalBudget(),
): Element | null {
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    path.length > WEB_EDITOR_DOM_LIMITS.maxDepth
  ) {
    return null;
  }

  let parent: ParentNode = root;
  for (const index of path) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= WEB_EDITOR_DOM_LIMITS.maxDirectChildren
    ) {
      return null;
    }

    let child = parent.firstElementChild;
    for (let position = 0; position <= index; position += 1) {
      if (!child || !consumeElement(budget)) return null;
      if (position === index) break;
      child = child.nextElementSibling;
    }
    if (!child) return null;
    parent = child;
  }

  return parent instanceof Element ? parent : null;
}

/** Read a bounded class list without first copying the whole DOMTokenList. */
export function readBoundedClassNames(
  element: Element,
  maxClasses: number = WEB_EDITOR_DOM_LIMITS.maxClasses,
): string[] {
  const classes: string[] = [];
  const limit = finiteLimit(maxClasses, WEB_EDITOR_DOM_LIMITS.maxClasses);

  try {
    const list = element.classList;
    for (let index = 0; index < list.length && classes.length < limit; index++) {
      const token = list.item(index);
      if (token) classes.push(token);
    }
  } catch {
    // Invalid/disconnected DOM state is treated as an empty class list.
  }

  return classes;
}

/** Find an element's direct-child index without snapshotting parent.children. */
export function findElementIndex(
  parent: ParentNode,
  target: Element,
  maxChildren: number = WEB_EDITOR_DOM_LIMITS.maxDirectChildren,
): number | null {
  const limit = finiteLimit(maxChildren, WEB_EDITOR_DOM_LIMITS.maxDirectChildren);
  let index = 0;

  for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
    if (index >= limit) return null;
    if (child === target) return index;
    index += 1;
  }

  return null;
}

/**
 * Resolve the element reference for index-based insertion. The optional
 * excluded element mirrors the old "copy children then splice target" logic.
 */
export function findElementInsertionReference(
  parent: ParentNode,
  requestedIndex: number,
  excluded?: Element,
  maxChildren: number = WEB_EDITOR_DOM_LIMITS.maxDirectChildren,
): ElementInsertionReference {
  const limit = finiteLimit(maxChildren, WEB_EDITOR_DOM_LIMITS.maxDirectChildren);
  const targetIndex = Number.isFinite(requestedIndex)
    ? Math.max(0, Math.floor(requestedIndex))
    : 0;
  let visited = 0;
  let logicalIndex = 0;

  for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
    if (visited >= limit) return { complete: false, reference: null };
    visited += 1;
    if (child === excluded) continue;
    if (logicalIndex === targetIndex) {
      return { complete: true, reference: child };
    }
    logicalIndex += 1;
  }

  return { complete: true, reference: null };
}
