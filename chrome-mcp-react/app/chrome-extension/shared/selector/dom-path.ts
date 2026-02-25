/**
 * DOM Path - DOM 路径计算和定位
 *
 * DOM 路径是元素在 DOM 树中的索引路径，用于：
 * - 元素位置追踪
 * - 选择器失效后的快速恢复
 * - 元素比较和验证
 */

// =============================================================================
// Types
// =============================================================================

/**
 * DOM 路径：从根到目标元素的子元素索引数组
 *
 * @example
 * ```
 * [0, 2, 1] 表示:
 * root
 *  └─ children[0]
 *      └─ children[2]
 *          └─ children[1]  <- 目标元素
 * ```
 */
export type DomPath = number[];

// =============================================================================
// Core Functions
// =============================================================================

/**
 * 计算元素在 DOM 树中的路径
 *
 * 从目标元素向上遍历到根节点（Document 或 ShadowRoot），
 * 记录每一层在父元素 children 中的索引。
 *
 * @example
 * ```ts
 * const path = computeDomPath(button);
 * // => [0, 2, 1] - 从 body/shadowRoot 开始的路径
 * ```
 */
export function computeDomPath(element: Element): DomPath {
  const path: DomPath = [];
  let current: Element | null = element;

  while (current) {
    const parent: Element | null = current.parentElement;

    if (parent) {
      // 正常父元素
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(current);
      if (index >= 0) {
        path.unshift(index);
      }
      current = parent;
      continue;
    }

    // 检查是否是 ShadowRoot 或 Document 的直接子元素
    const parentNode = current.parentNode;
    if (parentNode instanceof ShadowRoot || parentNode instanceof Document) {
      const children = Array.from(parentNode.children);
      const index = children.indexOf(current);
      if (index >= 0) {
        path.unshift(index);
      }
    }

    // 到达根节点，停止遍历
    break;
  }

  return path;
}

/**
 * 根据 DOM 路径定位元素
 *
 * @param root - 查询根节点（Document 或 ShadowRoot）
 * @param path - DOM 路径
 * @returns 找到的元素，如果路径无效则返回 null
 *
 * @example
 * ```ts
 * const element = locateByDomPath(document, [0, 2, 1]);
 * // => 返回 body > children[0] > children[2] > children[1]
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
 * 比较两个 DOM 路径
 *
 * @returns 包含是否相同和公共前缀长度的结果
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
 * 检查路径 A 是否是路径 B 的祖先
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
 * 获取从祖先路径到后代路径的相对路径
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
