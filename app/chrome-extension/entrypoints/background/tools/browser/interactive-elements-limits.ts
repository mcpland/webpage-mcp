export const INTERACTIVE_ELEMENT_TYPES = [
  'button',
  'link',
  'input',
  'checkbox',
  'radio',
  'textarea',
  'select',
  'tab',
  'interactive',
] as const;

export const INTERACTIVE_ELEMENTS_LIMITS = {
  selectorBytes: 4 * 1024,
  textQueryBytes: 1024,
  typeCount: INTERACTIVE_ELEMENT_TYPES.length,
  resultCount: 200,
  resultJsonBytes: 512 * 1024,
  typeBytes: 64,
  textBytes: 1024,
  errorBytes: 4 * 1024,
} as const;

export interface NormalizedInteractiveElementsQuery {
  textQuery?: string;
  selector?: string;
  includeCoordinates: boolean;
  types?: string[];
}

export interface BoundedInteractiveElements {
  elements: Array<Record<string, unknown>>;
  truncated: boolean;
}

const TYPE_SET = new Set<string>(INTERACTIVE_ELEMENT_TYPES);

function utf8BytesForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function utf8ByteLengthBounded(
  value: string,
  stopAfter = Number.POSITIVE_INFINITY,
): number {
  let bytes = 0;
  for (const character of value) {
    bytes += utf8BytesForCodePoint(character.codePointAt(0) ?? 0);
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

export function truncateInteractiveString(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string') return '';
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const nextBytes = utf8BytesForCodePoint(character.codePointAt(0) ?? 0);
    if (bytes + nextBytes > maximumBytes) break;
    bytes += nextBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

function normalizeOptionalString(
  name: string,
  value: unknown,
  maximumBytes: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (
    normalized.length > maximumBytes ||
    utf8ByteLengthBounded(normalized, maximumBytes) > maximumBytes
  ) {
    throw new Error(`${name} exceeds the ${maximumBytes}-byte UTF-8 limit`);
  }
  return normalized;
}

export function normalizeInteractiveElementsQuery(
  value: unknown,
): NormalizedInteractiveElementsQuery {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const selector = normalizeOptionalString(
    'selector',
    input.selector,
    INTERACTIVE_ELEMENTS_LIMITS.selectorBytes,
  );
  if (selector && /:has\s*\(/iu.test(selector)) {
    throw new Error('selector must not use the resource-intensive :has() pseudo-class');
  }
  const textQuery = normalizeOptionalString(
    'textQuery',
    input.textQuery,
    INTERACTIVE_ELEMENTS_LIMITS.textQueryBytes,
  );

  let types: string[] | undefined;
  if (input.types !== undefined) {
    if (!Array.isArray(input.types)) throw new Error('types must be an array');
    if (input.types.length > INTERACTIVE_ELEMENTS_LIMITS.typeCount) {
      throw new Error(
        `types must contain no more than ${INTERACTIVE_ELEMENTS_LIMITS.typeCount} entries`,
      );
    }
    const unique = new Set<string>();
    for (const item of input.types) {
      if (typeof item !== 'string' || !TYPE_SET.has(item)) {
        const display =
          typeof item === 'string'
            ? truncateInteractiveString(item, INTERACTIVE_ELEMENTS_LIMITS.typeBytes)
            : typeof item;
        throw new Error(`Unsupported interactive element type: ${display}`);
      }
      unique.add(item);
    }
    types = [...unique];
  }

  return {
    ...(textQuery ? { textQuery } : {}),
    ...(selector ? { selector } : {}),
    includeCoordinates: input.includeCoordinates !== false,
    ...(types ? { types } : {}),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeCoordinates(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const x = finiteNumber(input.x);
  const y = finiteNumber(input.y);
  if (x === undefined || y === undefined) return undefined;
  const output: Record<string, unknown> = { x, y };
  if (input.rect && typeof input.rect === 'object') {
    const rawRect = input.rect as Record<string, unknown>;
    const rect: Record<string, number> = {};
    for (const key of ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left']) {
      const number = finiteNumber(rawRect[key]);
      if (number !== undefined) rect[key] = number;
    }
    if (Object.keys(rect).length > 0) output.rect = rect;
  }
  return output;
}

export function boundInteractiveElements(value: unknown, maximumCount?: number): BoundedInteractiveElements {
  const source = Array.isArray(value) ? value : [];
  const countLimit = Math.min(
    INTERACTIVE_ELEMENTS_LIMITS.resultCount,
    Math.max(0, maximumCount ?? INTERACTIVE_ELEMENTS_LIMITS.resultCount),
  );
  const elements: Array<Record<string, unknown>> = [];
  let bytes = 2;
  let truncated = source.length > countLimit;

  for (const item of source) {
    if (elements.length >= countLimit) {
      truncated = true;
      break;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      truncated = true;
      continue;
    }
    const input = item as Record<string, unknown>;
    const output: Record<string, unknown> = {
      type: truncateInteractiveString(input.type, INTERACTIVE_ELEMENTS_LIMITS.typeBytes) ||
        'unknown',
      selector: truncateInteractiveString(
        input.selector,
        INTERACTIVE_ELEMENTS_LIMITS.selectorBytes,
      ),
      text: truncateInteractiveString(input.text, INTERACTIVE_ELEMENTS_LIMITS.textBytes),
      isInteractive: input.isInteractive === true,
      disabled: input.disabled === true,
    };
    const coordinates = sanitizeCoordinates(input.coordinates);
    if (coordinates) output.coordinates = coordinates;
    if (typeof input.checked === 'boolean') output.checked = input.checked;
    const href = truncateInteractiveString(input.href, INTERACTIVE_ELEMENTS_LIMITS.selectorBytes);
    if (href) output.href = href;

    const candidateBytes = utf8ByteLengthBounded(JSON.stringify(output));
    if (
      bytes + candidateBytes + (elements.length > 0 ? 1 : 0) >
      INTERACTIVE_ELEMENTS_LIMITS.resultJsonBytes - 4096
    ) {
      truncated = true;
      break;
    }
    elements.push(output);
    bytes += candidateBytes + (elements.length > 1 ? 1 : 0);
  }

  return { elements, truncated };
}
