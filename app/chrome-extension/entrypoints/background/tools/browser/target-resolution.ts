export interface BrowserCoordinates {
  x: number;
  y: number;
}

export function isCompositeSelector(selector?: string): boolean {
  return typeof selector === 'string' && selector.includes('|>');
}

function normalizeCoordinates(value: any): BrowserCoordinates | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
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
    typeof response?.href === 'string' && response.href.trim()
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
