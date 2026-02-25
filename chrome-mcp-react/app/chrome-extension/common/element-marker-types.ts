// Element marker types shared across background, content scripts, and popup

export type UrlMatchType = 'exact' | 'prefix' | 'host';

export interface ElementMarker {
  id: string;
  // Original URL where the marker was created
  url: string;
  // Normalized pieces to support matching
  origin: string; // scheme + host + port
  host: string; // hostname
  path: string; // pathname part only
  matchType: UrlMatchType; // default: 'prefix'

  name: string; // Human-friendly name, e.g., "Login Button"
  selector: string; // Selector string
  selectorType?: 'css' | 'xpath'; // Default: css
  listMode?: boolean; // Whether this marker was created in list mode (allows multiple matches)
  action?: 'click' | 'fill' | 'custom'; // Intended action hint (optional)

  createdAt: number;
  updatedAt: number;
}

export interface UpsertMarkerRequest {
  id?: string;
  url: string;
  name: string;
  selector: string;
  selectorType?: 'css' | 'xpath';
  listMode?: boolean;
  matchType?: UrlMatchType;
  action?: 'click' | 'fill' | 'custom';
}

// Validation actions for MCP-integrated verification
export enum MarkerValidationAction {
  Hover = 'hover',
  LeftClick = 'left_click',
  RightClick = 'right_click',
  DoubleClick = 'double_click',
  TypeText = 'type_text',
  PressKeys = 'press_keys',
  Scroll = 'scroll',
}

export interface MarkerValidationRequest {
  selector: string;
  selectorType?: 'css' | 'xpath';
  action: MarkerValidationAction;
  // Optional payload for certain actions
  text?: string; // for type_text
  keys?: string; // for press_keys
  // Event options for click-like actions
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  // Targeting options
  coordinates?: { x: number; y: number }; // absolute viewport coords
  offsetX?: number; // relative to element center if relativeTo = 'element'
  offsetY?: number;
  relativeTo?: 'element' | 'viewport';
  // Navigation options for click-like actions
  waitForNavigation?: boolean;
  timeoutMs?: number;
  // Scroll options
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number; // pixels per tick
}

export interface MarkerValidationResponse {
  success: boolean;
  resolved?: boolean;
  ref?: string;
  center?: { x: number; y: number };
  tool?: { name: string; ok: boolean; error?: string };
  error?: string;
}

export interface MarkerQuery {
  url?: string; // If present, query by URL match; otherwise list all
}
