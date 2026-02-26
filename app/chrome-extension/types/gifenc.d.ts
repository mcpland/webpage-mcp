/**
 * Type declarations for gifenc library
 * @see https://github.com/mattdesl/gifenc
 */

declare module 'gifenc' {
  export interface GIFEncoderOptions {
    auto?: boolean;
  }

  export interface WriteFrameOptions {
    palette: number[];
    delay?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
  }

  export interface GIFEncoder {
    writeFrame(
      index: Uint8Array | Uint8ClampedArray,
      width: number,
      height: number,
      options: WriteFrameOptions,
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(options?: GIFEncoderOptions): GIFEncoder;

  export interface QuantizeOptions {
    format?: 'rgb565' | 'rgba4444' | 'rgb444';
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaColor?: number;
    clearAlphaThreshold?: number;
  }

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): number[];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[],
    format?: 'rgb565' | 'rgba4444' | 'rgb444',
  ): Uint8Array;

  export function nearestColorIndex(palette: number[], pixel: number[]): number;

  export function nearestColorIndexWithDistance(
    palette: number[],
    pixel: number[],
  ): [number, number];

  export function snapColorsToPalette(
    palette: number[],
    knownColors: number[][],
    threshold?: number,
  ): void;

  export function prequantize(
    rgba: Uint8Array | Uint8ClampedArray,
    options?: { roundRGB?: number; roundAlpha?: number; oneBitAlpha?: boolean | number },
  ): void;
}
