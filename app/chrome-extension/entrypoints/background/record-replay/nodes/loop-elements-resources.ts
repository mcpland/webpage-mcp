import { ENGINE_CONSTANTS } from '../engine/constants';

export const LOOP_ELEMENTS_RESOURCE_LIMITS = {
  defaultIterations: ENGINE_CONSTANTS.MAX_ITERATIONS,
  maxIterations: ENGINE_CONSTANTS.MAX_ITERATIONS,
  maxSelectorLength: 4_096,
  maxDomVisits: 20_000,
  maxPathDepth: 128,
  maxDirectSiblings: 2_048,
  maxOutputCharacters: 256 * 1024,
  maxDurationMs: 250,
} as const;

export interface LoopElementsDomLimits {
  maxIterations: number;
  maxSelectorLength: number;
  maxDomVisits: number;
  maxPathDepth: number;
  maxDirectSiblings: number;
  maxOutputCharacters: number;
  maxDurationMs: number;
}

export function boundedLoopElementIterations(value: unknown): number {
  const numeric = Number(value ?? LOOP_ELEMENTS_RESOURCE_LIMITS.defaultIterations);
  if (!Number.isFinite(numeric)) return LOOP_ELEMENTS_RESOURCE_LIMITS.defaultIterations;
  return Math.max(1, Math.min(LOOP_ELEMENTS_RESOURCE_LIMITS.maxIterations, Math.floor(numeric)));
}

/**
 * Runs in the page MAIN world. Keep it closure-free so Chrome can serialize it.
 */
export function collectLoopElementPaths(
  selector: string,
  maxResults: number,
  limits: LoopElementsDomLimits,
): string[] {
  try {
    if (!selector || selector.length > limits.maxSelectorLength) return [];
    const resultLimit = Number.isFinite(maxResults)
      ? Math.max(1, Math.min(limits.maxIterations, Math.floor(maxResults)))
      : limits.maxIterations;
    const startedAt = Date.now();
    let domVisits = 0;
    const consumeVisit = (): boolean => {
      if (domVisits >= limits.maxDomVisits) return false;
      if (Date.now() - startedAt > limits.maxDurationMs) return false;
      domVisits += 1;
      return true;
    };
    const toCss = (node: Element): string | null => {
      const segments: string[] = [];
      let current: Element | null = node;
      let depth = 0;
      while (current) {
        if (depth >= limits.maxPathDepth || !consumeVisit()) return null;
        depth += 1;
        let part = current.tagName.toLowerCase();
        if (!/^[a-z][a-z0-9_-]*$/i.test(part)) return null;
        const parentElement: Element | null = current.parentElement;
        if (parentElement) {
          let sameTagCount = 0;
          let sameTagIndex = -1;
          let siblingVisits = 0;
          for (
            let sibling = parentElement.firstElementChild;
            sibling;
            sibling = sibling.nextElementSibling
          ) {
            if (siblingVisits >= limits.maxDirectSiblings || !consumeVisit()) return null;
            siblingVisits += 1;
            if (sibling.tagName !== current.tagName) continue;
            sameTagCount += 1;
            if (sibling === current) sameTagIndex = sameTagCount;
          }
          if (sameTagIndex < 1) return null;
          if (sameTagCount > 1) part += `:nth-of-type(${sameTagIndex})`;
        }
        segments.unshift(part);
        if (current === document.documentElement) break;
        current = parentElement;
      }
      const path = segments.join(' > ');
      return path && path.length <= limits.maxSelectorLength ? path : null;
    };

    const paths: string[] = [];
    let outputCharacters = 0;
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
    let current = walker.nextNode() as Element | null;
    while (current && paths.length < resultLimit) {
      if (!consumeVisit()) break;
      if (current.matches(selector)) {
        const path = toCss(current);
        if (path) {
          if (outputCharacters + path.length > limits.maxOutputCharacters) break;
          paths.push(path);
          outputCharacters += path.length;
        }
      }
      current = walker.nextNode() as Element | null;
    }
    return paths;
  } catch {
    return [];
  }
}
