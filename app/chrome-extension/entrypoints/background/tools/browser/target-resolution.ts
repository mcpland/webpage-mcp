export interface BrowserCoordinates {
  x: number;
  y: number;
}

export const BROWSER_TARGET_LIMITS = {
  selectorBytes: 4 * 1024,
  refBytes: 128,
} as const;

function utf8ByteLength(value: string, stopAfter: number): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

export function normalizeBrowserTargetSelector(
  value: unknown,
  selectorType: 'css' | 'xpath' = 'css',
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('selector must be a string');
  const selector = value.trim();
  if (!selector) return undefined;
  if (
    selector.length > BROWSER_TARGET_LIMITS.selectorBytes ||
    utf8ByteLength(selector, BROWSER_TARGET_LIMITS.selectorBytes) >
      BROWSER_TARGET_LIMITS.selectorBytes
  ) {
    throw new Error(
      `selector exceeds the ${BROWSER_TARGET_LIMITS.selectorBytes}-byte UTF-8 limit`,
    );
  }
  if (selectorType === 'css' && /:has\s*\(/iu.test(selector)) {
    throw new Error('selector must not use the resource-intensive :has() pseudo-class');
  }
  return selector;
}

export function normalizeBrowserTargetRef(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('ref must be a string');
  const ref = value.trim();
  if (!ref) return undefined;
  if (
    ref.length > BROWSER_TARGET_LIMITS.refBytes ||
    utf8ByteLength(ref, BROWSER_TARGET_LIMITS.refBytes) > BROWSER_TARGET_LIMITS.refBytes
  ) {
    throw new Error(`ref exceeds the ${BROWSER_TARGET_LIMITS.refBytes}-byte UTF-8 limit`);
  }
  return ref;
}

export function isCompositeSelector(selector?: string): boolean {
  return typeof selector === 'string' && selector.includes('|>');
}

function normalizeCoordinates(value: any): BrowserCoordinates | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const x = typeof value.x === 'number' ? value.x : Number.NaN;
  const y = typeof value.y === 'number' ? value.y : Number.NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y };
}

export async function resolveFrameIdForMessageResult(
  tabId: number,
  requestedFrameId: number | undefined,
  response: { href?: unknown } | null | undefined,
): Promise<number | undefined> {
  if (typeof requestedFrameId === 'number') {
    return requestedFrameId;
  }

  const href =
    typeof response?.href === 'string' &&
    response.href.length <= 16 * 1024 &&
    response.href.trim()
      ? response.href.trim()
      : undefined;
  if (!href) {
    return requestedFrameId;
  }

  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const match = frames?.find(
      (frame) => typeof frame.url === 'string' && frame.url === href,
    );
    return typeof match?.frameId === 'number'
      ? match.frameId
      : requestedFrameId;
  } catch {
    return requestedFrameId;
  }
}

export function getResolvedViewportCoordinates(
  resolved: any,
  frameId?: number,
): BrowserCoordinates | undefined {
  const viewportCenter = normalizeCoordinates(resolved?.viewportCenter);
  if (viewportCenter) {
    return viewportCenter;
  }

  if (typeof frameId === 'number') {
    return undefined;
  }

  return normalizeCoordinates(resolved?.center);
}

export function getResolvedLocalCoordinates(
  resolved: any,
): BrowserCoordinates | undefined {
  return normalizeCoordinates(resolved?.center);
}
