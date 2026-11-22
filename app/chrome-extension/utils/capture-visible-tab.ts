/**
 * chrome.tabs.captureVisibleTab is limited to
 * MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND calls per second for the whole
 * extension. Independent captures (chrome_screenshot, chrome_computer
 * screenshot, full-page stitching, workflow artifacts) used to fail with a quota
 * error whenever two of them landed within the same second. Every caller goes
 * through this pacer, which spaces captures out and retries quota rejections.
 */

const QUOTA_ERROR_PATTERN = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i;
const DEFAULT_CALLS_PER_SECOND = 2;
const SAFETY_MARGIN_MS = 50;
const MAX_QUOTA_RETRIES = 2;
export const DEFAULT_CAPTURE_VISIBLE_TAB_TIMEOUT_MS = 15_000;

let lastCaptureStartedAt = Number.NEGATIVE_INFINITY;
let queue: Promise<unknown> = Promise.resolve();

function minimumIntervalMs(): number {
  const rate = (chrome.tabs as { MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND?: unknown })
    .MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND;
  const callsPerSecond =
    typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_CALLS_PER_SECOND;
  return Math.ceil(1000 / callsPerSecond) + SAFETY_MARGIN_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return QUOTA_ERROR_PATTERN.test(message);
}

function withCaptureTimeout(promise: Promise<string>, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`captureVisibleTab timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * captureVisibleTab with extension-wide pacing. Pass `windowId` to capture a
 * specific window, or undefined for the current window.
 */
export function captureVisibleTabPaced(
  windowId: number | undefined,
  options: chrome.tabs.CaptureVisibleTabOptions,
  timeoutMs = DEFAULT_CAPTURE_VISIBLE_TAB_TIMEOUT_MS,
): Promise<string> {
  const run = async (): Promise<string> => {
    const interval = minimumIntervalMs();
    for (let attempt = 0; ; attempt += 1) {
      const wait = lastCaptureStartedAt + interval - Date.now();
      if (wait > 0) await sleep(wait);
      lastCaptureStartedAt = Date.now();
      try {
        const capture =
          typeof windowId === 'number'
            ? chrome.tabs.captureVisibleTab(windowId, options)
            : chrome.tabs.captureVisibleTab(options);
        return await withCaptureTimeout(capture, timeoutMs);
      } catch (error) {
        if (attempt >= MAX_QUOTA_RETRIES || !isQuotaError(error)) throw error;
      }
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/** Test hook: forget pacing state between isolated runs. */
export function resetCaptureVisibleTabPacerForTests(): void {
  lastCaptureStartedAt = Number.NEGATIVE_INFINITY;
  queue = Promise.resolve();
}
