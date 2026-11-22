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

// Each frame numbers its refs independently (ref_1, ref_2, ...), so a bare ref
// is only meaningful for the top frame. Refs produced by a child frame are
// qualified with that frame's Chrome frameId: "f<frameId>:ref_<n>".
const FRAME_QUALIFIED_REF_PATTERN = /^f(\d{1,10}):(ref_\d{1,12})$/;
const PAGE_CONTENT_REF_PATTERN = /\[ref=(ref_\d{1,12})\]/g;

export interface RefTarget {
  ref: string;
  frameId?: number;
}

/**
 * Split an optionally frame-qualified ref and reconcile it with an explicit
 * frameId argument. A qualified ref always carries its own frame; passing a
 * different explicit frameId is a caller error rather than a silent reroute.
 */
export function resolveRefTarget(
  rawRef: unknown,
  explicitFrameId?: number,
): RefTarget | undefined {
  const normalized = normalizeBrowserTargetRef(rawRef);
  if (!normalized) return undefined;
  const match = FRAME_QUALIFIED_REF_PATTERN.exec(normalized);
  if (!match) {
    return {
      ref: normalized,
      ...(typeof explicitFrameId === 'number' ? { frameId: explicitFrameId } : {}),
    };
  }
  const frameId = Number(match[1]);
  if (!Number.isSafeInteger(frameId)) {
    throw new Error(`ref "${normalized}" has an invalid frame id`);
  }
  if (typeof explicitFrameId === 'number' && explicitFrameId !== frameId) {
    throw new Error(
      `ref "${normalized}" belongs to frame ${frameId}, but frameId ${explicitFrameId} was provided`,
    );
  }
  return { ref: match[2], frameId };
}

/** Qualify a frame-local ref so later calls are routed back to its frame. */
export function qualifyFrameRef(ref: string, frameId?: number): string {
  return typeof frameId === 'number' && Number.isSafeInteger(frameId) && frameId > 0
    ? `f${frameId}:${ref}`
    : ref;
}

/** Qualify every `[ref=ref_n]` marker of an accessibility tree for `frameId`. */
export function qualifyPageContentRefs(pageContent: string, frameId?: number): string {
  if (typeof frameId !== 'number' || !Number.isSafeInteger(frameId) || frameId <= 0) {
    return pageContent;
  }
  return pageContent.replace(
    PAGE_CONTENT_REF_PATTERN,
    (_match, ref: string) => `[ref=${qualifyFrameRef(ref, frameId)}]`,
  );
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

  if (typeof frameId === 'number' && frameId !== 0) {
    return undefined;
  }

  return normalizeCoordinates(resolved?.center);
}

export function getResolvedLocalCoordinates(
  resolved: any,
): BrowserCoordinates | undefined {
  return normalizeCoordinates(resolved?.center);
}
