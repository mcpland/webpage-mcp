// Simple in-memory screenshot context manager per tab
// Used to scale coordinates from screenshot space to viewport space

export interface ScreenshotContext {
  // Final screenshot dimensions (in CSS pixels after any scaling)
  screenshotWidth: number;
  screenshotHeight: number;
  // Viewport dimensions (CSS pixels)
  viewportWidth: number;
  viewportHeight: number;
  // Device pixel ratio at capture time (optional, for reference)
  devicePixelRatio?: number;
  // Hostname of the page when the screenshot was taken (used for domain safety checks)
  hostname?: string;
  // Timestamp
  timestamp: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes

const contexts = new Map<number, ScreenshotContext>();

export const screenshotContextManager = {
  setContext(tabId: number, ctx: Omit<ScreenshotContext, 'timestamp'>) {
    contexts.set(tabId, { ...ctx, timestamp: Date.now() });
  },
  getContext(tabId: number): ScreenshotContext | undefined {
    const ctx = contexts.get(tabId);
    if (!ctx) return undefined;
    if (Date.now() - ctx.timestamp > TTL_MS) {
      contexts.delete(tabId);
      return undefined;
    }
    return ctx;
  },
  clear(tabId: number) {
    contexts.delete(tabId);
  },
};

// Scale screenshot-space coordinates (x,y) to viewport CSS pixels
export function scaleCoordinates(
  x: number,
  y: number,
  ctx: ScreenshotContext,
): { x: number; y: number } {
  if (!ctx.screenshotWidth || !ctx.screenshotHeight || !ctx.viewportWidth || !ctx.viewportHeight) {
    return { x, y };
  }
  const sx = (x / ctx.screenshotWidth) * ctx.viewportWidth;
  const sy = (y / ctx.screenshotHeight) * ctx.viewportHeight;
  return { x: Math.round(sx), y: Math.round(sy) };
}
