/**
 * Image processing utility functions with explicit memory/resource ceilings.
 */

import { SCREENSHOT_LIMITS } from 'webpage-mcp-shared';

type PixelBudget =
  | typeof SCREENSHOT_LIMITS.MAX_SOURCE_PIXELS
  | typeof SCREENSHOT_LIMITS.MAX_TARGET_PIXELS
  | typeof SCREENSHOT_LIMITS.MAX_STITCH_PIXELS;

function formatLimit(value: number): string {
  return value.toLocaleString('en-US');
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
}

export function assertDevicePixelRatio(value: number, label = 'Device pixel ratio'): number {
  if (!Number.isFinite(value) || value <= 0 || value > SCREENSHOT_LIMITS.MAX_DEVICE_PIXEL_RATIO) {
    throw new Error(
      `${label} must be greater than 0 and no more than ${SCREENSHOT_LIMITS.MAX_DEVICE_PIXEL_RATIO}.`,
    );
  }
  return value;
}

/** Convert a CSS-pixel dimension to an integer physical-pixel dimension safely. */
export function toPhysicalPixels(cssPixels: number, dpr: number, label: string): number {
  assertFiniteNumber(cssPixels, label);
  assertDevicePixelRatio(dpr);
  if (cssPixels <= 0) {
    throw new Error(`${label} must be greater than 0.`);
  }

  const product = cssPixels * dpr;
  if (!Number.isSafeInteger(Math.ceil(product))) {
    throw new Error(`${label} exceeds the safe numeric range.`);
  }
  return Math.ceil(product);
}

/** Validate dimensions before allocating a bitmap/canvas. */
export function assertPixelDimensions(
  width: number,
  height: number,
  maxPixels: PixelBudget,
  label: string,
): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${label} dimensions must be positive safe integers.`);
  }
  if (
    width > SCREENSHOT_LIMITS.MAX_BITMAP_EDGE_PX ||
    height > SCREENSHOT_LIMITS.MAX_BITMAP_EDGE_PX
  ) {
    throw new Error(
      `${label} dimensions ${width}x${height} exceed the ${formatLimit(SCREENSHOT_LIMITS.MAX_BITMAP_EDGE_PX)}-pixel edge limit.`,
    );
  }

  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
    throw new Error(
      `${label} dimensions ${width}x${height} exceed the ${formatLimit(maxPixels)}-pixel budget.`,
    );
  }
}

export function assertScreenshotDataUrl(dataUrl: string, label = 'Screenshot data URL'): void {
  if (typeof dataUrl !== 'string' || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(dataUrl)) {
    throw new Error(`${label} must be a base64 image data URL.`);
  }
  if (dataUrl.length > SCREENSHOT_LIMITS.MAX_DATA_URL_BYTES) {
    throw new Error(
      `${label} exceeds the ${formatLimit(SCREENSHOT_LIMITS.MAX_DATA_URL_BYTES)}-byte limit.`,
    );
  }
}

function assertBlobCanEncodeAsDataUrl(blob: Blob, label: string): void {
  const mimeType = blob.type || 'application/octet-stream';
  const prefixBytes = `data:${mimeType};base64,`.length;
  const encodedBytes = prefixBytes + 4 * Math.ceil(blob.size / 3);
  if (encodedBytes > SCREENSHOT_LIMITS.MAX_DATA_URL_BYTES) {
    throw new Error(
      `${label} would exceed the ${formatLimit(SCREENSHOT_LIMITS.MAX_DATA_URL_BYTES)}-byte encoded limit.`,
    );
  }
}

/**
 * Create ImageBitmap from a data URL. The caller owns the returned bitmap and
 * must close it. Failed validation/decoding closes any bitmap created here.
 */
export async function createImageBitmapFromUrl(dataUrl: string): Promise<ImageBitmap> {
  assertScreenshotDataUrl(dataUrl);
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  let bitmap: ImageBitmap | undefined;

  try {
    bitmap = await createImageBitmap(blob);
    assertPixelDimensions(
      bitmap.width,
      bitmap.height,
      SCREENSHOT_LIMITS.MAX_SOURCE_PIXELS,
      'Decoded screenshot',
    );
    return bitmap;
  } catch (error) {
    bitmap?.close();
    throw error;
  }
}

/**
 * Stitch multiple image parts (dataURL) onto a single canvas.
 */
export async function stitchImages(
  parts: { dataUrl: string; y: number }[],
  totalWidthPx: number,
  totalHeightPx: number,
): Promise<OffscreenCanvas> {
  if (parts.length === 0 || parts.length > SCREENSHOT_LIMITS.MAX_CAPTURE_PARTS) {
    throw new Error(
      `Screenshot part count must be between 1 and ${SCREENSHOT_LIMITS.MAX_CAPTURE_PARTS}.`,
    );
  }
  assertPixelDimensions(
    totalWidthPx,
    totalHeightPx,
    SCREENSHOT_LIMITS.MAX_STITCH_PIXELS,
    'Stitched screenshot canvas',
  );

  let retainedBytes = 0;
  for (const [index, part] of parts.entries()) {
    assertScreenshotDataUrl(part.dataUrl, `Screenshot part ${index + 1}`);
    if (!Number.isSafeInteger(part.y) || part.y < 0 || part.y >= totalHeightPx) {
      throw new Error(`Screenshot part ${index + 1} has an invalid vertical offset.`);
    }
    retainedBytes += part.dataUrl.length;
    if (
      !Number.isSafeInteger(retainedBytes) ||
      retainedBytes > SCREENSHOT_LIMITS.MAX_CAPTURE_DATA_URL_BYTES
    ) {
      throw new Error(
        `Screenshot parts exceed the ${formatLimit(SCREENSHOT_LIMITS.MAX_CAPTURE_DATA_URL_BYTES)}-byte aggregate limit.`,
      );
    }
  }

  const canvas = new OffscreenCanvas(totalWidthPx, totalHeightPx);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to get canvas context');
  }

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const part of parts) {
    let image: ImageBitmap | undefined;
    try {
      image = await createImageBitmapFromUrl(part.dataUrl);
      const sourceWidth = Math.min(image.width, totalWidthPx);
      const sourceHeight = Math.min(image.height, totalHeightPx - part.y);
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        throw new Error('Screenshot part has no drawable pixels within the stitched canvas.');
      }
      ctx.drawImage(image, 0, 0, sourceWidth, sourceHeight, 0, part.y, sourceWidth, sourceHeight);
    } finally {
      image?.close();
    }
  }
  return canvas;
}

/** Crop an image to a rectangle and optionally resize it. */
export async function cropAndResizeImage(
  originalDataUrl: string,
  cropRectPx: { x: number; y: number; width: number; height: number },
  dpr: number = 1,
  targetWidthOpt?: number,
  targetHeightOpt?: number,
): Promise<OffscreenCanvas> {
  assertDevicePixelRatio(dpr);
  for (const [field, value] of Object.entries(cropRectPx)) {
    assertFiniteNumber(value, `Crop ${field}`);
  }
  if (cropRectPx.width <= 0 || cropRectPx.height <= 0) {
    throw new Error('Crop dimensions must be greater than 0.');
  }

  const requestedWidthPx =
    targetWidthOpt === undefined
      ? undefined
      : toPhysicalPixels(targetWidthOpt, dpr, 'Target width');
  const requestedHeightPx =
    targetHeightOpt === undefined
      ? undefined
      : toPhysicalPixels(targetHeightOpt, dpr, 'Target height');
  if (requestedWidthPx !== undefined && requestedHeightPx !== undefined) {
    assertPixelDimensions(
      requestedWidthPx,
      requestedHeightPx,
      SCREENSHOT_LIMITS.MAX_TARGET_PIXELS,
      'Cropped screenshot canvas',
    );
  }

  let image: ImageBitmap | undefined;
  try {
    image = await createImageBitmapFromUrl(originalDataUrl);

    let sx = cropRectPx.x;
    let sy = cropRectPx.y;
    let sourceWidth = cropRectPx.width;
    let sourceHeight = cropRectPx.height;
    if (sx < 0) {
      sourceWidth += sx;
      sx = 0;
    }
    if (sy < 0) {
      sourceHeight += sy;
      sy = 0;
    }
    sourceWidth = Math.min(sourceWidth, image.width - sx);
    sourceHeight = Math.min(sourceHeight, image.height - sy);
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      throw new Error(
        'Invalid calculated crop size (<=0). Element may not be visible or fully captured.',
      );
    }

    const canvasWidth = requestedWidthPx ?? Math.ceil(sourceWidth);
    const canvasHeight = requestedHeightPx ?? Math.ceil(sourceHeight);
    assertPixelDimensions(
      canvasWidth,
      canvasHeight,
      SCREENSHOT_LIMITS.MAX_TARGET_PIXELS,
      'Cropped screenshot canvas',
    );

    const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Unable to get canvas context');
    }
    ctx.drawImage(image, sx, sy, sourceWidth, sourceHeight, 0, 0, canvasWidth, canvasHeight);
    return canvas;
  } finally {
    image?.close();
  }
}

/** Convert a bounded canvas to a bounded data URL. */
export async function canvasToDataURL(
  canvas: OffscreenCanvas,
  format: string = 'image/png',
  quality?: number,
): Promise<string> {
  assertPixelDimensions(
    canvas.width,
    canvas.height,
    SCREENSHOT_LIMITS.MAX_TARGET_PIXELS,
    'Encoded screenshot canvas',
  );
  const blob = await canvas.convertToBlob({
    type: format,
    quality: format === 'image/jpeg' ? quality : undefined,
  });
  assertBlobCanEncodeAsDataUrl(blob, 'Screenshot');

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to encode screenshot.'));
    reader.readAsDataURL(blob);
  });
  assertScreenshotDataUrl(dataUrl);
  return dataUrl;
}

/** Scale and encode an image for transport/storage without permitting expansion. */
export async function compressImage(
  imageDataUrl: string,
  options: {
    scale?: number;
    quality?: number;
    format?: 'image/jpeg' | 'image/webp';
  },
): Promise<{ dataUrl: string; mimeType: string }> {
  const { scale = 1.0, quality = 0.8, format = 'image/jpeg' } = options;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new Error('Image compression scale must be greater than 0 and no more than 1.');
  }
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new Error('Image compression quality must be between 0 and 1.');
  }

  let imageBitmap: ImageBitmap | undefined;
  try {
    imageBitmap = await createImageBitmapFromUrl(imageDataUrl);
    const newWidth = Math.max(1, Math.round(imageBitmap.width * scale));
    const newHeight = Math.max(1, Math.round(imageBitmap.height * scale));
    assertPixelDimensions(
      newWidth,
      newHeight,
      SCREENSHOT_LIMITS.MAX_TARGET_PIXELS,
      'Compressed screenshot canvas',
    );

    const canvas = new OffscreenCanvas(newWidth, newHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context from OffscreenCanvas');
    }
    ctx.drawImage(imageBitmap, 0, 0, newWidth, newHeight);
    const dataUrl = await canvasToDataURL(canvas, format, quality);
    return { dataUrl, mimeType: format };
  } finally {
    imageBitmap?.close();
  }
}
