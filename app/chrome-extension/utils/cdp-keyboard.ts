/**
 * Keyboard input over CDP `Input.dispatchKeyEvent`.
 *
 * Blink derives editing behaviour (Backspace deleting, Enter submitting or
 * inserting a newline, arrow keys moving the caret) from `windowsVirtualKeyCode`
 * and `text`, not from `key`. Events without them reach JavaScript listeners
 * but have no default action. macOS additionally routes shortcuts such as
 * Cmd+A through editing commands that must be named explicitly.
 */

export type KeyModifier = 'alt' | 'ctrl' | 'meta' | 'shift';

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  /** Text produced by the key when no command modifier is held. */
  text?: string;
  /** Value of `key`/`text` while Shift is held (letters and US punctuation). */
  shiftKey?: string;
  location?: number;
}

export interface KeyStroke {
  modifiers: KeyModifier[];
  key: KeyDefinition;
}

export type KeyboardStep =
  | { kind: 'stroke'; stroke: KeyStroke; token: string }
  | { kind: 'text'; text: string };

export type DispatchKeyEvent = (params: Record<string, unknown>) => Promise<unknown>;

const MODIFIER_BITS: Record<KeyModifier, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const MODIFIER_ALIASES: Record<string, KeyModifier> = {
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  ctrl: 'ctrl',
  control: 'ctrl',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
  shift: 'shift',
};

const MODIFIER_KEYS: Record<KeyModifier, KeyDefinition> = {
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
};

const NAMED_KEYS: Record<string, KeyDefinition> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  del: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `f${index + 1}`,
      { key: `F${index + 1}`, code: `F${index + 1}`, keyCode: 112 + index },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(MODIFIER_ALIASES).map(([alias, modifier]) => [alias, MODIFIER_KEYS[modifier]]),
  ),
};

// US layout punctuation: unshifted character -> [code, keyCode, shifted character].
const PUNCTUATION: Array<[string, string, number, string]> = [
  ['`', 'Backquote', 192, '~'],
  ['-', 'Minus', 189, '_'],
  ['=', 'Equal', 187, '+'],
  ['[', 'BracketLeft', 219, '{'],
  [']', 'BracketRight', 221, '}'],
  ['\\', 'Backslash', 220, '|'],
  [';', 'Semicolon', 186, ':'],
  ["'", 'Quote', 222, '"'],
  [',', 'Comma', 188, '<'],
  ['.', 'Period', 190, '>'],
  ['/', 'Slash', 191, '?'],
];
const SHIFTED_DIGITS = ')!@#$%^&*(';

function characterKey(character: string): KeyDefinition | undefined {
  if (character.length !== 1) return undefined;
  const lower = character.toLowerCase();
  if (lower >= 'a' && lower <= 'z') {
    const upper = lower.toUpperCase();
    return {
      key: character,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: character,
      shiftKey: upper,
    };
  }
  if (character >= '0' && character <= '9') {
    return {
      key: character,
      code: `Digit${character}`,
      keyCode: character.charCodeAt(0),
      text: character,
      shiftKey: SHIFTED_DIGITS[Number(character)],
    };
  }
  const shiftedDigit = SHIFTED_DIGITS.indexOf(character);
  if (shiftedDigit >= 0) {
    return {
      key: character,
      code: `Digit${shiftedDigit}`,
      keyCode: 48 + shiftedDigit,
      text: character,
    };
  }
  for (const [plain, code, keyCode, shifted] of PUNCTUATION) {
    if (character === plain) return { key: plain, code, keyCode, text: plain, shiftKey: shifted };
    if (character === shifted) return { key: shifted, code, keyCode, text: shifted };
  }
  if (character === ' ') return NAMED_KEYS.space;
  return undefined;
}

function namedKey(token: string): KeyDefinition | undefined {
  return NAMED_KEYS[token.toLowerCase()];
}

function splitChordParts(token: string): string[] | null {
  if (!token.includes('+') || token === '+') return null;
  let body = token;
  let trailingPlus = false;
  if (body.endsWith('++')) {
    body = body.slice(0, -2);
    trailingPlus = true;
  }
  const parts = body.split('+').map((part) => part.trim());
  if (trailingPlus) parts.push('+');
  return parts.some((part) => part.length === 0) ? null : parts;
}

/**
 * Parse one token: a named key ("Enter"), a single character ("a"), or a chord
 * of modifiers plus a key ("Ctrl+Shift+Z", "cmd+a").
 */
export function parseKeyStroke(
  rawToken: string,
  options: { allowCharacter?: boolean } = {},
): KeyStroke | undefined {
  const token = rawToken.trim();
  if (!token) return undefined;
  const chord = splitChordParts(token);
  if (chord) {
    const modifiers: KeyModifier[] = [];
    for (const part of chord.slice(0, -1)) {
      const modifier = MODIFIER_ALIASES[part.toLowerCase()];
      if (!modifier) return undefined;
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
    }
    const last = chord[chord.length - 1];
    const lastModifier = MODIFIER_ALIASES[last.toLowerCase()];
    if (lastModifier) {
      // "Ctrl+Shift" presses the trailing modifier itself; avoid duplicating it if repeated.
      return {
        modifiers: modifiers.filter((modifier) => modifier !== lastModifier),
        key: MODIFIER_KEYS[lastModifier],
      };
    }
    const key = namedKey(last) ?? characterKey(last.length === 1 ? last : '');
    return key ? { modifiers, key } : undefined;
  }
  const named = namedKey(token);
  if (named) return { modifiers: [], key: named };
  if (options.allowCharacter !== false) {
    const character = characterKey(token);
    if (character) return { modifiers: [], key: character };
  }
  return undefined;
}

/**
 * Parse `chrome_keyboard` input. The whole input is a key sequence only when
 * every token is a key: commas separate keys/characters ("a,b,Enter"),
 * whitespace separates named keys and chords ("Ctrl+A Backspace"). Anything
 * else is literal text, so "Hello, World" is typed exactly as written.
 */
export function parseKeyboardInput(input: string): KeyboardStep[] {
  const trimmed = input.trim();
  if (!trimmed) return input ? [{ kind: 'text', text: input }] : [];
  // Do not silently strip surrounding spaces off a single literal character like " a ".
  const single = parseKeyStroke(trimmed, { allowCharacter: input === trimmed });
  if (single) return [{ kind: 'stroke', stroke: single, token: trimmed }];

  const rawCommaParts = input.includes(',') ? input.split(',').map((token) => token.trim()) : [];
  const commaTokens =
    rawCommaParts.length > 1 && rawCommaParts.every((token) => token.length > 0)
      ? rawCommaParts
      : [];
  const candidates: Array<{ tokens: string[]; allowCharacter: boolean }> = [];
  if (commaTokens.length > 1) candidates.push({ tokens: commaTokens, allowCharacter: true });
  const spaceTokens = trimmed.split(/\s+/).filter(Boolean);
  if (spaceTokens.length > 1) candidates.push({ tokens: spaceTokens, allowCharacter: false });

  for (const { tokens, allowCharacter } of candidates) {
    const strokes = tokens.map((token) => parseKeyStroke(token, { allowCharacter }));
    if (strokes.every(Boolean)) {
      return strokes.map((stroke, index) => ({
        kind: 'stroke' as const,
        stroke: stroke as KeyStroke,
        token: tokens[index],
      }));
    }
  }
  return [{ kind: 'text', text: input }];
}

/**
 * Parse an explicit key sequence (chrome_computer action=key): whitespace
 * separated named keys, chords, or single characters. Unknown tokens are
 * reported instead of being sent as meaningless key names.
 */
export function parseKeySequence(input: string): { strokes: KeyStroke[]; unknown: string[] } {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const strokes: KeyStroke[] = [];
  const unknown: string[] = [];
  for (const token of tokens) {
    const stroke = parseKeyStroke(token);
    if (stroke) strokes.push(stroke);
    else unknown.push(token);
  }
  return { strokes, unknown };
}

export function isMacPlatform(): boolean {
  try {
    const nav = (globalThis as { navigator?: any }).navigator;
    const platform = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '';
    return /mac/i.test(String(platform));
  } catch {
    return false;
  }
}

const EDITING_COMMANDS: Record<string, string> = {
  a: 'selectAll',
  c: 'copy',
  x: 'cut',
  v: 'paste',
  z: 'undo',
};

/**
 * Editing commands for the platform's primary shortcut modifier. Cmd shortcuts
 * never reach Blink's editor on macOS without them, and agents routinely mean
 * "select all" by either Ctrl+A or Cmd+A, so both are honoured on macOS and
 * Cmd+key is honoured elsewhere (Ctrl+key already works natively there).
 */
function editingCommandsFor(stroke: KeyStroke, mac: boolean): string[] {
  const { modifiers, key } = stroke;
  const letter = key.code.startsWith('Key') ? key.code.slice(3).toLowerCase() : '';
  const command = EDITING_COMMANDS[letter];
  if (!command) return [];
  const others = modifiers.filter((modifier) => modifier !== 'shift');
  if (others.length !== 1) return [];
  const primary = others[0];
  if (primary !== 'meta' && !(mac && primary === 'ctrl')) return [];
  if (modifiers.includes('shift')) return command === 'undo' ? ['redo'] : [];
  return [command];
}

const MODIFIER_BIT_BY_KEY = new Map<string, number>(
  (Object.keys(MODIFIER_KEYS) as KeyModifier[]).map((modifier) => [
    MODIFIER_KEYS[modifier].key,
    MODIFIER_BITS[modifier],
  ]),
);

export function modifierBitForKey(key: string): number {
  return MODIFIER_BIT_BY_KEY.get(key) ?? 0;
}

/** Press and release `stroke`, holding its modifiers around the key. */
export async function dispatchKeyStroke(
  dispatch: DispatchKeyEvent,
  stroke: KeyStroke,
  options: { mac?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  if (options.signal?.aborted) return;
  const mac = options.mac ?? isMacPlatform();
  let mask = 0;
  const pressedModifiers: KeyModifier[] = [];
  for (const modifier of stroke.modifiers) {
    if (options.signal?.aborted) break;
    mask |= MODIFIER_BITS[modifier];
    pressedModifiers.push(modifier);
    const definition = MODIFIER_KEYS[modifier];
    await dispatch({
      type: 'rawKeyDown',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      modifiers: mask,
      location: definition.location ?? 0,
    });
  }

  if (!options.signal?.aborted) {
    const { key } = stroke;
    const shifted = (mask & MODIFIER_BITS.shift) !== 0;
    // Characters are suppressed while Ctrl/Alt/Meta are held, as in a browser.
    const commandHeld = (mask & (MODIFIER_BITS.alt | MODIFIER_BITS.ctrl | MODIFIER_BITS.meta)) !== 0;
    // Chords like "Cmd+K" or "Ctrl+S" without Shift emit lowercase `key` in browsers.
    const keyValue =
      shifted && key.shiftKey
        ? key.shiftKey
        : commandHeld && !shifted && key.code.startsWith('Key')
          ? key.key.toLowerCase()
          : key.key;
    const text =
      key.text !== undefined && !commandHeld
        ? shifted && key.shiftKey
          ? key.shiftKey
          : key.text
        : undefined;
    const commands = editingCommandsFor(stroke, mac);
    const ownModifierBit = modifierBitForKey(key.key);
    await dispatch({
      type: text ? 'keyDown' : 'rawKeyDown',
      key: keyValue,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      ...(text ? { text, unmodifiedText: text } : {}),
      modifiers: mask | ownModifierBit,
      location: key.location ?? 0,
      ...(commands.length > 0 ? { commands } : {}),
    });
    if (!options.signal?.aborted) {
      await dispatch({
        type: 'keyUp',
        key: keyValue,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        modifiers: mask,
        location: key.location ?? 0,
      });
    }
  }

  for (const modifier of [...pressedModifiers].reverse()) {
    if (options.signal?.aborted) return;
    mask &= ~MODIFIER_BITS[modifier];
    const definition = MODIFIER_KEYS[modifier];
    await dispatch({
      type: 'keyUp',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      modifiers: mask,
      location: definition.location ?? 0,
    });
  }
}
