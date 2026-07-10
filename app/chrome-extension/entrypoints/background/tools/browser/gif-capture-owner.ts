export type GifCaptureMode = 'fixed_fps' | 'auto_capture';

export interface GifCaptureOwner {
  readonly mode: GifCaptureMode;
  readonly tabId: number;
}

let activeOwner: GifCaptureOwner | null = null;

export function acquireGifCaptureOwner(
  mode: GifCaptureMode,
  tabId: number,
):
  | { ok: true; owner: GifCaptureOwner }
  | { ok: false; owner: GifCaptureOwner } {
  if (activeOwner) {
    return { ok: false, owner: activeOwner };
  }

  const owner = Object.freeze({ mode, tabId });
  activeOwner = owner;
  return { ok: true, owner };
}

export function getGifCaptureOwner(): GifCaptureOwner | null {
  return activeOwner;
}

export function isGifCaptureOwner(owner: GifCaptureOwner): boolean {
  return activeOwner === owner;
}

export function releaseGifCaptureOwner(owner: GifCaptureOwner): boolean {
  if (activeOwner !== owner) return false;
  activeOwner = null;
  return true;
}

export function describeGifCaptureOwner(owner: GifCaptureOwner): string {
  const mode = owner.mode === 'fixed_fps' ? 'fixed-FPS' : 'auto-capture';
  return `${mode} GIF capture is already active on tab ${owner.tabId}`;
}
