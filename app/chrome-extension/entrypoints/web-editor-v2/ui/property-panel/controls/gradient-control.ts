/**
 * Gradient Control
 *
 * Edits inline `background-image` gradients:
 * - linear-gradient(<angle>deg, <stop1>, <stop2>, ...)
 * - radial-gradient([<shape>] [at <x>% <y>%], <stop1>, <stop2>, ...)
 *
 * Supports:
 * - Multiple color stops (2+)
 * - Numeric angles (deg) and percent positions
 *
 * Current UI Limitation:
 * - UI currently edits only the first 2 stops (parser supports N stops)
 */

import { Disposer } from '../../../utils/disposables';
import type { StyleTransactionHandle, TransactionManager } from '../../../core/transaction-manager';
import type { DesignTokensService } from '../../../core/design-tokens';
import { createColorField, type ColorField } from './color-field';
import { wireNumberStepping } from './number-stepping';
import type { DesignControl } from '../types';

// =============================================================================
// Constants
// =============================================================================

const GRADIENT_TYPES = [
  { value: 'none', label: 'None' },
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
] as const;

type GradientType = (typeof GRADIENT_TYPES)[number]['value'];

const RADIAL_SHAPES = [
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'circle', label: 'Circle' },
] as const;

type RadialShape = (typeof RADIAL_SHAPES)[number]['value'];

const DEFAULT_LINEAR_ANGLE = 180;
const DEFAULT_POSITION = 50;

const DEFAULT_STOP_1: GradientStop = { color: '#000000', position: 0 };
const DEFAULT_STOP_2: GradientStop = { color: '#ffffff', position: 100 };

// =============================================================================
// Types
// =============================================================================

/** Unique identifier for a gradient stop (stable across reorder/edit) */
type StopId = string;

/** Model for a gradient stop with stable identity */
interface StopModel {
  id: StopId;
  color: string;
  position: number;
  /** Resolved/computed color for display when color contains var() */
  placeholderColor?: string;
}

/**
 * Drag session state for thumb dragging.
 * Tracks the active drag operation with all data needed for
 * real-time preview and rollback on cancel.
 */
interface ThumbDragSession {
  /** ID of the stop being dragged */
  stopId: StopId;
  /** Pointer identifier for the drag gesture (used to filter multi-touch) */
  pointerId: number;
  /** Position snapshot before drag started (for rollback on Escape) */
  initialPositions: Map<StopId, number>;
  /** The thumb element being dragged (for pointer capture) */
  thumbElement: HTMLElement;
}

/**
 * Keyboard session state for thumb stepping (Arrow keys).
 * Maintains a snapshot for Escape rollback and keeps thumbs stable during stepping.
 */
interface ThumbKeyboardSession {
  /** ID of the stop being adjusted */
  stopId: StopId;
  /** Position snapshot before stepping started (for rollback on Escape) */
  initialPositions: Map<StopId, number>;
  /** The thumb element being adjusted (focus anchor) */
  thumbElement: HTMLElement;
}

/** Basic gradient stop (used in parsing and UI state) */
interface GradientStop {
  color: string;
  position: number;
  /**
   * Resolved/computed color when `color` contains var().
   * Populated during sync when inline value contains CSS variables.
   */
  placeholderColor?: string;
}

interface ParsedLinearGradient {
  type: 'linear';
  angle: number;
  stops: GradientStop[];
}

interface ParsedRadialGradient {
  type: 'radial';
  shape: RadialShape;
  position: { x: number; y: number } | null;
  stops: GradientStop[];
}

type ParsedGradient = ParsedLinearGradient | ParsedRadialGradient;

interface ParsedStop {
  color: string;
  position: number | null;
}

// =============================================================================
// Helpers
// =============================================================================

let stopIdCounter = 0;

/**
 * Generate a unique stop ID using crypto.randomUUID when available,
 * falling back to a counter-based ID.
 */
function createStopId(): StopId {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fallback to counter
  }
  stopIdCounter += 1;
  return `stop_${stopIdCounter}_${Date.now()}`;
}

/** Create default stop models with unique IDs */
function createDefaultStopModels(): StopModel[] {
  return [
    { id: createStopId(), color: DEFAULT_STOP_1.color, position: DEFAULT_STOP_1.position },
    { id: createStopId(), color: DEFAULT_STOP_2.color, position: DEFAULT_STOP_2.position },
  ];
}

/** Convert GradientStop[] to StopModel[] (assigns new IDs) */
function toStopModels(stops: GradientStop[]): StopModel[] {
  return stops.map((s) => ({
    id: createStopId(),
    color: s.color,
    position: s.position,
    placeholderColor: s.placeholderColor,
  }));
}

/**
 * Reconcile new stops with existing models to preserve stable IDs.
 * Uses index-based matching when stop count is the same, otherwise creates new models.
 */
function reconcileStopModels(prevModels: StopModel[], newStops: GradientStop[]): StopModel[] {
  // If count matches, preserve IDs by index
  if (prevModels.length === newStops.length) {
    return newStops.map((stop, i) => ({
      id: prevModels[i]?.id ?? createStopId(),
      color: stop.color,
      position: stop.position,
      placeholderColor: stop.placeholderColor,
    }));
  }

  // Count mismatch: create fresh models
  return toStopModels(newStops);
}

/** Get the preview color for a stop (resolved color if contains var(), otherwise raw color) */
function getStopPreviewColor(stop: Pick<StopModel, 'color' | 'placeholderColor'>): string {
  if (needsColorPlaceholder(stop.color)) {
    const c = stop.placeholderColor?.trim();
    return c ? c : 'transparent';
  }
  return stop.color;
}

/** Convert StopModel[] to GradientStop[] for preview rendering */
function toPreviewStops(stops: StopModel[]): GradientStop[] {
  return stops.map((s) => ({
    color: getStopPreviewColor(s),
    position: s.position,
  }));
}

// =============================================================================
// Color Interpolation (Phase 6)
// =============================================================================

/** RGBA color representation for interpolation */
interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Clamp a value to byte range [0, 255] */
function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Convert a byte value to 2-digit hex string */
function toHexByte(value: number): string {
  return clampByte(value).toString(16).padStart(2, '0');
}

/** Convert RGBA to CSS color string (hex or rgba) */
function rgbaToCss(color: RgbaColor): string {
  const a = clampNumber(color.a, 0, 1);
  if (a >= 1) {
    return `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}`;
  }
  const alpha = Math.round(a * 1000) / 1000;
  return `rgba(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}, ${alpha})`;
}

/** Parse hex color (#RGB, #RGBA, #RRGGBB, #RRGGBBAA) to RGBA */
function parseHexColorToRgba(raw: string): RgbaColor | null {
  const v = raw.trim().toLowerCase();
  if (!v.startsWith('#')) return null;

  // #RGB
  if (/^#[0-9a-f]{3}$/.test(v)) {
    const r = Number.parseInt(v[1]! + v[1]!, 16);
    const g = Number.parseInt(v[2]! + v[2]!, 16);
    const b = Number.parseInt(v[3]! + v[3]!, 16);
    return { r, g, b, a: 1 };
  }

  // #RGBA
  if (/^#[0-9a-f]{4}$/.test(v)) {
    const r = Number.parseInt(v[1]! + v[1]!, 16);
    const g = Number.parseInt(v[2]! + v[2]!, 16);
    const b = Number.parseInt(v[3]! + v[3]!, 16);
    const a = Number.parseInt(v[4]! + v[4]!, 16) / 255;
    return { r, g, b, a };
  }

  // #RRGGBB
  if (/^#[0-9a-f]{6}$/.test(v)) {
    const r = Number.parseInt(v.slice(1, 3), 16);
    const g = Number.parseInt(v.slice(3, 5), 16);
    const b = Number.parseInt(v.slice(5, 7), 16);
    return { r, g, b, a: 1 };
  }

  // #RRGGBBAA
  if (/^#[0-9a-f]{8}$/.test(v)) {
    const r = Number.parseInt(v.slice(1, 3), 16);
    const g = Number.parseInt(v.slice(3, 5), 16);
    const b = Number.parseInt(v.slice(5, 7), 16);
    const a = Number.parseInt(v.slice(7, 9), 16) / 255;
    return { r, g, b, a };
  }

  return null;
}

/** Parse RGB channel value (number or percentage) */
function parseRgbChannel(token: string): number | null {
  const t = token.trim();
  if (!t) return null;

  if (t.endsWith('%')) {
    const n = Number(t.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return clampByte((n / 100) * 255);
  }

  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return clampByte(n);
}

/** Parse alpha channel value (number or percentage) */
function parseAlphaChannel(token: string): number | null {
  const t = token.trim();
  if (!t) return null;

  if (t.endsWith('%')) {
    const n = Number(t.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return clampNumber(n / 100, 0, 1);
  }

  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return clampNumber(n, 0, 1);
}

/** Parse rgb()/rgba() color to RGBA (supports legacy and modern syntax) */
function parseRgbColorToRgba(raw: string): RgbaColor | null {
  const trimmed = raw.trim();
  if (!/^rgba?\(/i.test(trimmed)) return null;

  const openIndex = trimmed.indexOf('(');
  const closeIndex = trimmed.lastIndexOf(')');
  if (openIndex < 0 || closeIndex < openIndex) return null;

  const inner = trimmed.slice(openIndex + 1, closeIndex).trim();
  if (!inner) return null;

  let channelsPart = inner;
  let alphaPart: string | null = null;

  // Modern syntax: rgb(0 0 0 / 0.5)
  const slashIndex = inner.indexOf('/');
  if (slashIndex !== -1) {
    channelsPart = inner.slice(0, slashIndex).trim();
    alphaPart = inner.slice(slashIndex + 1).trim();
  }

  // Split by comma (legacy) or whitespace (modern)
  const channelTokens = channelsPart.includes(',')
    ? channelsPart
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : channelsPart
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean);

  if (channelTokens.length < 3) return null;

  const r = parseRgbChannel(channelTokens[0]!);
  const g = parseRgbChannel(channelTokens[1]!);
  const b = parseRgbChannel(channelTokens[2]!);
  if (r === null || g === null || b === null) return null;

  let a = 1;

  // Legacy rgba(r,g,b,a) comma syntax
  if (!alphaPart && channelTokens.length >= 4) {
    alphaPart = channelTokens[3]!;
  }

  if (alphaPart) {
    const parsedA = parseAlphaChannel(alphaPart);
    if (parsedA !== null) a = parsedA;
  }

  return { r, g, b, a };
}

/** Linear interpolation between two numbers */
function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate between two RGBA colors */
function interpolateRgba(a: RgbaColor, b: RgbaColor, t: number): RgbaColor {
  const clampedT = clampNumber(t, 0, 1);
  return {
    r: lerpNumber(a.r, b.r, clampedT),
    g: lerpNumber(a.g, b.g, clampedT),
    b: lerpNumber(a.b, b.b, clampedT),
    a: lerpNumber(a.a, b.a, clampedT),
  };
}

function isFieldFocused(el: HTMLElement): boolean {
  try {
    const rootNode = el.getRootNode();
    if (rootNode instanceof ShadowRoot) return rootNode.activeElement === el;
    return document.activeElement === el;
  } catch {
    return false;
  }
}

function readInlineValue(element: Element, property: string): string {
  try {
    const style = (element as HTMLElement).style;
    return style?.getPropertyValue?.(property)?.trim() ?? '';
  } catch {
    return '';
  }
}

function readComputedValue(element: Element, property: string): string {
  try {
    return window.getComputedStyle(element).getPropertyValue(property).trim();
  } catch {
    return '';
  }
}

function isNoneValue(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || trimmed.toLowerCase() === 'none';
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseAngleToken(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(-?(?:\d+\.?\d*|\.\d+))\s*deg$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function parsePercentToken(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(-?(?:\d+\.?\d*|\.\d+))\s*%$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse X position keyword (left/center/right or %)
 */
function parsePositionX(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const pct = parsePercentToken(trimmed);
  if (pct !== null) return pct;

  if (trimmed === 'center') return 50;
  if (trimmed === 'left') return 0;
  if (trimmed === 'right') return 100;

  return null;
}

/**
 * Parse Y position keyword (top/center/bottom or %)
 */
function parsePositionY(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const pct = parsePercentToken(trimmed);
  if (pct !== null) return pct;

  if (trimmed === 'center') return 50;
  if (trimmed === 'top') return 0;
  if (trimmed === 'bottom') return 100;

  return null;
}

/**
 * Check if a token is an X-axis keyword
 */
function isXKeyword(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return lower === 'left' || lower === 'right';
}

/**
 * Check if a token is a Y-axis keyword
 */
function isYKeyword(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return lower === 'top' || lower === 'bottom';
}

function clampAngle(value: number): number {
  return clampNumber(value, 0, 360);
}

function clampPercent(value: number): number {
  return clampNumber(value, 0, 100);
}

/**
 * Split a CSS value by a separator, respecting parentheses and quotes
 */
function splitTopLevel(value: string, separator: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escape = false;
  let start = 0;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      continue;
    }

    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0 && ch === separator) {
      results.push(value.slice(start, i));
      start = i + 1;
    }
  }

  results.push(value.slice(start));
  return results;
}

/**
 * Tokenize a CSS value by whitespace, respecting parentheses and quotes
 */
function tokenizeTopLevel(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escape = false;
  let buffer = '';

  const flush = () => {
    const t = buffer.trim();
    if (t) tokens.push(t);
    buffer = '';
  };

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    if (escape) {
      buffer += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      buffer += ch;
      escape = true;
      continue;
    }

    if (quote) {
      buffer += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      buffer += ch;
      quote = ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      buffer += ch;
      continue;
    }

    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      buffer += ch;
      continue;
    }

    if (depth === 0 && /\s/.test(ch)) {
      flush();
      continue;
    }

    buffer += ch;
  }

  flush();
  return tokens;
}

function parseColorStop(raw: string): ParsedStop | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const tokens = tokenizeTopLevel(trimmed);
  if (tokens.length === 0) return null;

  const color = tokens[0] ?? '';
  if (!color) return null;

  let position: number | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const p = parsePercentToken(tokens[i] ?? '');
    if (p !== null) {
      position = p;
      break;
    }
  }

  return { color, position };
}

/**
 * Normalize stop positions following CSS gradient specification:
 * - First stop defaults to 0%, last stop defaults to 100%
 * - Enforces monotonically non-decreasing positions (CSS spec)
 * - Missing positions are distributed evenly between defined positions
 * - All positions are clamped to 0..100
 *
 * @param stops - Parsed stops with optional positions
 * @returns Normalized stops with all positions defined
 */
function normalizeStopPositions(stops: ParsedStop[]): GradientStop[] {
  if (stops.length === 0) return [];
  if (stops.length === 1) {
    return [
      {
        color: stops[0]!.color.trim() || DEFAULT_STOP_1.color,
        position: clampPercent(stops[0]!.position ?? 0),
      },
    ];
  }

  // Extract colors and initial positions
  const colors = stops.map((s) => s.color.trim() || DEFAULT_STOP_1.color);
  const positions: Array<number | null> = stops.map((s) =>
    s.position === null ? null : clampPercent(s.position),
  );

  // Default first position to 0 if not defined
  if (positions[0] === null) {
    positions[0] = 0;
  }

  // Default last position to 100 if not defined
  const lastIndex = positions.length - 1;
  if (positions[lastIndex] === null) {
    positions[lastIndex] = 100;
  }

  // CSS spec: Enforce monotonically non-decreasing positions
  // If a later explicit position is less than an earlier one, bump it up
  let maxSoFar = positions[0] ?? 0;
  for (let i = 1; i < positions.length; i++) {
    const pos = positions[i];
    if (pos !== null) {
      if (pos < maxSoFar) {
        positions[i] = maxSoFar;
      } else {
        maxSoFar = pos;
      }
    }
  }

  // Fill in missing positions by linear interpolation
  // Find runs of null positions and distribute them evenly
  let runStart: number | null = null;

  for (let i = 0; i < positions.length; i++) {
    if (positions[i] === null) {
      if (runStart === null) {
        runStart = i;
      }
    } else {
      if (runStart !== null) {
        // Fill the run from runStart to i-1
        const prevPos = positions[runStart - 1] ?? 0;
        const nextPos = positions[i] ?? 100;
        const runLength = i - runStart + 1;

        for (let j = runStart; j < i; j++) {
          const t = (j - runStart + 1) / runLength;
          positions[j] = prevPos + (nextPos - prevPos) * t;
        }
        runStart = null;
      }
    }
  }

  return stops.map((_, i) => ({
    color: colors[i]!,
    position: clampPercent(positions[i] ?? 0),
  }));
}

/**
 * Legacy normalize function for backward compatibility
 * @deprecated Use normalizeStopPositions for N stops
 */
function normalizeStops(stops: [ParsedStop, ParsedStop]): [GradientStop, GradientStop] {
  const normalized = normalizeStopPositions(stops);
  return [normalized[0] ?? { ...DEFAULT_STOP_1 }, normalized[1] ?? { ...DEFAULT_STOP_2 }];
}

function parseGradientFunctionCall(
  value: string,
): { kind: 'linear' | 'radial'; args: string } | null {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();

  let kind: 'linear' | 'radial' | null = null;
  let fnName = '';

  if (lower.startsWith('linear-gradient')) {
    kind = 'linear';
    fnName = 'linear-gradient';
  } else if (lower.startsWith('radial-gradient')) {
    kind = 'radial';
    fnName = 'radial-gradient';
  } else {
    return null;
  }

  let i = fnName.length;
  while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
  if (trimmed[i] !== '(') return null;

  const openIndex = i;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let j = openIndex; j < trimmed.length; j++) {
    const ch = trimmed[j]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      continue;
    }

    if (ch === ')') {
      depth--;
      if (depth === 0) {
        // Check no trailing content
        const trailing = trimmed.slice(j + 1).trim();
        if (trailing) return null;

        const args = trimmed.slice(openIndex + 1, j);
        return { kind, args };
      }
    }
  }

  return null;
}

function parseLinearGradient(args: string): ParsedLinearGradient | null {
  const parts = splitTopLevel(args, ',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Need at least 2 color stops
  if (parts.length < 2) return null;

  const firstPart = parts[0] ?? '';
  const firstLower = firstPart.toLowerCase();

  // Reject unsupported direction keywords: "to left", "to right", "to top", etc.
  // These are valid CSS but we only support angle-based linear gradients
  if (firstLower.startsWith('to ')) {
    return null;
  }

  // Check if first part is an angle
  const maybeAngle = parseAngleToken(firstPart);

  let angle = DEFAULT_LINEAR_ANGLE;
  let stopStartIndex = 0;

  if (maybeAngle !== null) {
    // Format: linear-gradient(angle, stop1, stop2, ...)
    if (parts.length < 3) return null;
    angle = maybeAngle;
    stopStartIndex = 1;
  }

  // Parse all color stops
  const stopParts = parts.slice(stopStartIndex);
  const parsedStops: ParsedStop[] = [];

  for (const raw of stopParts) {
    const stop = parseColorStop(raw);
    if (!stop) return null;
    parsedStops.push(stop);
  }

  // Must have at least 2 stops
  if (parsedStops.length < 2) return null;

  return {
    type: 'linear',
    angle: clampAngle(angle),
    stops: normalizeStopPositions(parsedStops),
  };
}

/** Size keywords we don't support - return null to show as "none" */
const UNSUPPORTED_RADIAL_SIZE_KEYWORDS = new Set([
  'closest-side',
  'farthest-side',
  'closest-corner',
  'farthest-corner',
]);

function parseRadialGradient(args: string): ParsedRadialGradient | null {
  const parts = splitTopLevel(args, ',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length < 2) return null;

  let shape: RadialShape = 'ellipse';
  let position: { x: number; y: number } | null = null;
  let stopStartIndex = 0;

  const first = parts[0] ?? '';
  const tokens = tokenizeTopLevel(first);
  const lowerTokens = tokens.map((t) => t.toLowerCase());

  // Reject unsupported size keywords - valid CSS but we only support basic shapes
  for (const token of lowerTokens) {
    if (UNSUPPORTED_RADIAL_SIZE_KEYWORDS.has(token)) {
      return null;
    }
  }

  const atIndex = lowerTokens.indexOf('at');
  const hasAt = atIndex >= 0;

  const hasCircle = lowerTokens.includes('circle');
  const hasEllipse = lowerTokens.includes('ellipse');
  const hasShape = hasCircle || hasEllipse;

  if (hasShape || hasAt) {
    stopStartIndex = 1;

    if (hasCircle) shape = 'circle';
    else if (hasEllipse) shape = 'ellipse';

    if (hasAt) {
      const token1 = tokens[atIndex + 1] ?? '';
      const token2 = tokens[atIndex + 2] ?? '';

      // Handle position parsing with axis awareness
      // CSS allows "at top right" (Y then X) or "at right top" (X then Y)
      let x: number | null = null;
      let y: number | null = null;

      // Check if first token is a Y keyword (top/bottom)
      if (isYKeyword(token1)) {
        // "at top" or "at top right" - first is Y
        y = parsePositionY(token1);
        x = token2 ? parsePositionX(token2) : null;
      } else if (isXKeyword(token1)) {
        // "at left" or "at left top" - first is X
        x = parsePositionX(token1);
        y = token2 ? parsePositionY(token2) : null;
      } else {
        // Default: treat as "X Y" order (most common for percentages)
        x = parsePositionX(token1);
        y = token2 ? parsePositionY(token2) : null;
      }

      position = {
        x: clampPercent(x ?? DEFAULT_POSITION),
        y: clampPercent(y ?? DEFAULT_POSITION),
      };
    }
  }

  // Parse all color stops
  const stopParts = parts.slice(stopStartIndex);
  const parsedStops: ParsedStop[] = [];

  for (const raw of stopParts) {
    const stop = parseColorStop(raw);
    if (!stop) return null;
    parsedStops.push(stop);
  }

  // Must have at least 2 stops
  if (parsedStops.length < 2) return null;

  return {
    type: 'radial',
    shape,
    position,
    stops: normalizeStopPositions(parsedStops),
  };
}

function parseGradient(value: string): ParsedGradient | null {
  const fn = parseGradientFunctionCall(value);
  if (!fn) return null;
  return fn.kind === 'linear' ? parseLinearGradient(fn.args) : parseRadialGradient(fn.args);
}

function needsColorPlaceholder(value: string): boolean {
  return /\bvar\s*\(/i.test(value);
}

/**
 * Build placeholder color mapping from inline stops to computed stops.
 * Uses nearest-neighbor matching by stop position (0..100).
 * This handles cases where normalization may produce slightly different positions.
 *
 * @param inlineStops - Stops parsed from inline CSS (may contain var())
 * @param computedStops - Stops parsed from computed CSS (resolved colors)
 * @returns Array of placeholder colors aligned to inlineStops indices
 */
function buildPlaceholderMapping(
  inlineStops: GradientStop[],
  computedStops: GradientStop[],
): string[] {
  if (inlineStops.length === 0 || computedStops.length === 0) {
    return [];
  }

  return inlineStops.map((inlineStop) => {
    let nearestStop = computedStops[0]!;
    let minDistance = Math.abs(nearestStop.position - inlineStop.position);

    for (let i = 1; i < computedStops.length; i++) {
      const candidate = computedStops[i]!;
      const distance = Math.abs(candidate.position - inlineStop.position);
      if (distance < minDistance) {
        nearestStop = candidate;
        minDistance = distance;
      }
    }

    return nearestStop.color;
  });
}

// =============================================================================
// Factory
// =============================================================================

export interface GradientControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
  /** Optional: Design tokens service for TokenPill/TokenPicker integration (Phase 5.3) */
  tokensService?: DesignTokensService;
  /**
   * CSS property to write the gradient value to.
   * Defaults to 'background-image'.
   * Use 'border-image-source' for border gradient support.
   */
  property?: string;
  /**
   * Whether to show the 'None' option in the gradient type selector.
   * Defaults to true.
   * Set to false for text gradient mode where 'none' would make text invisible.
   */
  allowNone?: boolean;
}

export function createGradientControl(options: GradientControlOptions): DesignControl {
  const {
    container,
    transactionManager,
    tokensService,
    property: cssProperty = 'background-image',
    allowNone = true,
  } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;
  // Default type is 'linear' when allowNone is false, otherwise 'none'
  let currentType: GradientType = allowNone ? 'none' : 'linear';

  // Current stops array - supports N stops with stable identity
  let currentStops: StopModel[] = createDefaultStopModels();
  let selectedStopId: StopId | null = currentStops[0]?.id ?? null;

  // Active thumb drag session (null when not dragging)
  let thumbDrag: ThumbDragSession | null = null;

  // Active thumb keyboard session (null when not stepping via arrow keys)
  let thumbKeyboard: ThumbKeyboardSession | null = null;

  let backgroundHandle: StyleTransactionHandle | null = null;

  // Root container
  const root = document.createElement('div');
  root.className = 'we-field-group';

  // -------------------------------------------------------------------------
  // DOM Construction Helpers
  // -------------------------------------------------------------------------

  function createInputRow(
    labelText: string,
    ariaLabel: string,
  ): { row: HTMLDivElement; input: HTMLInputElement } {
    const row = document.createElement('div');
    row.className = 'we-field';

    const label = document.createElement('span');
    label.className = 'we-field-label';
    label.textContent = labelText;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'we-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.inputMode = 'decimal';
    input.setAttribute('aria-label', ariaLabel);

    row.append(label, input);
    return { row, input };
  }

  function createSelectRow(
    labelText: string,
    ariaLabel: string,
    values: readonly { value: string; label: string }[],
  ): { row: HTMLDivElement; select: HTMLSelectElement } {
    const row = document.createElement('div');
    row.className = 'we-field';

    const label = document.createElement('span');
    label.className = 'we-field-label';
    label.textContent = labelText;

    const select = document.createElement('select');
    select.className = 'we-select';
    select.setAttribute('aria-label', ariaLabel);

    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v.value;
      opt.textContent = v.label;
      select.append(opt);
    }

    row.append(label, select);
    return { row, select };
  }

  // -------------------------------------------------------------------------
  // Create UI Elements
  // -------------------------------------------------------------------------

  // Build gradient type options based on allowNone parameter
  const gradientTypeOptions = allowNone
    ? GRADIENT_TYPES
    : GRADIENT_TYPES.filter((t) => t.value !== 'none');

  const { row: typeRow, select: typeSelect } = createSelectRow(
    'Type',
    'Gradient Type',
    gradientTypeOptions,
  );

  // Gradient preview bar
  const gradientBarRow = document.createElement('div');
  gradientBarRow.className = 'we-gradient-bar-row';

  const gradientBar = document.createElement('div');
  gradientBar.className = 'we-gradient-bar';
  gradientBar.setAttribute('aria-label', 'Gradient preview');

  // Thumb container layer (Phase 4C) - positioned over gradient
  const gradientThumbs = document.createElement('div');
  gradientThumbs.className = 'we-gradient-bar-thumbs';
  gradientBar.append(gradientThumbs);

  gradientBarRow.append(gradientBar);

  const { row: angleRow, input: angleInput } = createInputRow('Angle', 'Gradient Angle (deg)');
  angleInput.placeholder = String(DEFAULT_LINEAR_ANGLE);

  const { row: shapeRow, select: shapeSelect } = createSelectRow(
    'Shape',
    'Radial Gradient Shape',
    RADIAL_SHAPES,
  );

  const { row: posXRow, input: posXInput } = createInputRow('Position X', 'Radial Position X (%)');
  const { row: posYRow, input: posYInput } = createInputRow('Position Y', 'Radial Position Y (%)');

  // Stops list header + list (Phase 4D) - read-only + selection sync
  const stopsHeaderRow = document.createElement('div');
  stopsHeaderRow.className = 'we-gradient-stops-header';

  const stopsHeaderLabel = document.createElement('span');
  stopsHeaderLabel.className = 'we-gradient-stops-title';
  stopsHeaderLabel.textContent = 'Stops';

  const stopsAddBtn = document.createElement('button');
  stopsAddBtn.type = 'button';
  stopsAddBtn.className = 'we-icon-btn we-gradient-stops-add';
  stopsAddBtn.setAttribute('aria-label', 'Add stop');
  stopsAddBtn.disabled = false;
  stopsAddBtn.textContent = '+';

  stopsHeaderRow.append(stopsHeaderLabel, stopsAddBtn);

  const stopsList = document.createElement('div');
  stopsList.className = 'we-gradient-stops-list';
  stopsList.setAttribute('role', 'list');

  root.append(
    typeRow,
    gradientBarRow,
    angleRow,
    shapeRow,
    posXRow,
    posYRow,
    stopsHeaderRow,
    stopsList,
  );
  container.append(root);
  disposer.add(() => root.remove());

  // Wire keyboard stepping for numeric inputs
  wireNumberStepping(disposer, angleInput, {
    mode: 'number',
    min: 0,
    max: 360,
    step: 1,
    shiftStep: 15,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, posXInput, {
    mode: 'number',
    min: 0,
    max: 100,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, posYInput, {
    mode: 'number',
    min: 0,
    max: 100,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });

  // ---------------------------------------------------------------------------
  // Single Position Input bound to selectedStopId (Phase 7)
  // Host is re-parented into the selected row's position editor slot.
  // ---------------------------------------------------------------------------
  const selectedStopPosHost = document.createElement('div');

  const selectedStopPosInput = document.createElement('input');
  selectedStopPosInput.type = 'text';
  selectedStopPosInput.className = 'we-gradient-stop-pos-input';
  selectedStopPosInput.autocomplete = 'off';
  selectedStopPosInput.spellcheck = false;
  selectedStopPosInput.inputMode = 'decimal';
  selectedStopPosInput.placeholder = '0';
  selectedStopPosInput.setAttribute('aria-label', 'Selected Stop Position (%)');
  selectedStopPosHost.append(selectedStopPosInput);

  // Enable keyboard stepping (↑/↓ to increment/decrement)
  wireNumberStepping(disposer, selectedStopPosInput, {
    mode: 'number',
    min: 0,
    max: 100,
    step: 1,
    shiftStep: 10,
  });

  /**
   * Commit the position edit: sort stops and finalize the transaction.
   * Called on blur or Enter key.
   */
  function commitSelectedStopPosition(): void {
    // Commit-time sort ensures CSS output is monotonically ordered
    sortCurrentStopsByPosition();

    // Only commit if we have an active transaction
    if (backgroundHandle) {
      previewGradient();
      commitTransaction();
    }
    syncAllFields();
  }

  /**
   * Cancel the position edit and rollback to the original value.
   * Called on Escape key.
   */
  function cancelSelectedStopPosition(): void {
    rollbackTransaction();
    syncAllFields(true);
  }

  // Handle input changes - update model and preview in real-time
  disposer.listen(selectedStopPosInput, 'input', () => {
    const id = selectedStopId;
    if (!id) return;

    const parsed = parseNumber(selectedStopPosInput.value);
    if (parsed === null) return;

    // Update model and preview in real-time
    setStopPositionById(id, parsed);
    previewGradient();
  });

  // Commit on blur
  disposer.listen(selectedStopPosInput, 'blur', commitSelectedStopPosition);

  // Handle Enter/Escape keys
  disposer.listen(selectedStopPosInput, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitSelectedStopPosition();
      selectedStopPosInput.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelSelectedStopPosition();
    }
  });

  // Single ColorField bound to selectedStopId (Phase 4E)
  // Host is re-parented into the selected row's editor slot.
  const selectedStopColorHost = document.createElement('div');

  const selectedStopColorField: ColorField = createColorField({
    container: selectedStopColorHost,
    ariaLabel: 'Selected Stop Color',
    tokensService,
    getTokenTarget: () => currentTarget,
    onInput: (value) => {
      const id = selectedStopId;
      if (!id) return;

      const index = currentStops.findIndex((s) => s.id === id);
      if (index < 0) return;

      // Update model
      currentStops[index]!.color = value;

      // Update placeholder when switching away from var()
      selectedStopColorField.setPlaceholder(
        needsColorPlaceholder(value) ? (currentStops[index]!.placeholderColor ?? '') : '',
      );

      previewGradient();
    },
    onCommit: () => {
      commitTransaction();
      syncAllFields();
    },
    onCancel: () => {
      rollbackTransaction();
      syncAllFields(true);
    },
  });
  disposer.add(() => selectedStopColorField.dispose());

  // -------------------------------------------------------------------------
  // Transaction Management
  // -------------------------------------------------------------------------

  function beginTransaction(): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;

    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    if (backgroundHandle) return backgroundHandle;

    backgroundHandle = transactionManager.beginStyle(target, cssProperty);
    return backgroundHandle;
  }

  function commitTransaction(): void {
    const handle = backgroundHandle;
    backgroundHandle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(): void {
    const handle = backgroundHandle;
    backgroundHandle = null;
    if (handle) handle.rollback();
  }

  // -------------------------------------------------------------------------
  // UI State Helpers
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Thumb Drag Helpers (Phase 5)
  // -------------------------------------------------------------------------

  /**
   * Update a stop's position by its ID.
   * Used during drag to update the model in real-time.
   */
  function setStopPositionById(stopId: StopId, position: number): void {
    const index = currentStops.findIndex((s) => s.id === stopId);
    if (index < 0) return;

    const clamped = clampPercent(position);
    currentStops[index]!.position = clamped;
  }

  /**
   * Restore all stop positions from a snapshot map.
   * Used when canceling a drag operation (Escape key).
   */
  function restoreStopPositions(snapshot: Map<StopId, number>): void {
    for (const stop of currentStops) {
      const savedPos = snapshot.get(stop.id);
      if (savedPos !== undefined) {
        stop.position = savedPos;
      }
    }
  }

  /**
   * End the current thumb drag session and clean up.
   * Commits or rolls back the transaction based on the outcome.
   *
   * @param commit - If true, commit changes; if false, rollback to initial state
   */
  function endThumbDrag(commit: boolean): void {
    const session = thumbDrag;
    if (!session) return;

    thumbDrag = null;

    // Remove dragging visual state
    gradientBar.classList.remove('we-gradient-bar--dragging');
    session.thumbElement.classList.remove('we-gradient-thumb--dragging');

    // Best-effort: release capture (e.g., Escape cancel while pointer is still down)
    try {
      session.thumbElement.releasePointerCapture(session.pointerId);
    } catch {
      // Pointer capture may already be released or never set
    }

    if (commit) {
      // Commit-time sort ensures CSS output is monotonically ordered
      sortCurrentStopsByPosition();

      // Update preview with sorted positions before committing
      previewGradient();
      commitTransaction();
      syncAllFields();
    } else {
      // Restore positions before rolling back
      restoreStopPositions(session.initialPositions);
      rollbackTransaction();
      syncAllFields(true);
    }
  }

  /**
   * Calculate the position percentage from a pointer event relative to the gradient bar.
   * Returns a value clamped to 0-100.
   */
  function calculatePositionFromPointer(clientX: number): number {
    const rect = gradientBar.getBoundingClientRect();
    if (rect.width <= 0) return 0;

    const relativeX = clientX - rect.left;
    const rawPercent = (relativeX / rect.width) * 100;
    return clampPercent(rawPercent);
  }

  // -------------------------------------------------------------------------
  // Thumb Keyboard Stepping (Phase 9)
  // -------------------------------------------------------------------------

  /**
   * Start a keyboard stepping session for a thumb.
   * Similar to drag session but triggered by arrow keys.
   */
  function startThumbKeyboardSession(stopId: StopId, thumbElement: HTMLElement): void {
    if (thumbDrag) return;
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    // If session already exists for this stop, don't restart
    if (thumbKeyboard?.stopId === stopId) return;

    // If switching stops, commit previous session first
    if (thumbKeyboard) {
      endThumbKeyboard(true);
    }

    // Snapshot all positions for potential rollback
    const initialPositions = new Map<StopId, number>();
    for (const stop of currentStops) {
      initialPositions.set(stop.id, stop.position);
    }

    thumbKeyboard = { stopId, initialPositions, thumbElement };
    beginTransaction();
  }

  /**
   * End the keyboard stepping session.
   * @param commit - If true, commit changes; if false, rollback to initial state
   */
  function endThumbKeyboard(commit: boolean): void {
    const session = thumbKeyboard;
    if (!session) return;
    thumbKeyboard = null;

    if (commit) {
      // Commit-time sort keeps CSS output monotonic
      sortCurrentStopsByPosition();
      previewGradient();
      commitTransaction();
      syncAllFields();
    } else {
      restoreStopPositions(session.initialPositions);
      rollbackTransaction();
      syncAllFields(true);
    }
  }

  /**
   * Handle focus on a thumb - select the corresponding stop.
   */
  function handleThumbFocus(event: FocusEvent): void {
    if (thumbDrag) return;
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    const thumb = event.currentTarget as HTMLElement;
    const stopId = thumb.dataset.stopId;
    if (!stopId) return;

    if (selectedStopId !== stopId) {
      selectedStopId = stopId;
      // Preserve thumbs to avoid focus loss during selection sync
      updateGradientBar({ preserveThumbs: true });
    }
  }

  /**
   * Handle blur on a thumb - commit any active keyboard session.
   */
  function handleThumbBlur(event: FocusEvent): void {
    const session = thumbKeyboard;
    if (!session) return;

    // Only commit if blur is from the session's thumb
    const thumb = event.currentTarget as HTMLElement;
    if (thumb !== session.thumbElement) return;

    // Commit on blur (similar to input field behavior)
    endThumbKeyboard(true);
  }

  /**
   * Handle keydown on a thumb - arrow keys for stepping, Escape for cancel.
   */
  function handleThumbKeyDown(event: KeyboardEvent): void {
    // Preserve navigation shortcuts (Cmd/Ctrl + Arrow for cursor movement)
    if (event.metaKey || event.ctrlKey) return;
    if (thumbDrag) return;
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    const thumb = event.currentTarget as HTMLElement;
    const stopId = thumb.dataset.stopId;
    if (!stopId) return;

    // Escape cancels the keyboard session
    if (event.key === 'Escape') {
      const session = thumbKeyboard;
      if (!session || session.stopId !== stopId) return;
      event.preventDefault();
      event.stopPropagation();
      endThumbKeyboard(false);
      return;
    }

    // Handle arrow keys for position adjustment
    const isArrow =
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight' ||
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown';
    if (!isArrow) return;

    event.preventDefault();
    event.stopPropagation();

    // ArrowLeft/ArrowDown: decrease, ArrowRight/ArrowUp: increase
    // Shift modifier: step by 10 instead of 1
    const sign = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1;
    const step = event.shiftKey ? 10 : 1;
    const delta = sign * step;

    // Ensure stop is selected and session is active
    selectedStopId = stopId;
    startThumbKeyboardSession(stopId, thumb);

    const idx = currentStops.findIndex((s) => s.id === stopId);
    if (idx < 0) return;

    setStopPositionById(stopId, currentStops[idx]!.position + delta);
    previewGradient();
  }

  /**
   * Sync slider ARIA attributes on a thumb element.
   * Provides accessible name and value for screen readers.
   */
  function syncThumbSliderAria(thumb: HTMLElement, position: number): void {
    const clamped = clampPercent(position);
    const rounded = Math.round(clamped * 100) / 100;
    const value = Object.is(rounded, -0) ? 0 : rounded;

    thumb.setAttribute('role', 'slider');
    thumb.setAttribute('aria-label', 'Gradient stop position');
    thumb.setAttribute('aria-valuemin', '0');
    thumb.setAttribute('aria-valuemax', '100');
    thumb.setAttribute('aria-valuenow', String(value));
    thumb.setAttribute('aria-valuetext', `${value}%`);
    thumb.setAttribute('aria-orientation', 'horizontal');
  }

  // -------------------------------------------------------------------------
  // Stop Add/Delete (Phase 6)
  // -------------------------------------------------------------------------

  // Hidden probe element used to resolve CSS colors for interpolation
  const stopColorProbe = document.createElement('div');
  stopColorProbe.style.cssText =
    'position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none;opacity:0';
  root.append(stopColorProbe);
  disposer.add(() => stopColorProbe.remove());

  /**
   * Resolve any CSS color string to RGBA using browser color parsing.
   * Handles hex, rgb(), rgba(), named colors, currentColor, etc.
   */
  function resolveCssColorToRgba(raw: string): RgbaColor | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    if (lower === 'transparent') {
      return { r: 0, g: 0, b: 0, a: 0 };
    }

    // Try direct parsing first (faster for common formats)
    const fromHex = parseHexColorToRgba(trimmed);
    if (fromHex) return fromHex;

    const fromRgb = parseRgbColorToRgba(trimmed);
    if (fromRgb) return fromRgb;

    // Fall back to browser color parsing via computed style
    try {
      stopColorProbe.style.color = '';
      stopColorProbe.style.color = trimmed;
      if (!stopColorProbe.style.color) return null;
      const computed = getComputedStyle(stopColorProbe).color;
      return parseRgbColorToRgba(computed);
    } catch {
      return null;
    }
  }

  /**
   * Keep stop order monotonic by position for correct CSS output.
   * CSS gradients do not reorder stops; out-of-order positions get clamped.
   * Tie-breaks by original insertion order (array index) for stability.
   */
  function sortCurrentStopsByPosition(): void {
    if (currentStops.length <= 1) return;
    const indexed = currentStops.map((stop, index) => ({ stop, index }));
    indexed.sort((a, b) => a.stop.position - b.stop.position || a.index - b.index);
    currentStops = indexed.map((entry) => entry.stop);
  }

  /**
   * Interpolate a new stop's color based on its position.
   * Finds the left and right bounding stops and linearly interpolates.
   */
  function interpolateNewStopColor(position: number): string {
    const clamped = clampPercent(position);
    const models = currentStops.length >= 2 ? currentStops : createDefaultStopModels();
    if (models.length === 0) return DEFAULT_STOP_1.color;

    // Sort by position to find bounding stops
    const sorted = models.slice().sort((a, b) => a.position - b.position);
    let left = sorted[0]!;
    let right = sorted[sorted.length - 1]!;

    for (const stop of sorted) {
      if (stop.position <= clamped) left = stop;
      if (stop.position >= clamped) {
        right = stop;
        break;
      }
    }

    // Resolve preview colors (handles var() references)
    const leftRgba = resolveCssColorToRgba(getStopPreviewColor(left));
    const rightRgba = resolveCssColorToRgba(getStopPreviewColor(right));

    if (!leftRgba && !rightRgba) {
      return left.color.trim() || DEFAULT_STOP_1.color;
    }
    if (!leftRgba) return rgbaToCss(rightRgba!);
    if (!rightRgba) return rgbaToCss(leftRgba);

    const span = right.position - left.position;
    if (!Number.isFinite(span) || span <= 0) {
      return rgbaToCss(leftRgba);
    }

    const t = clampNumber((clamped - left.position) / span, 0, 1);
    return rgbaToCss(interpolateRgba(leftRgba, rightRgba, t));
  }

  /**
   * Get a suggested position for adding a new stop.
   * Returns the midpoint between the selected stop and its next neighbor.
   */
  function getSuggestedAddStopPosition(): number {
    const selectedId = selectedStopId;
    if (!selectedId) return DEFAULT_POSITION;

    const models = currentStops.length >= 2 ? currentStops : createDefaultStopModels();
    const sorted = models.slice().sort((a, b) => a.position - b.position);
    const index = sorted.findIndex((s) => s.id === selectedId);
    if (index < 0) return DEFAULT_POSITION;

    const current = sorted[index]!;
    const next = sorted[index + 1];
    const prev = sorted[index - 1];

    // Prefer midpoint toward the right (next), then toward the left (prev)
    if (next) return clampPercent((current.position + next.position) / 2);
    if (prev) return clampPercent((prev.position + current.position) / 2);
    return DEFAULT_POSITION;
  }

  /**
   * Find the stop ID closest to a given position.
   * Used to select a neighbor after deletion.
   * Tie-breaks toward the right (higher position).
   */
  function pickClosestStopId(position: number): StopId | null {
    if (currentStops.length === 0) return null;

    let best = currentStops[0]!;
    let bestDistance = Math.abs(best.position - position);

    for (let i = 1; i < currentStops.length; i++) {
      const candidate = currentStops[i]!;
      const distance = Math.abs(candidate.position - position);

      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
        continue;
      }

      // Tie-break: prefer stop on the right side
      if (distance === bestDistance) {
        const candidateOnRight = candidate.position >= position;
        const bestOnRight = best.position >= position;
        if (candidateOnRight && !bestOnRight) {
          best = candidate;
        }
      }
    }

    return best.id;
  }

  /**
   * Add a new stop at the specified position with interpolated color.
   * Auto-selects the new stop after adding.
   */
  function addStopAtPosition(position: number, opts: { focusColor?: boolean } = {}): void {
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    const clamped = clampPercent(position);
    const newStop: StopModel = {
      id: createStopId(),
      position: clamped,
      color: interpolateNewStopColor(clamped),
    };

    currentStops.push(newStop);
    selectedStopId = newStop.id;
    sortCurrentStopsByPosition();

    previewGradient();
    commitTransaction();

    if (opts.focusColor) {
      queueMicrotask(() => {
        const input = selectedStopColorHost.querySelector<HTMLInputElement>('input.we-color-text');
        input?.focus();
      });
    }
  }

  /**
   * Remove a stop by its ID.
   * Enforces minimum 2 stops constraint.
   * Auto-selects the closest neighbor after deletion.
   */
  function removeStopById(stopId: StopId): void {
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    // Enforce minimum 2 stops constraint
    if (currentStops.length <= 2) return;

    const index = currentStops.findIndex((s) => s.id === stopId);
    if (index < 0) return;

    const removed = currentStops[index]!;
    currentStops.splice(index, 1);

    // Auto-select closest neighbor if we deleted the selected stop
    if (selectedStopId === stopId) {
      selectedStopId = pickClosestStopId(removed.position);
      if (!selectedStopId) {
        selectedStopId = currentStops[0]?.id ?? null;
      }
    }

    sortCurrentStopsByPosition();
    previewGradient();
    commitTransaction();
  }

  /**
   * Check if an event target is a text input-like element.
   * Used to avoid capturing Delete/Backspace when user is editing text.
   */
  function isTextInputLike(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  /**
   * Update the gradient preview bar background and thumb elements.
   * Uses buildPreviewBarCss() to render a horizontal (90deg) gradient.
   * Reads from current UI state (inputs) to ensure real-time sync during editing.
   *
   * @param options.refreshStopsList - Set to false to skip stops list refresh (avoid re-mounting color field during editing)
   * @param options.preserveThumbs - Set to true to only update thumb positions without recreating elements (used during drag)
   */
  function updateGradientBar(
    options: { refreshStopsList?: boolean; preserveThumbs?: boolean } = {},
  ): void {
    const refreshStopsList = options.refreshStopsList ?? true;
    const preserveThumbs = options.preserveThumbs ?? false;

    if (currentType === 'none') {
      gradientBar.style.backgroundImage = 'none';
      gradientThumbs.textContent = '';
      if (refreshStopsList) updateStopsList([], [], []);
      return;
    }

    // Use collectCurrentStops() to get stops based on current UI input values.
    // This ensures the preview bar updates in real-time while editing stop1/stop2.
    const stops = collectCurrentStops();
    if (stops.length === 0) {
      gradientBar.style.backgroundImage = 'none';
      gradientThumbs.textContent = '';
      if (refreshStopsList) updateStopsList([], [], []);
      return;
    }

    // Resolve placeholder colors for var() values from currentStops model
    const previewStops: GradientStop[] = stops.map((stop, i) => {
      const model = currentStops[i];
      const previewColor = needsColorPlaceholder(stop.color)
        ? model?.placeholderColor?.trim() || 'transparent'
        : stop.color;
      return { color: previewColor, position: stop.position };
    });

    gradientBar.style.backgroundImage = buildPreviewBarCss(previewStops);

    // -------------------------------------------------------------------------
    // Thumbs (Phase 4C + Phase 5 drag support)
    // -------------------------------------------------------------------------

    const models = currentStops.length >= 2 ? currentStops : createDefaultStopModels();

    // Ensure selectedStopId points to a valid model
    if (!selectedStopId || !models.some((s) => s.id === selectedStopId)) {
      selectedStopId = models[0]?.id ?? null;
    }

    // When preserveThumbs is true (during drag), update existing thumbs in place
    // to maintain pointer capture. Otherwise, rebuild all thumbs.
    if (preserveThumbs) {
      // Update existing thumb positions and colors without recreating elements
      const existingThumbs = gradientThumbs.querySelectorAll<HTMLElement>('.we-gradient-thumb');
      for (const thumb of existingThumbs) {
        const stopId = thumb.dataset.stopId;
        if (!stopId) continue;

        const modelIndex = models.findIndex((m) => m.id === stopId);
        if (modelIndex < 0) continue;

        const stop = stops[modelIndex];
        const preview = previewStops[modelIndex];
        if (!stop || !preview) continue;

        // Update position and color
        thumb.style.left = `${clampPercent(stop.position)}%`;
        thumb.style.backgroundColor = preview.color;
        syncThumbSliderAria(thumb, stop.position);

        // Update active state
        const isActive = stopId === selectedStopId;
        thumb.classList.toggle('we-gradient-thumb--active', isActive);
      }
    } else {
      // Full rebuild: clear and recreate all thumbs
      gradientThumbs.textContent = '';

      for (let i = 0; i < stops.length; i++) {
        const model = models[i];
        const stop = stops[i];
        const preview = previewStops[i];
        if (!model || !stop || !preview) continue;

        const thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className =
          model.id === selectedStopId
            ? 'we-gradient-thumb we-gradient-thumb--active'
            : 'we-gradient-thumb';
        thumb.dataset.stopId = model.id;
        thumb.style.left = `${clampPercent(stop.position)}%`;
        thumb.style.backgroundColor = preview.color;
        syncThumbSliderAria(thumb, stop.position);

        // Pointer event handlers for drag (Phase 5)
        thumb.addEventListener('pointerdown', handleThumbPointerDown);

        // Keyboard and focus handlers (Phase 9)
        thumb.addEventListener('keydown', handleThumbKeyDown);
        thumb.addEventListener('focus', handleThumbFocus);
        thumb.addEventListener('blur', handleThumbBlur);

        gradientThumbs.append(thumb);
      }
    }

    // Stops list (Phase 4D) - skip during drag to avoid UI thrashing
    if (refreshStopsList && !preserveThumbs) {
      updateStopsList(models, stops, previewStops);
    }
  }

  // -------------------------------------------------------------------------
  // Thumb Drag Event Handlers (Phase 5)
  // -------------------------------------------------------------------------

  /**
   * Handle pointerdown on a thumb to start drag.
   * Sets up pointer capture and initializes the drag session.
   */
  function handleThumbPointerDown(event: PointerEvent): void {
    // Prevent re-entry if drag is already in progress
    if (thumbDrag) return;

    // Defensive: don't allow drag when disabled or none type
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    // Only respond to primary button (left click) and primary pointer
    if (event.button !== 0) return;
    if (!event.isPrimary) return;

    const thumb = event.currentTarget as HTMLElement;
    const stopId = thumb.dataset.stopId;
    if (!stopId) return;

    // If a keyboard stepping session is active, transition to drag
    // (share the same transaction handle)
    if (thumbKeyboard) {
      thumbKeyboard = null;
    }

    // Prevent default to avoid text selection, button activation, etc.
    event.preventDefault();
    event.stopPropagation();

    // Select this stop
    selectedStopId = stopId;

    // Snapshot all positions for potential rollback
    const initialPositions = new Map<StopId, number>();
    for (const stop of currentStops) {
      initialPositions.set(stop.id, stop.position);
    }

    // Start the drag session
    thumbDrag = {
      stopId,
      pointerId: event.pointerId,
      initialPositions,
      thumbElement: thumb,
    };

    // Add visual feedback - dragging thumb raised above others
    gradientBar.classList.add('we-gradient-bar--dragging');
    thumb.classList.add('we-gradient-thumb--dragging');

    // Capture pointer for reliable tracking outside element bounds
    try {
      thumb.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture may fail on some elements/browsers
    }

    // Begin transaction for live preview
    beginTransaction();

    // Update UI to show selected state
    updateGradientBar({ preserveThumbs: true, refreshStopsList: false });
  }

  /**
   * Handle pointermove during drag to update stop position.
   * Called on window (capture phase) to ensure we capture all movement.
   */
  function handleThumbPointerMove(event: PointerEvent): void {
    const session = thumbDrag;
    if (!session) return;
    if (event.pointerId !== session.pointerId) return;

    // Calculate new position from pointer location
    const newPosition = calculatePositionFromPointer(event.clientX);

    // Update model
    setStopPositionById(session.stopId, newPosition);

    // Live preview to element (updateGradientBar is called inside previewGradient)
    previewGradient();
  }

  /**
   * Handle pointerup to end drag and commit changes.
   */
  function handleThumbPointerUp(event: PointerEvent): void {
    const session = thumbDrag;
    if (!session) return;
    if (event.pointerId !== session.pointerId) return;

    // Commit the drag
    endThumbDrag(true);
  }

  /**
   * Handle pointercancel (e.g., touch interrupted) to cancel drag.
   */
  function handleThumbPointerCancel(event: PointerEvent): void {
    const session = thumbDrag;
    if (!session) return;
    if (event.pointerId !== session.pointerId) return;

    // Rollback the drag
    endThumbDrag(false);
  }

  /**
   * Handle keydown during drag to support Escape cancellation.
   */
  function handleDragKeyDown(event: KeyboardEvent): void {
    if (!thumbDrag) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      endThumbDrag(false);
    }
  }

  // Wire up window-level capture listeners for drag handling.
  // UI events are stopped at the ShadowHost root, so these must be capture-phase.
  const DRAG_LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: false };
  disposer.listen(window, 'pointermove', handleThumbPointerMove, DRAG_LISTENER_OPTIONS);
  disposer.listen(window, 'pointerup', handleThumbPointerUp, DRAG_LISTENER_OPTIONS);
  disposer.listen(window, 'pointercancel', handleThumbPointerCancel, DRAG_LISTENER_OPTIONS);
  disposer.listen(window, 'keydown', handleDragKeyDown, DRAG_LISTENER_OPTIONS);

  /**
   * Render stops list and sync selection with selectedStopId.
   * Clicking a row selects the stop and refreshes thumbs via updateGradientBar().
   */
  function updateStopsList(
    models: StopModel[],
    stops: GradientStop[],
    previewStops: GradientStop[],
  ): void {
    stopsList.textContent = '';
    if (currentType === 'none') return;
    if (models.length === 0 || stops.length === 0) return;

    /**
     * Format position value for display (e.g., "50%")
     */
    const formatPercentValue = (value: number): number => {
      const clamped = clampPercent(value);
      const rounded = Math.round(clamped * 100) / 100;
      return Object.is(rounded, -0) ? 0 : rounded;
    };

    const formatPercentLabel = (value: number): string => `${formatPercentValue(value)}%`;

    // Build rows with original index for stable ordering
    const rows = stops
      .map((stop, index) => ({
        index,
        stop,
        model: models[index],
        preview: previewStops[index],
      }))
      .filter((r) => Boolean(r.model && r.preview))
      .sort((a, b) => a.stop.position - b.stop.position || a.index - b.index);

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const r = rows[rowIndex]!;
      const model = r.model!;
      const stop = r.stop;
      const preview = r.preview!;
      const isActive = model.id === selectedStopId;

      const row = document.createElement('div');
      row.className = isActive
        ? 'we-gradient-stop-row we-gradient-stop-row--active'
        : 'we-gradient-stop-row';
      row.dataset.stopId = model.id;
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.setAttribute('aria-label', `Select stop at ${formatPercentLabel(stop.position)}`);

      // Position column (Phase 7: static + editor dual-mode)
      const pos = document.createElement('div');
      pos.className = 'we-gradient-stop-pos';

      // Static display (shown when not selected)
      const posStatic = document.createElement('span');
      posStatic.className = 'we-gradient-stop-pos-static';
      posStatic.textContent = formatPercentLabel(stop.position);

      // Position editor slot (shown when selected)
      const posEditor = document.createElement('div');
      posEditor.className = 'we-gradient-stop-pos-editor';

      if (isActive) {
        posEditor.append(selectedStopPosHost);
        // Avoid resetting while user is typing
        if (!isPositionInputFocused()) {
          selectedStopPosInput.value = String(formatPercentValue(stop.position));
        }
      }

      pos.append(posStatic, posEditor);

      // Color column
      const color = document.createElement('div');
      color.className = 'we-gradient-stop-color';

      // Static color display (shown when not selected)
      const colorStatic = document.createElement('button');
      colorStatic.type = 'button';
      colorStatic.className = 'we-gradient-stop-color-static';
      colorStatic.tabIndex = -1;
      colorStatic.setAttribute('aria-label', 'Select stop');

      const swatch = document.createElement('span');
      swatch.className = 'we-gradient-stop-swatch';
      swatch.style.backgroundColor = preview.color;

      const text = document.createElement('span');
      text.className = 'we-gradient-stop-color-text';
      text.textContent = stop.color.trim() || DEFAULT_STOP_1.color;

      colorStatic.append(swatch, text);

      // Color editor slot (shown when selected)
      const colorEditor = document.createElement('div');
      colorEditor.className = 'we-gradient-stop-color-editor';

      if (isActive) {
        colorEditor.append(selectedStopColorHost);
        // Avoid resetting while user is typing
        if (!selectedStopColorField.isFocused()) {
          selectedStopColorField.setValue(stop.color);
          selectedStopColorField.setPlaceholder(
            needsColorPlaceholder(stop.color) ? (model.placeholderColor ?? '') : '',
          );
        }
      }

      color.append(colorStatic, colorEditor);

      // Remove button (Phase 6)
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'we-icon-btn we-gradient-stop-remove';
      removeBtn.setAttribute('aria-label', 'Remove stop');
      // Disable if we can't remove (only 2 stops remaining or control is disabled)
      const canRemove = !typeSelect.disabled && models.length > 2;
      removeBtn.disabled = !canRemove;
      removeBtn.textContent = '–';

      removeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeStopById(model.id);
      });

      // Focus helpers for position and color inputs
      const focusSelectedPosInput = () => {
        queueMicrotask(() => {
          selectedStopPosInput.focus();
          selectedStopPosInput.select();
        });
      };

      const focusSelectedColorField = () => {
        queueMicrotask(() => {
          const input =
            selectedStopColorHost.querySelector<HTMLInputElement>('input.we-color-text');
          input?.focus();
        });
      };

      // Click to select (with optional focus target)
      const selectThisRow = (opts?: { focusColor?: boolean; focusPosition?: boolean }) => {
        selectedStopId = model.id;
        updateGradientBar();
        if (opts?.focusColor) focusSelectedColorField();
        if (opts?.focusPosition) focusSelectedPosInput();
      };

      row.addEventListener('click', (event) => {
        if (model.id === selectedStopId) return;
        event.preventDefault();
        selectThisRow();
      });

      row.addEventListener('keydown', (event: KeyboardEvent) => {
        // Don't hijack keys while user is editing text inputs inside the row
        if (isTextInputLike(event.target)) return;

        // Arrow key navigation between rows (Phase 9)
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          event.stopPropagation();

          const nextIndex =
            event.key === 'ArrowUp'
              ? Math.max(0, rowIndex - 1)
              : Math.min(rows.length - 1, rowIndex + 1);
          if (nextIndex === rowIndex) return;

          const nextModel = rows[nextIndex]?.model;
          if (!nextModel) return;

          selectedStopId = nextModel.id;
          updateGradientBar();

          // Focus the next row after DOM update
          queueMicrotask(() => {
            const nextRow = stopsList.querySelector<HTMLElement>(
              `.we-gradient-stop-row[data-stop-id="${nextModel.id}"]`,
            );
            nextRow?.focus();
          });
          return;
        }

        // Enter/Space to select (only if not already selected)
        if (model.id !== selectedStopId && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          selectThisRow();
        }
      });

      // Clicking the position area selects and focuses the position editor
      posStatic.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (model.id === selectedStopId) {
          focusSelectedPosInput();
          return;
        }
        selectThisRow({ focusPosition: true });
      });

      // Clicking the color static area selects and focuses the color editor
      colorStatic.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (model.id === selectedStopId) {
          focusSelectedColorField();
          return;
        }
        selectThisRow({ focusColor: true });
      });

      row.append(pos, color, removeBtn);
      stopsList.append(row);
    }
  }

  function updateRowVisibility(): void {
    gradientBarRow.hidden = currentType === 'none';
    angleRow.hidden = currentType !== 'linear';
    shapeRow.hidden = currentType !== 'radial';
    posXRow.hidden = currentType !== 'radial';
    posYRow.hidden = currentType !== 'radial';
    stopsHeaderRow.hidden = currentType === 'none';
    stopsList.hidden = currentType === 'none';
    stopsAddBtn.disabled = typeSelect.disabled || currentType === 'none';
  }

  function setAllDisabled(disabled: boolean): void {
    typeSelect.disabled = disabled;
    angleInput.disabled = disabled;
    shapeSelect.disabled = disabled;
    posXInput.disabled = disabled;
    posYInput.disabled = disabled;
    stopsAddBtn.disabled = disabled;
    selectedStopPosInput.disabled = disabled || currentType === 'none';
    selectedStopColorField.setDisabled(disabled || currentType === 'none');
  }

  function resetDefaults(options: { skipPreview?: boolean } = {}): void {
    angleInput.value = String(DEFAULT_LINEAR_ANGLE);
    shapeSelect.value = 'ellipse';
    posXInput.value = '';
    posYInput.value = '';

    // Reset stops array with new models (fresh IDs)
    currentStops = createDefaultStopModels();
    selectedStopId = currentStops[0]?.id ?? null;

    if (!options.skipPreview) {
      updateGradientBar();
    }
  }

  /**
   * Check if the position input is currently focused.
   * Used to prevent list re-rendering while editing.
   */
  function isPositionInputFocused(): boolean {
    return isFieldFocused(selectedStopPosInput);
  }

  function isEditing(): boolean {
    return (
      backgroundHandle !== null ||
      isFieldFocused(typeSelect) ||
      isFieldFocused(angleInput) ||
      isFieldFocused(shapeSelect) ||
      isFieldFocused(posXInput) ||
      isFieldFocused(posYInput) ||
      isPositionInputFocused() ||
      selectedStopColorField.isFocused()
    );
  }

  // -------------------------------------------------------------------------
  // Formatting / Live Preview
  // -------------------------------------------------------------------------

  /**
   * Format stops array as CSS color-stop list
   */
  function formatStopList(stops: GradientStop[]): string {
    return stops
      .map((s) => {
        const color = s.color.trim() || DEFAULT_STOP_1.color;
        const pos = clampPercent(s.position);
        return `${color} ${pos}%`;
      })
      .join(', ');
  }

  /**
   * Build CSS gradient string for writing back to element (background-image).
   * Uses current UI input values for angle (linear) or shape/position (radial).
   *
   * @param stops - The gradient stops to include
   * @returns CSS gradient string (e.g., "linear-gradient(45deg, #fff 0%, #000 100%)")
   */
  function buildElementGradientCss(stops: GradientStop[]): string {
    if (currentType === 'none' || stops.length === 0) {
      return 'none';
    }

    const stopsText = formatStopList(stops);

    if (currentType === 'linear') {
      const angle = clampAngle(parseNumber(angleInput.value) ?? DEFAULT_LINEAR_ANGLE);
      return `linear-gradient(${angle}deg, ${stopsText})`;
    }

    // Radial gradient
    const shape = (shapeSelect.value as RadialShape) || 'ellipse';
    const rawX = posXInput.value.trim();
    const rawY = posYInput.value.trim();
    const hasPosition = Boolean(rawX || rawY);

    if (!hasPosition) {
      return `radial-gradient(${shape}, ${stopsText})`;
    }

    const x = clampPercent(parseNumber(rawX) ?? DEFAULT_POSITION);
    const y = clampPercent(parseNumber(rawY) ?? DEFAULT_POSITION);
    return `radial-gradient(${shape} at ${x}% ${y}%, ${stopsText})`;
  }

  /**
   * Build CSS for the preview bar UI.
   * Always outputs a horizontal 90deg linear-gradient regardless of actual gradient type.
   * This provides a consistent left-to-right preview of stop positions and colors.
   *
   * @param stops - The gradient stops to preview
   * @returns CSS linear-gradient string with 90deg angle
   */
  function buildPreviewBarCss(stops: GradientStop[]): string {
    if (stops.length === 0) {
      return 'linear-gradient(90deg, transparent, transparent)';
    }
    const stopsText = formatStopList(stops);
    return `linear-gradient(90deg, ${stopsText})`;
  }

  /**
   * Collect current stops from UI state, merging UI values for edited stops
   * with preserved values for additional stops.
   * Returns GradientStop[] for CSS generation (strips id field).
   */
  function collectCurrentStops(): GradientStop[] {
    const baseStops = currentStops.length >= 2 ? currentStops : createDefaultStopModels();
    return baseStops.map((s) => ({
      color: s.color.trim() || DEFAULT_STOP_1.color,
      position: clampPercent(s.position),
    }));
  }

  /**
   * Build the current gradient value for writing to element
   */
  function buildGradientValue(): string {
    if (currentType === 'none') return 'none';
    const stops = collectCurrentStops();
    return buildElementGradientCss(stops);
  }

  function previewGradient(): void {
    if (disposer.isDisposed) return;

    // Avoid re-rendering stops list while dragging, keyboard stepping, or editing stop editors,
    // otherwise thumbs may lose pointer capture/focus and inputs can lose focus/caret.
    const isDragging = thumbDrag !== null;
    const isKeyboardStepping = thumbKeyboard !== null;
    const isEditingStopFields = selectedStopColorField.isFocused() || isPositionInputFocused();
    updateGradientBar({
      preserveThumbs: isDragging || isKeyboardStepping,
      refreshStopsList: isDragging || isKeyboardStepping ? false : !isEditingStopFields,
    });

    const target = currentTarget;
    if (!target || !target.isConnected) return;

    const handle = beginTransaction();
    if (!handle) return;

    handle.set(buildGradientValue());
  }

  // -------------------------------------------------------------------------
  // Sync (Render from Element State)
  // -------------------------------------------------------------------------

  function syncAllFields(force = false): void {
    const target = currentTarget;

    if (!target || !target.isConnected) {
      setAllDisabled(true);
      // Use 'linear' as default when 'none' is not allowed
      const defaultType = allowNone ? 'none' : 'linear';
      currentType = defaultType;
      typeSelect.value = defaultType;
      resetDefaults();
      updateRowVisibility();
      updateGradientBar();
      return;
    }

    setAllDisabled(false);

    if (isEditing() && !force) return;

    const inlineValue = readInlineValue(target, cssProperty);
    const needsComputed = !inlineValue || /\bvar\s*\(/i.test(inlineValue);
    const computedValue = needsComputed ? readComputedValue(target, cssProperty) : '';

    const inlineParsed = !isNoneValue(inlineValue) ? parseGradient(inlineValue) : null;
    const computedParsed = !isNoneValue(computedValue) ? parseGradient(computedValue) : null;

    let parsed: ParsedGradient | null = null;
    let source: 'inline' | 'computed' | 'none' = 'none';

    if (inlineValue.trim()) {
      if (isNoneValue(inlineValue)) {
        parsed = null;
        source = 'none';
      } else if (inlineParsed) {
        parsed = inlineParsed;
        source = 'inline';
      } else {
        // Has value but couldn't parse - treat as none for our UI
        parsed = null;
        source = 'none';
      }
    } else {
      if (isNoneValue(computedValue)) {
        parsed = null;
        source = 'none';
      } else if (computedParsed) {
        parsed = computedParsed;
        source = 'computed';
      } else {
        parsed = null;
        source = 'none';
      }
    }

    resetDefaults({ skipPreview: true });

    if (!parsed) {
      // Use 'linear' as default when 'none' is not allowed
      const defaultType = allowNone ? 'none' : 'linear';
      currentType = defaultType;
      typeSelect.value = defaultType;
      updateRowVisibility();
      updateGradientBar();
      return;
    }

    // Convert parsed stops to StopModel[] with stable IDs
    const rawStops: GradientStop[] =
      parsed.stops.length >= 2
        ? parsed.stops.slice()
        : [{ ...DEFAULT_STOP_1 }, { ...DEFAULT_STOP_2 }];

    // Apply placeholder mapping for var() values using nearest-neighbor matching
    const hasVarInInline = source === 'inline' && needsColorPlaceholder(inlineValue);
    if (hasVarInInline && computedParsed) {
      const placeholderColors = buildPlaceholderMapping(rawStops, computedParsed.stops);
      for (let i = 0; i < rawStops.length; i++) {
        rawStops[i]!.placeholderColor = placeholderColors[i] ?? '';
      }
    }

    // Reconcile with existing models to preserve stable IDs
    currentStops = reconcileStopModels(currentStops, rawStops);

    // Select first stop by default if nothing selected or selection is invalid
    if (!selectedStopId || !currentStops.some((s) => s.id === selectedStopId)) {
      selectedStopId = currentStops[0]?.id ?? null;
    }

    if (parsed.type === 'linear') {
      currentType = 'linear';
      typeSelect.value = 'linear';
      angleInput.value = String(parsed.angle);
    } else {
      currentType = 'radial';
      typeSelect.value = 'radial';
      shapeSelect.value = parsed.shape;
      if (parsed.position) {
        posXInput.value = String(parsed.position.x);
        posYInput.value = String(parsed.position.y);
      } else {
        posXInput.value = '';
        posYInput.value = '';
      }
    }

    updateRowVisibility();
    updateGradientBar();
  }

  // -------------------------------------------------------------------------
  // Event Wiring
  // -------------------------------------------------------------------------

  function wireTextInput(input: HTMLInputElement): void {
    disposer.listen(input, 'input', previewGradient);

    disposer.listen(input, 'blur', () => {
      commitTransaction();
      syncAllFields();
    });

    disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction();
        syncAllFields();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction();
        syncAllFields(true);
      }
    });
  }

  function wireSelect(select: HTMLSelectElement, onPreview?: () => void): void {
    const preview = () => {
      onPreview?.();
      previewGradient();
    };

    disposer.listen(select, 'input', preview);
    disposer.listen(select, 'change', preview);

    disposer.listen(select, 'blur', () => {
      commitTransaction();
      syncAllFields();
    });

    disposer.listen(select, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction();
        syncAllFields();
        select.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction();
        syncAllFields(true);
      }
    });
  }

  wireSelect(typeSelect, () => {
    currentType = typeSelect.value as GradientType;
    updateRowVisibility();
  });

  wireSelect(shapeSelect);

  wireTextInput(angleInput);
  wireTextInput(posXInput);
  wireTextInput(posYInput);

  // -------------------------------------------------------------------------
  // Stop Add/Delete Interactions (Phase 6)
  // -------------------------------------------------------------------------

  // Add stop via header button
  disposer.listen(stopsAddBtn, 'click', (event: MouseEvent) => {
    event.preventDefault();
    if (stopsAddBtn.disabled) return;
    addStopAtPosition(getSuggestedAddStopPosition(), { focusColor: true });
  });

  // Add stop via double-click on gradient bar
  disposer.listen(gradientBar, 'dblclick', (event: MouseEvent) => {
    // Don't add if dragging or if control is disabled
    if (thumbDrag) return;
    if (currentType === 'none' || typeSelect.disabled) return;

    // Only add on "empty bar" double-click (ignore thumbs)
    const path = event.composedPath();
    if (
      path.some((el) => el instanceof HTMLElement && el.classList.contains('we-gradient-thumb'))
    ) {
      return;
    }

    event.preventDefault();
    addStopAtPosition(calculatePositionFromPointer(event.clientX), { focusColor: true });
  });

  // Delete stop via Delete/Backspace key
  disposer.listen(root, 'keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    if (thumbDrag) return;
    if (currentType === 'none' || typeSelect.disabled) return;

    const id = selectedStopId;
    if (!id) return;

    // Don't capture when user is editing text
    if (isTextInputLike(event.target)) return;

    // Only treat Delete/Backspace as stop deletion when the key event originates
    // from the stops UI (bar or list), to avoid surprising deletions elsewhere
    const path = event.composedPath();
    if (!path.includes(stopsList) && !path.includes(gradientBar)) return;

    event.preventDefault();
    event.stopPropagation();
    removeStopById(id);
  });

  // -------------------------------------------------------------------------
  // DesignControl Interface
  // -------------------------------------------------------------------------

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (element !== currentTarget) commitTransaction();
    currentTarget = element;
    syncAllFields(true);
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    syncAllFields();
  }

  function dispose(): void {
    commitTransaction();
    currentTarget = null;
    disposer.dispose();
  }

  // Initialize
  typeSelect.value = currentType;
  resetDefaults();
  updateRowVisibility();
  syncAllFields(true);

  return { setTarget, refresh, dispose };
}
