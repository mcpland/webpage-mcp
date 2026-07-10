import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { toPublicDownloadLocation } from '@/entrypoints/background/download-paths';
import { BaseBrowserToolExecutor } from '../base-browser';
import { SCREENSHOT_LIMITS, TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  assertDevicePixelRatio,
  assertPixelDimensions,
  assertScreenshotDataUrl,
  canvasToDataURL,
  createImageBitmapFromUrl,
  cropAndResizeImage,
  stitchImages,
  compressImage,
  toPhysicalPixels,
} from '../../../../utils/image-utils';
import { screenshotContextManager } from '@/utils/screenshot-context';

// Screenshot-specific constants
const SCREENSHOT_CONSTANTS = {
  SCROLL_DELAY_MS: 350, // Time to wait after scroll for rendering and lazy loading
  CAPTURE_STITCH_DELAY_MS: 50, // Small delay between captures in a scroll sequence
  PIXEL_TOLERANCE: 1,
  SCRIPT_INIT_DELAY: 100, // Delay for script initialization
} as {
  readonly SCROLL_DELAY_MS: number;
  CAPTURE_STITCH_DELAY_MS: number; // This one is mutable
  readonly PIXEL_TOLERANCE: number;
  readonly SCRIPT_INIT_DELAY: number;
};

// Adjust CAPTURE_STITCH_DELAY_MS to respect Chrome's capture rate if available in runtime
// Some TS typings don't expose MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND; use a safe cast with a sane fallback.
const __MAX_CAP_RATE: number | undefined = (chrome.tabs as any)
  ?.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND;
if (typeof __MAX_CAP_RATE === 'number' && __MAX_CAP_RATE > 0) {
  // Minimum interval between consecutive captureVisibleTab calls (ms)
  const minIntervalMs = Math.ceil(1000 / __MAX_CAP_RATE);
  // Our capture loop already waits SCROLL_DELAY_MS between scroll and capture; add any extra delay needed
  const requiredExtraDelay = Math.max(0, minIntervalMs - SCREENSHOT_CONSTANTS.SCROLL_DELAY_MS);
  SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS = Math.max(
    requiredExtraDelay,
    SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS,
  );
}

interface ScreenshotToolParams {
  name?: string;
  selector?: string;
  tabId?: number;
  background?: boolean;
  windowId?: number;
  width?: number;
  height?: number;
  storeBase64?: boolean;
  fullPage?: boolean;
  savePng?: boolean;
  maxHeight?: number; // Maximum height to capture in pixels (for infinite scroll pages)
}

function hasDisallowedPublicPageScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== 'http' && protocol !== 'https';
}

/** Page details returned by screenshot-helper content script */
interface ScreenshotPageDetails {
  totalWidth: number;
  totalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  currentScrollX: number;
  currentScrollY: number;
}

interface ScreenshotCapture {
  dataUrl: string;
  widthCss: number;
  heightCss: number;
}

const PAGE_DETAILS_REQUIRED_FIELDS: Array<keyof ScreenshotPageDetails> = [
  'totalWidth',
  'totalHeight',
  'viewportWidth',
  'viewportHeight',
  'devicePixelRatio',
  'currentScrollX',
  'currentScrollY',
];

const BACKGROUND_SCREENSHOT_UNSUPPORTED_ERROR =
  'Background screenshots support only viewport capture. fullPage and selector captures require foreground capture because Chrome captureVisibleTab captures the active visible tab.';

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertOptionalUserDimension(
  value: number | undefined,
  label: string,
  maximum: number,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}.`);
  }
}

function assertValidScreenshotParams(args: ScreenshotToolParams): void {
  assertOptionalUserDimension(
    args.width,
    'Screenshot width',
    SCREENSHOT_LIMITS.MAX_USER_DIMENSION_CSS,
  );
  assertOptionalUserDimension(
    args.height,
    'Screenshot height',
    SCREENSHOT_LIMITS.MAX_USER_DIMENSION_CSS,
  );
  assertOptionalUserDimension(
    args.maxHeight,
    'Screenshot maxHeight',
    SCREENSHOT_LIMITS.MAX_FULL_PAGE_HEIGHT_CSS,
  );
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function assertNonNegativeFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
}

function toPhysicalCoordinate(cssPixels: number, dpr: number, label: string): number {
  if (!Number.isFinite(cssPixels)) {
    throw new Error(`${label} must be finite.`);
  }
  const value = Math.round(cssPixels * dpr);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} exceeds the safe numeric range.`);
  }
  return value;
}

/**
 * Validates and asserts that the response from content script contains valid page details
 */
function assertValidPageDetails(details: unknown): ScreenshotPageDetails {
  if (!details || typeof details !== 'object') {
    throw new Error(
      'Screenshot helper did not respond. The content script may not be injected or cannot run on this page.',
    );
  }

  const candidate = details as Partial<ScreenshotPageDetails>;
  const invalidFields = PAGE_DETAILS_REQUIRED_FIELDS.filter((field) => {
    const value = candidate[field];
    return typeof value !== 'number' || !Number.isFinite(value);
  });

  if (invalidFields.length > 0) {
    throw new Error(
      `Screenshot helper returned invalid page details (missing/invalid: ${invalidFields.join(', ')}).`,
    );
  }

  assertPositiveSafeInteger(candidate.totalWidth, 'Page width');
  assertPositiveSafeInteger(candidate.totalHeight, 'Page height');
  assertPositiveSafeInteger(candidate.viewportWidth, 'Viewport width');
  assertPositiveSafeInteger(candidate.viewportHeight, 'Viewport height');
  assertDevicePixelRatio(candidate.devicePixelRatio!, 'Page device pixel ratio');
  assertNonNegativeFiniteNumber(candidate.currentScrollX, 'Horizontal scroll position');
  assertNonNegativeFiniteNumber(candidate.currentScrollY, 'Vertical scroll position');

  const validated = candidate as ScreenshotPageDetails;
  if (
    validated.viewportWidth > validated.totalWidth ||
    validated.viewportHeight > validated.totalHeight
  ) {
    throw new Error('Screenshot helper returned page dimensions smaller than the viewport.');
  }
  const viewportWidthPx = toPhysicalPixels(
    validated.viewportWidth,
    validated.devicePixelRatio,
    'Viewport width',
  );
  const viewportHeightPx = toPhysicalPixels(
    validated.viewportHeight,
    validated.devicePixelRatio,
    'Viewport height',
  );
  assertPixelDimensions(
    viewportWidthPx,
    viewportHeightPx,
    SCREENSHOT_LIMITS.MAX_SOURCE_PIXELS,
    'Screenshot viewport',
  );
  return validated;
}

/**
 * Tool for capturing screenshots of web pages
 */
class ScreenshotTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SCREENSHOT;

  /**
   * Execute screenshot operation
   */
  async execute(args: ScreenshotToolParams): Promise<ToolResult> {
    const {
      name = 'screenshot',
      selector,
      storeBase64 = false,
      fullPage = false,
      savePng = true,
    } = args;

    console.log(`Starting screenshot with options:`, args);

    try {
      assertValidScreenshotParams(args);
    } catch (error) {
      return createErrorResponse(`Screenshot error: ${formatErrorMessage(error)}`);
    }

    // Resolve target tab (explicit or active)
    const explicit = await this.tryGetTab(args.tabId);
    const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));

    // Check URL restrictions
    if (
      tab.url?.startsWith('chrome://') ||
      tab.url?.startsWith('edge://') ||
      tab.url?.startsWith('https://chrome.google.com/webstore') ||
      tab.url?.startsWith('https://microsoftedge.microsoft.com/')
    ) {
      return createErrorResponse(
        'Cannot capture special browser pages or web store pages due to security restrictions.',
      );
    }
    if (hasDisallowedPublicPageScheme(String(tab.url || ''))) {
      return createErrorResponse(
        'Only http:// and https:// pages are supported by chrome_screenshot',
      );
    }

    let finalImageDataUrl: string | undefined;
    let finalImageWidthCss: number | undefined;
    let finalImageHeightCss: number | undefined;
    const results: any = { base64: null, fileSaved: false };
    let originalScroll: { x: number; y: number } | null = null;
    let didPreparePage = false;
    let pageDetails: ScreenshotPageDetails | undefined;

    try {
      const background = args.background === true;
      if (background && (fullPage || selector)) {
        throw new Error(BACKGROUND_SCREENSHOT_UNSUPPORTED_ERROR);
      }

      // === Path 1: CDP viewport capture (no content script needed) ===
      if (background) {
        try {
          const tabId = tab.id!;
          const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
          await cdpSessionManager.withSession(tabId, 'screenshot', async () => {
            const metrics: any = await cdpSessionManager.sendCommand(
              tabId,
              'Page.getLayoutMetrics',
              {},
            );
            const viewport = metrics?.layoutViewport || metrics?.visualViewport;
            assertPositiveSafeInteger(viewport?.clientWidth, 'CDP viewport width');
            assertPositiveSafeInteger(viewport?.clientHeight, 'CDP viewport height');
            const dprResult: any = await cdpSessionManager.sendCommand(tabId, 'Runtime.evaluate', {
              expression: 'window.devicePixelRatio',
              returnByValue: true,
            });
            const dpr = assertDevicePixelRatio(dprResult?.result?.value, 'CDP device pixel ratio');
            const viewportWidthPx = toPhysicalPixels(
              viewport.clientWidth,
              dpr,
              'CDP viewport width',
            );
            const viewportHeightPx = toPhysicalPixels(
              viewport.clientHeight,
              dpr,
              'CDP viewport height',
            );
            assertPixelDimensions(
              viewportWidthPx,
              viewportHeightPx,
              SCREENSHOT_LIMITS.MAX_SOURCE_PIXELS,
              'CDP screenshot viewport',
            );
            const shot: any = await cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', {
              format: 'png',
            });
            const base64Data = typeof shot?.data === 'string' ? shot.data : '';
            if (!base64Data) {
              throw new Error('CDP Page.captureScreenshot returned empty data');
            }
            finalImageDataUrl = `data:image/png;base64,${base64Data}`;
            assertScreenshotDataUrl(finalImageDataUrl, 'CDP screenshot data URL');
            let bitmap: ImageBitmap | undefined;
            try {
              bitmap = await createImageBitmapFromUrl(finalImageDataUrl);
            } finally {
              bitmap?.close();
            }
            finalImageWidthCss = viewport.clientWidth;
            finalImageHeightCss = viewport.clientHeight;
          });
        } catch (e) {
          throw new Error(`Background screenshot failed via CDP: ${formatErrorMessage(e)}`);
        }
      }

      // === Path 2: Helper-assisted capture (requires content script) ===
      if (!finalImageDataUrl) {
        // Always inject helper when we need pageDetails
        await this.injectContentScript(tab.id!, ['inject-scripts/screenshot-helper.js']);
        await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY));

        // Prepare page (hide scrollbars, handle fixed elements)
        const prepareResp = await this.sendMessageToTab(tab.id!, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE,
          options: { fullPage },
        });
        if (!prepareResp || prepareResp.success !== true) {
          throw new Error(
            'Screenshot helper did not acknowledge page preparation. The content script may not be injected or cannot run on this page.',
          );
        }
        didPreparePage = true;

        // Get page details with validation
        const rawPageDetails = await this.sendMessageToTab(tab.id!, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS,
        });
        pageDetails = assertValidPageDetails(rawPageDetails);
        originalScroll = {
          x: pageDetails.currentScrollX,
          y: pageDetails.currentScrollY,
        };

        if (fullPage) {
          this.logInfo('Capturing full page...');
          const capture = await this._captureFullPage(tab.id!, args, pageDetails);
          finalImageDataUrl = capture.dataUrl;
          finalImageWidthCss = capture.widthCss;
          finalImageHeightCss = capture.heightCss;
        } else if (selector) {
          this.logInfo(`Capturing element: ${selector}`);
          const capture = await this._captureElement(tab.id!, args, pageDetails.devicePixelRatio);
          finalImageDataUrl = capture.dataUrl;
          finalImageWidthCss = capture.widthCss;
          finalImageHeightCss = capture.heightCss;
        } else {
          // Visible area only
          this.logInfo('Capturing visible area...');
          finalImageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          assertScreenshotDataUrl(finalImageDataUrl, 'Visible screenshot data URL');
          let bitmap: ImageBitmap | undefined;
          try {
            bitmap = await createImageBitmapFromUrl(finalImageDataUrl);
          } finally {
            bitmap?.close();
          }
          finalImageWidthCss = pageDetails.viewportWidth;
          finalImageHeightCss = pageDetails.viewportHeight;
        }
      }

      if (!finalImageDataUrl) {
        throw new Error('Failed to capture image data');
      }
      assertScreenshotDataUrl(finalImageDataUrl, 'Final screenshot data URL');

      // 2. Process output
      // Update screenshot context for coordinate scaling by tools like chrome_computer
      try {
        if (typeof finalImageWidthCss === 'number' && typeof finalImageHeightCss === 'number') {
          let hostname = '';
          try {
            hostname = tab.url ? new URL(tab.url).hostname : '';
          } catch {
            // ignore
          }
          // Use pageDetails if available, otherwise fall back to final image dimensions
          const viewportWidth = pageDetails?.viewportWidth ?? finalImageWidthCss;
          const viewportHeight = pageDetails?.viewportHeight ?? finalImageHeightCss;
          screenshotContextManager.setContext(tab.id!, {
            screenshotWidth: finalImageWidthCss,
            screenshotHeight: finalImageHeightCss,
            viewportWidth,
            viewportHeight,
            devicePixelRatio: pageDetails?.devicePixelRatio,
            hostname,
          });
        }
      } catch (e) {
        console.warn('Failed to set screenshot context:', e);
      }
      if (storeBase64 === true) {
        // Compress image for base64 output to reduce size
        const compressed = await compressImage(finalImageDataUrl, {
          scale: 0.7, // Reduce dimensions by 30%
          quality: 0.8, // 80% quality for good balance
          format: 'image/jpeg', // JPEG for better compression
        });

        // Include base64 data in response (without prefix)
        const base64Data = compressed.dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
        results.base64 = base64Data;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                base64Data,
                mimeType: compressed.mimeType,
              }),
            },
          ],
          isError: false,
        };
      }

      if (savePng === true) {
        // Save PNG file to downloads
        this.logInfo('Saving PNG...');
        try {
          // Generate filename
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `${name.replace(/[^a-z0-9_-]/gi, '_') || 'screenshot'}_${timestamp}.png`;

          // Use Chrome's download API to save the file
          const downloadId = await chrome.downloads.download({
            url: finalImageDataUrl,
            filename: filename,
            saveAs: false,
          });

          results.downloadId = downloadId;
          results.fileSaved = true;
          Object.assign(results, toPublicDownloadLocation({ filename }));
        } catch (error) {
          console.error('Error saving PNG file:', error);
          results.saveError = String(error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      console.error('Error during screenshot execution:', error);
      return createErrorResponse(
        `Screenshot error: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
    } finally {
      // 3. Reset page only if we prepared it
      if (didPreparePage) {
        try {
          // Only include scroll position if we successfully captured it
          const resetMessage: Record<string, unknown> = {
            action: TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE,
          };
          if (originalScroll) {
            resetMessage.scrollX = originalScroll.x;
            resetMessage.scrollY = originalScroll.y;
          }
          await this.sendMessageToTab(tab.id!, resetMessage);
        } catch (err) {
          console.warn('Failed to reset page, tab might have closed:', err);
        }
      }
    }

    this.logInfo('Screenshot completed!');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `Screenshot [${name}] captured successfully`,
            tabId: tab.id,
            url: tab.url,
            name: name,
            ...results,
          }),
        },
      ],
      isError: false,
    };
  }

  /**
   * Log information
   */
  private logInfo(message: string) {
    console.log(`[Screenshot Tool] ${message}`);
  }

  /**
   * Capture specific element
   */
  async _captureElement(
    tabId: number,
    options: ScreenshotToolParams,
    pageDpr: number,
  ): Promise<ScreenshotCapture> {
    const elementDetails = await this.sendMessageToTab(tabId, {
      action: TOOL_MESSAGE_TYPES.SCREENSHOT_GET_ELEMENT_DETAILS,
      selector: options.selector,
    });

    if (!elementDetails || typeof elementDetails !== 'object' || !elementDetails.rect) {
      throw new Error(
        typeof elementDetails?.error === 'string'
          ? elementDetails.error
          : 'Screenshot helper returned invalid element details.',
      );
    }
    const rect = elementDetails.rect as Partial<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      if (typeof rect[field] !== 'number' || !Number.isFinite(rect[field])) {
        throw new Error(`Screenshot helper returned an invalid element ${field}.`);
      }
    }
    if (rect.width! <= 0 || rect.height! <= 0) {
      throw new Error('Screenshot element dimensions must be greater than 0.');
    }

    const dpr = assertDevicePixelRatio(
      elementDetails.devicePixelRatio ?? pageDpr,
      'Element device pixel ratio',
    );

    // Element rect is viewport-relative, in CSS pixels
    // captureVisibleTab captures in physical pixels
    const cropRectPx = {
      x: toPhysicalCoordinate(rect.x!, dpr, 'Element x coordinate'),
      y: toPhysicalCoordinate(rect.y!, dpr, 'Element y coordinate'),
      width: toPhysicalPixels(rect.width!, dpr, 'Element width'),
      height: toPhysicalPixels(rect.height!, dpr, 'Element height'),
    };
    assertPixelDimensions(
      cropRectPx.width,
      cropRectPx.height,
      SCREENSHOT_LIMITS.MAX_SOURCE_PIXELS,
      'Element crop',
    );

    const targetWidthPx = options.width
      ? toPhysicalPixels(options.width, dpr, 'Element output width')
      : cropRectPx.width;
    const targetHeightPx = options.height
      ? toPhysicalPixels(options.height, dpr, 'Element output height')
      : cropRectPx.height;
    assertPixelDimensions(
      targetWidthPx,
      targetHeightPx,
      SCREENSHOT_LIMITS.MAX_TARGET_PIXELS,
      'Element screenshot output',
    );

    // Small delay to ensure element is fully rendered after scrollIntoView
    await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY));

    const visibleCaptureDataUrl = await chrome.tabs.captureVisibleTab({
      format: 'png',
    });
    if (!visibleCaptureDataUrl) {
      throw new Error('Failed to capture visible tab for element cropping');
    }

    const croppedCanvas = await cropAndResizeImage(
      visibleCaptureDataUrl,
      cropRectPx,
      dpr,
      options.width, // Target output width in CSS pixels
      options.height, // Target output height in CSS pixels
    );
    const dataUrl = await canvasToDataURL(croppedCanvas);
    return {
      dataUrl,
      widthCss: croppedCanvas.width / dpr,
      heightCss: croppedCanvas.height / dpr,
    };
  }

  /**
   * Capture full page
   */
  async _captureFullPage(
    tabId: number,
    options: ScreenshotToolParams,
    initialPageDetails: ScreenshotPageDetails,
  ): Promise<ScreenshotCapture> {
    const dpr = assertDevicePixelRatio(initialPageDetails.devicePixelRatio);
    const totalWidthCss = initialPageDetails.totalWidth;
    const totalHeightCss = initialPageDetails.totalHeight;
    const requestedMaxHeightCss = Math.min(
      options.maxHeight ?? SCREENSHOT_LIMITS.MAX_FULL_PAGE_HEIGHT_CSS,
      SCREENSHOT_LIMITS.MAX_FULL_PAGE_HEIGHT_CSS,
    );
    const limitedHeightCss = Math.min(totalHeightCss, requestedMaxHeightCss);
    const totalWidthPx = toPhysicalPixels(totalWidthCss, dpr, 'Full-page width');
    const totalHeightPx = toPhysicalPixels(limitedHeightCss, dpr, 'Full-page height');
    assertPixelDimensions(
      totalWidthPx,
      totalHeightPx,
      SCREENSHOT_LIMITS.MAX_STITCH_PIXELS,
      'Full-page stitched canvas',
    );

    const expectedParts = Math.ceil(limitedHeightCss / initialPageDetails.viewportHeight);
    if (expectedParts > SCREENSHOT_LIMITS.MAX_CAPTURE_PARTS) {
      throw new Error(
        `Full-page capture requires ${expectedParts} parts, exceeding the ${SCREENSHOT_LIMITS.MAX_CAPTURE_PARTS}-part limit. Reduce maxHeight or enlarge the viewport.`,
      );
    }

    let outputWidthCss = totalWidthCss;
    let outputHeightCss = limitedHeightCss;
    if (options.width !== undefined && options.height !== undefined) {
      outputWidthCss = options.width;
      outputHeightCss = options.height;
    } else if (options.width !== undefined) {
      outputWidthCss = options.width;
      outputHeightCss = Math.max(1, Math.round((limitedHeightCss * options.width) / totalWidthCss));
    } else if (options.height !== undefined) {
      outputHeightCss = options.height;
      outputWidthCss = Math.max(1, Math.round((totalWidthCss * options.height) / limitedHeightCss));
    }
    const outputWidthPx = toPhysicalPixels(outputWidthCss, dpr, 'Full-page output width');
    const outputHeightPx = toPhysicalPixels(outputHeightCss, dpr, 'Full-page output height');
    assertPixelDimensions(
      outputWidthPx,
      outputHeightPx,
      SCREENSHOT_LIMITS.MAX_TARGET_PIXELS,
      'Full-page output canvas',
    );

    // Viewport dimensions (CSS pixels) - logged for debugging
    this.logInfo(
      `Viewport size: ${initialPageDetails.viewportWidth}x${initialPageDetails.viewportHeight} CSS pixels`,
    );
    this.logInfo(
      `Page dimensions: ${totalWidthCss}x${totalHeightCss} CSS pixels (limited to ${limitedHeightCss} height)`,
    );

    const viewportHeightCss = initialPageDetails.viewportHeight;

    const capturedParts: Array<{ dataUrl: string; y: number }> = [];
    let capturedDataUrlBytes = 0;
    let currentScrollYCss = 0;
    let capturedHeightPx = 0;

    while (capturedHeightPx < totalHeightPx) {
      const partIndex = capturedParts.length;
      if (partIndex >= SCREENSHOT_LIMITS.MAX_CAPTURE_PARTS) {
        throw new Error(
          `Full-page capture exceeded the ${SCREENSHOT_LIMITS.MAX_CAPTURE_PARTS}-part limit.`,
        );
      }
      this.logInfo(
        `Capturing part ${partIndex + 1}... (${Math.round((capturedHeightPx / totalHeightPx) * 100)}%)`,
      );

      if (currentScrollYCss > 0) {
        // Don't scroll for the first part if already at top
        const scrollResp = await this.sendMessageToTab(tabId, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_SCROLL_PAGE,
          x: 0,
          y: currentScrollYCss,
          scrollDelay: SCREENSHOT_CONSTANTS.SCROLL_DELAY_MS,
        });
        assertNonNegativeFiniteNumber(scrollResp?.newScrollY, 'Actual vertical scroll position');
        if (scrollResp.newScrollY > totalHeightCss) {
          throw new Error('Screenshot helper returned a vertical scroll position beyond the page.');
        }
        currentScrollYCss = scrollResp.newScrollY;
      }

      const yOffsetPx = toPhysicalCoordinate(currentScrollYCss, dpr, 'Screenshot part offset');
      if (yOffsetPx < 0 || yOffsetPx >= totalHeightPx) {
        throw new Error('Screenshot part offset falls outside the stitched canvas.');
      }

      // Ensure rendering after scroll
      await new Promise((resolve) =>
        setTimeout(resolve, SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS),
      );

      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
      if (!dataUrl) throw new Error('captureVisibleTab returned empty during full page capture');
      assertScreenshotDataUrl(dataUrl, `Screenshot part ${partIndex + 1}`);
      capturedDataUrlBytes += dataUrl.length;
      if (
        !Number.isSafeInteger(capturedDataUrlBytes) ||
        capturedDataUrlBytes > SCREENSHOT_LIMITS.MAX_CAPTURE_DATA_URL_BYTES
      ) {
        throw new Error(
          `Screenshot parts exceed the ${SCREENSHOT_LIMITS.MAX_CAPTURE_DATA_URL_BYTES.toLocaleString('en-US')}-byte aggregate limit.`,
        );
      }

      let image: ImageBitmap | undefined;
      try {
        image = await createImageBitmapFromUrl(dataUrl);
        const effectiveHeightPx = Math.min(image.height, totalHeightPx - yOffsetPx);
        capturedHeightPx = yOffsetPx + effectiveHeightPx;
      } finally {
        image?.close();
      }
      capturedParts.push({ dataUrl, y: yOffsetPx });

      if (capturedHeightPx >= totalHeightPx - SCREENSHOT_CONSTANTS.PIXEL_TOLERANCE) break;

      const maximumScrollYCss = Math.max(0, limitedHeightCss - viewportHeightCss);
      const nextScrollYCss = Math.min(currentScrollYCss + viewportHeightCss, maximumScrollYCss);
      if (nextScrollYCss <= currentScrollYCss) {
        throw new Error('Full-page capture could not make forward scroll progress.');
      }
      currentScrollYCss = nextScrollYCss;
    }

    if (totalHeightCss > limitedHeightCss) {
      this.logInfo(
        `Page height (${totalHeightCss}px) exceeds maximum capture height (${requestedMaxHeightCss}px). Capturing limited portion.`,
      );
    }

    this.logInfo('Stitching image...');
    const finalCanvas = await stitchImages(capturedParts, totalWidthPx, totalHeightPx);

    let outputCanvas = finalCanvas;
    if (outputWidthPx !== finalCanvas.width || outputHeightPx !== finalCanvas.height) {
      outputCanvas = new OffscreenCanvas(outputWidthPx, outputHeightPx);
      const ctx = outputCanvas.getContext('2d');
      if (!ctx) {
        throw new Error('Unable to get full-page output canvas context.');
      }
      ctx.drawImage(finalCanvas, 0, 0, outputWidthPx, outputHeightPx);
    }

    const dataUrl = await canvasToDataURL(outputCanvas);
    return { dataUrl, widthCss: outputWidthCss, heightCss: outputHeightCss };
  }
}

export const screenshotTool = new ScreenshotTool();
