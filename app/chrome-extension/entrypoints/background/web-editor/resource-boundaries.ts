import type {
  DebugSource,
  ElementChangeSummary,
  ElementLocator,
  WebEditorApplyBatchPayload,
  WebEditorCancelExecutionPayload,
  WebEditorRevertElementPayload,
  WebEditorSelectionChangedPayload,
  WebEditorTxChangedPayload,
} from '@/common/web-editor-types';

export const WEB_EDITOR_RESOURCE_LIMITS = {
  applyPayloadBytes: 256 * 1024,
  applyBatchPayloadBytes: 1024 * 1024,
  txSessionPayloadBytes: 512 * 1024,
  selectionSessionPayloadBytes: 128 * 1024,
  openSourcePayloadBytes: 32 * 1024,
  highlightPayloadBytes: 128 * 1024,
  simpleRoutePayloadBytes: 8 * 1024,
  payloadDepth: 20,
  payloadValues: 20_000,
  containerEntries: 512,
  rawStringBytes: 128 * 1024,
  promptBytes: 256 * 1024,
  batchElements: 64,
  excludedKeys: 128,
  styleProperties: 256,
  selectors: 16,
  locatorPath: 128,
  locatorChains: 16,
  classes: 128,
  changeDetails: 128,
  transactionIds: 256,
  techStackHints: 32,
  identifierBytes: 1024,
  sessionStatusIdBytes: 384,
  subscriptionIdBytes: 1024,
  pageUrlBytes: 16 * 1024,
  fileBytes: 8 * 1024,
  labelBytes: 2 * 1024,
  fullLabelBytes: 8 * 1024,
  selectorBytes: 8 * 1024,
  fingerprintBytes: 16 * 1024,
  textBytes: 32 * 1024,
  descriptionBytes: 16 * 1024,
  styleKeyBytes: 512,
  styleValueBytes: 16 * 1024,
  classBytes: 1024,
  hintBytes: 1024,
  tagNameBytes: 256,
  transactionCount: 100_000,
} as const;

interface JsonResourceLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxValues: number;
  readonly maxContainerEntries: number;
  readonly maxStringBytes: number;
}

interface JsonScanState {
  bytes: number;
  values: number;
  readonly ancestors: WeakSet<object>;
  readonly limits: JsonResourceLimits;
}

type ElementChangeType = ElementChangeSummary['type'];

export type WebEditorInstructionType = 'update_text' | 'update_style';

export interface WebEditorFingerprint {
  tag: string;
  id?: string;
  classes: string[];
  text?: string;
}

export interface WebEditorDebugSource {
  file: string;
  line?: number;
  column?: number;
  componentName?: string;
}

export interface WebEditorStyleOperation {
  type: 'update_style';
  before: Record<string, string>;
  after: Record<string, string>;
  removed: string[];
}

export interface NormalizedWebEditorApplyPayload {
  pageUrl: string;
  targetFile?: string;
  fingerprint: WebEditorFingerprint;
  techStackHint?: string[];
  instruction: {
    type: WebEditorInstructionType;
    description: string;
    text?: string;
    style?: Record<string, string>;
  };
  selectorCandidates?: string[];
  debugSource?: WebEditorDebugSource;
  operation?: WebEditorStyleOperation;
}

export interface NormalizedOpenSourcePayload {
  file: string;
  line?: number;
  column?: number;
}

export type NormalizedHighlightPayload =
  | { tabId: number; mode: 'clear' }
  | {
      tabId: number;
      mode: 'hover';
      elementKey: string;
      locator: ElementLocator;
      primarySelector: string;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addScannedBytes(state: JsonScanState, bytes: number, path: string): void {
  state.bytes += bytes;
  if (state.bytes > state.limits.maxBytes) {
    throw new Error(`${path} exceeds the Web Editor raw JSON byte limit`);
  }
}

/** Return exact JSON-string byte size without allocating a serialized copy. */
export function jsonStringUtf8Bytes(value: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 2; // surrounding quotes
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x0c ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x09
    ) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

/** Return UTF-8 byte size of text, stopping as soon as the caller's budget is exceeded. */
export function utf8Bytes(value: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      bytes += 4;
    } else {
      bytes += 3;
    }
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

function scanJsonValue(value: unknown, path: string, depth: number, state: JsonScanState): void {
  state.values += 1;
  if (state.values > state.limits.maxValues) {
    throw new Error(`${path} exceeds the Web Editor JSON value limit`);
  }
  if (depth > state.limits.maxDepth) {
    throw new Error(`${path} exceeds the Web Editor JSON depth limit`);
  }

  if (value === null) {
    addScannedBytes(state, 4, path);
    return;
  }

  if (typeof value === 'string') {
    const rawBytes = utf8Bytes(value, state.limits.maxStringBytes);
    if (rawBytes > state.limits.maxStringBytes) {
      throw new Error(`${path} exceeds the Web Editor string byte limit`);
    }
    addScannedBytes(state, jsonStringUtf8Bytes(value, state.limits.maxBytes - state.bytes), path);
    return;
  }

  if (typeof value === 'boolean') {
    addScannedBytes(state, value ? 4 : 5, path);
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite JSON number`);
    addScannedBytes(state, String(value).length, path);
    return;
  }

  if (typeof value !== 'object') {
    throw new Error(`${path} contains a non-JSON value`);
  }

  if (state.ancestors.has(value)) throw new Error(`${path} contains a circular reference`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > state.limits.maxContainerEntries) {
        throw new Error(`${path} exceeds the Web Editor container entry limit`);
      }
      addScannedBytes(state, 2, path);
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) addScannedBytes(state, 1, path);
        scanJsonValue(value[index], `${path}[${index}]`, depth + 1, state);
      }
      return;
    }

    if (!isPlainRecord(value)) throw new Error(`${path} must be a plain JSON object`);
    addScannedBytes(state, 2, path);
    let entries = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      entries += 1;
      if (entries > state.limits.maxContainerEntries) {
        throw new Error(`${path} exceeds the Web Editor container entry limit`);
      }
      if (entries > 1) addScannedBytes(state, 1, path);
      const keyBytes = utf8Bytes(key, state.limits.maxStringBytes);
      if (keyBytes > state.limits.maxStringBytes) {
        throw new Error(`${path} contains an oversized property name`);
      }
      addScannedBytes(
        state,
        jsonStringUtf8Bytes(key, state.limits.maxBytes - state.bytes) + 1,
        path,
      );
      scanJsonValue(value[key], `${path}.${key}`, depth + 1, state);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

export function assertJsonWithinLimits(
  value: unknown,
  path: string,
  limits: Partial<JsonResourceLimits> & Pick<JsonResourceLimits, 'maxBytes'>,
): void {
  scanJsonValue(value, path, 1, {
    bytes: 0,
    values: 0,
    ancestors: new WeakSet<object>(),
    limits: {
      maxBytes: limits.maxBytes,
      maxDepth: limits.maxDepth ?? WEB_EDITOR_RESOURCE_LIMITS.payloadDepth,
      maxValues: limits.maxValues ?? WEB_EDITOR_RESOURCE_LIMITS.payloadValues,
      maxContainerEntries:
        limits.maxContainerEntries ?? WEB_EDITOR_RESOURCE_LIMITS.containerEntries,
      maxStringBytes: limits.maxStringBytes ?? WEB_EDITOR_RESOURCE_LIMITS.rawStringBytes,
    },
  });
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function boundedString(
  value: unknown,
  path: string,
  maxBytes: number,
  options: { required?: boolean; trim?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${path} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  if (utf8Bytes(value, maxBytes) > maxBytes) {
    throw new Error(`${path} exceeds the Web Editor field byte limit`);
  }
  const normalized = options.trim === false ? value : value.trim();
  if (!normalized && options.required) throw new Error(`${path} is required`);
  return normalized || undefined;
}

export function normalizeBoundedIdentifier(
  value: unknown,
  path: string,
  required = false,
): string | undefined {
  return boundedString(value, path, WEB_EDITOR_RESOURCE_LIMITS.identifierBytes, { required });
}

export function normalizeSessionStatusIdentifier(
  value: unknown,
  path: string,
  kind: 'session-or-request' | 'subscription' = 'session-or-request',
): string {
  const maxBytes =
    kind === 'subscription'
      ? WEB_EDITOR_RESOURCE_LIMITS.subscriptionIdBytes
      : WEB_EDITOR_RESOURCE_LIMITS.sessionStatusIdBytes;
  return boundedString(value, path, maxBytes, { required: true })!;
}

export function normalizeBoundedPageUrl(
  value: unknown,
  path: string,
  required = false,
): string | undefined {
  return boundedString(value, path, WEB_EDITOR_RESOURCE_LIMITS.pageUrlBytes, {
    required,
  });
}

export function normalizePositiveTabId(value: unknown, path = 'payload.tabId'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(path === 'payload.tabId' ? 'Invalid tabId' : `${path} is invalid`);
  }
  return value;
}

function boundedStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  maxItemBytes: number,
  options: { requireNonEmptyItems?: boolean } = {},
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  if (value.length > maxItems) throw new Error(`${path} exceeds the Web Editor item limit`);
  const output: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = boundedString(value[index], `${path}[${index}]`, maxItemBytes, {
      required: options.requireNonEmptyItems,
    });
    if (item) output.push(item);
  }
  return output;
}

function normalizeNonNegativeInteger(value: unknown, path: string, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function normalizeBoundedCount(value: unknown, path: string): number {
  const count = normalizeNonNegativeInteger(value, path);
  if (count > WEB_EDITOR_RESOURCE_LIMITS.transactionCount) {
    throw new Error(`${path} exceeds the Web Editor transaction count limit`);
  }
  return count;
}

function normalizeDebugSource(value: unknown, path: string): DebugSource | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireRecord(value, path);
  const file = boundedString(record.file, `${path}.file`, WEB_EDITOR_RESOURCE_LIMITS.fileBytes, {
    required: true,
  })!;
  const componentName = boundedString(
    record.componentName,
    `${path}.componentName`,
    WEB_EDITOR_RESOURCE_LIMITS.labelBytes,
  );
  const source: DebugSource = { file };
  if (record.line !== undefined) {
    const line = normalizeNonNegativeInteger(record.line, `${path}.line`);
    if (line > 0) source.line = line;
  }
  if (record.column !== undefined) {
    source.column = normalizeNonNegativeInteger(record.column, `${path}.column`);
  }
  if (componentName) source.componentName = componentName;
  return source;
}

function normalizeStyleMap(
  value: unknown,
  path: string,
  allowEmptyValues: boolean,
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireRecord(value, path);
  const output = Object.create(null) as Record<string, string>;
  let count = 0;
  let outputCount = 0;
  for (const rawKey in record) {
    if (!Object.prototype.hasOwnProperty.call(record, rawKey)) continue;
    count += 1;
    if (count > WEB_EDITOR_RESOURCE_LIMITS.styleProperties) {
      throw new Error(`${path} exceeds the Web Editor style property limit`);
    }
    const key = boundedString(
      rawKey,
      `${path} property name`,
      WEB_EDITOR_RESOURCE_LIMITS.styleKeyBytes,
      { required: true },
    )!;
    const rawValue = record[rawKey];
    if (typeof rawValue !== 'string') throw new Error(`${path}.${key} must be a string`);
    if (
      utf8Bytes(rawValue, WEB_EDITOR_RESOURCE_LIMITS.styleValueBytes) >
      WEB_EDITOR_RESOURCE_LIMITS.styleValueBytes
    ) {
      throw new Error(`${path}.${key} exceeds the Web Editor field byte limit`);
    }
    const normalizedValue = rawValue.trim();
    if (!allowEmptyValues && !normalizedValue) continue;
    output[key] = normalizedValue;
    outputCount += 1;
  }
  return outputCount > 0 ? output : undefined;
}

export function normalizeElementLocator(value: unknown, path: string): ElementLocator {
  const record = requireRecord(value, path);
  const selectors = boundedStringArray(
    record.selectors,
    `${path}.selectors`,
    WEB_EDITOR_RESOURCE_LIMITS.selectors,
    WEB_EDITOR_RESOURCE_LIMITS.selectorBytes,
  );
  const fingerprint =
    boundedString(
      record.fingerprint,
      `${path}.fingerprint`,
      WEB_EDITOR_RESOURCE_LIMITS.fingerprintBytes,
      { trim: false },
    ) ?? '';
  const rawPath = record.path;
  if (rawPath !== undefined && !Array.isArray(rawPath)) {
    throw new Error(`${path}.path must be an array`);
  }
  if (Array.isArray(rawPath) && rawPath.length > WEB_EDITOR_RESOURCE_LIMITS.locatorPath) {
    throw new Error(`${path}.path exceeds the Web Editor item limit`);
  }
  const locatorPath: number[] = [];
  if (Array.isArray(rawPath)) {
    for (let index = 0; index < rawPath.length; index += 1) {
      locatorPath.push(normalizeNonNegativeInteger(rawPath[index], `${path}.path[${index}]`));
    }
  }
  const frameChain = boundedStringArray(
    record.frameChain,
    `${path}.frameChain`,
    WEB_EDITOR_RESOURCE_LIMITS.locatorChains,
    WEB_EDITOR_RESOURCE_LIMITS.selectorBytes,
    { requireNonEmptyItems: true },
  );
  const shadowHostChain = boundedStringArray(
    record.shadowHostChain,
    `${path}.shadowHostChain`,
    WEB_EDITOR_RESOURCE_LIMITS.locatorChains,
    WEB_EDITOR_RESOURCE_LIMITS.selectorBytes,
    { requireNonEmptyItems: true },
  );
  const debugSource = normalizeDebugSource(record.debugSource, `${path}.debugSource`);
  return {
    selectors,
    fingerprint,
    path: locatorPath,
    ...(frameChain.length > 0 ? { frameChain } : {}),
    ...(shadowHostChain.length > 0 ? { shadowHostChain } : {}),
    ...(debugSource ? { debugSource } : {}),
  };
}

function normalizeElementChangeType(value: unknown, path: string): ElementChangeType {
  if (value === 'style' || value === 'text' || value === 'class' || value === 'mixed') {
    return value;
  }
  throw new Error(`${path} is invalid`);
}

function normalizeChanges(value: unknown, path: string): ElementChangeSummary['changes'] {
  if (value === undefined || value === null) return {};
  const record = requireRecord(value, path);
  const changes: ElementChangeSummary['changes'] = {};
  if (record.style !== undefined && record.style !== null) {
    const style = requireRecord(record.style, `${path}.style`);
    changes.style = {
      added: normalizeNonNegativeInteger(style.added, `${path}.style.added`),
      removed: normalizeNonNegativeInteger(style.removed, `${path}.style.removed`),
      modified: normalizeNonNegativeInteger(style.modified, `${path}.style.modified`),
      details: boundedStringArray(
        style.details,
        `${path}.style.details`,
        WEB_EDITOR_RESOURCE_LIMITS.changeDetails,
        WEB_EDITOR_RESOURCE_LIMITS.styleKeyBytes,
      ),
    };
  }
  if (record.text !== undefined && record.text !== null) {
    const text = requireRecord(record.text, `${path}.text`);
    changes.text = {
      beforePreview:
        boundedString(
          text.beforePreview,
          `${path}.text.beforePreview`,
          WEB_EDITOR_RESOURCE_LIMITS.textBytes,
          { trim: false },
        ) ?? '',
      afterPreview:
        boundedString(
          text.afterPreview,
          `${path}.text.afterPreview`,
          WEB_EDITOR_RESOURCE_LIMITS.textBytes,
          { trim: false },
        ) ?? '',
    };
  }
  if (record.class !== undefined && record.class !== null) {
    const classChange = requireRecord(record.class, `${path}.class`);
    changes.class = {
      added: boundedStringArray(
        classChange.added,
        `${path}.class.added`,
        WEB_EDITOR_RESOURCE_LIMITS.classes,
        WEB_EDITOR_RESOURCE_LIMITS.classBytes,
      ),
      removed: boundedStringArray(
        classChange.removed,
        `${path}.class.removed`,
        WEB_EDITOR_RESOURCE_LIMITS.classes,
        WEB_EDITOR_RESOURCE_LIMITS.classBytes,
      ),
    };
  }
  return changes;
}

function normalizeNetEffect(
  value: unknown,
  path: string,
  fallbackElementKey: string,
  fallbackLocator: ElementLocator,
): ElementChangeSummary['netEffect'] {
  const record = requireRecord(value, path);
  const elementKey =
    normalizeBoundedIdentifier(record.elementKey, `${path}.elementKey`) ?? fallbackElementKey;
  const locator =
    record.locator === undefined
      ? fallbackLocator
      : normalizeElementLocator(record.locator, `${path}.locator`);
  const netEffect: ElementChangeSummary['netEffect'] = { elementKey, locator };
  if (record.styleChanges !== undefined && record.styleChanges !== null) {
    const styleChanges = requireRecord(record.styleChanges, `${path}.styleChanges`);
    netEffect.styleChanges = {
      before:
        normalizeStyleMap(styleChanges.before, `${path}.styleChanges.before`, true) ??
        Object.create(null),
      after:
        normalizeStyleMap(styleChanges.after, `${path}.styleChanges.after`, true) ??
        Object.create(null),
    };
  }
  if (record.textChange !== undefined && record.textChange !== null) {
    const textChange = requireRecord(record.textChange, `${path}.textChange`);
    netEffect.textChange = {
      before:
        boundedString(
          textChange.before,
          `${path}.textChange.before`,
          WEB_EDITOR_RESOURCE_LIMITS.textBytes,
          { trim: false },
        ) ?? '',
      after:
        boundedString(
          textChange.after,
          `${path}.textChange.after`,
          WEB_EDITOR_RESOURCE_LIMITS.textBytes,
          { trim: false },
        ) ?? '',
    };
  }
  if (record.classChanges !== undefined && record.classChanges !== null) {
    const classChanges = requireRecord(record.classChanges, `${path}.classChanges`);
    netEffect.classChanges = {
      before: boundedStringArray(
        classChanges.before,
        `${path}.classChanges.before`,
        WEB_EDITOR_RESOURCE_LIMITS.classes,
        WEB_EDITOR_RESOURCE_LIMITS.classBytes,
      ),
      after: boundedStringArray(
        classChanges.after,
        `${path}.classChanges.after`,
        WEB_EDITOR_RESOURCE_LIMITS.classes,
        WEB_EDITOR_RESOURCE_LIMITS.classBytes,
      ),
    };
  }
  return netEffect;
}

function normalizeElementChangeSummary(value: unknown, path: string): ElementChangeSummary {
  const record = requireRecord(value, path);
  const elementKey = normalizeBoundedIdentifier(record.elementKey, `${path}.elementKey`, true)!;
  const label =
    boundedString(record.label, `${path}.label`, WEB_EDITOR_RESOURCE_LIMITS.labelBytes) ??
    elementKey;
  const fullLabel =
    boundedString(
      record.fullLabel,
      `${path}.fullLabel`,
      WEB_EDITOR_RESOURCE_LIMITS.fullLabelBytes,
    ) ?? label;
  const locator = normalizeElementLocator(record.locator, `${path}.locator`);
  const type = normalizeElementChangeType(record.type, `${path}.type`);
  const changes = normalizeChanges(record.changes, `${path}.changes`);
  const transactionIds = boundedStringArray(
    record.transactionIds,
    `${path}.transactionIds`,
    WEB_EDITOR_RESOURCE_LIMITS.transactionIds,
    WEB_EDITOR_RESOURCE_LIMITS.identifierBytes,
  );
  const netEffect = normalizeNetEffect(record.netEffect, `${path}.netEffect`, elementKey, locator);
  const updatedAt = normalizeNonNegativeInteger(record.updatedAt, `${path}.updatedAt`);
  const debugSource = normalizeDebugSource(record.debugSource, `${path}.debugSource`);
  return {
    elementKey,
    label,
    fullLabel,
    locator,
    type,
    changes,
    transactionIds,
    netEffect,
    updatedAt,
    ...(debugSource ? { debugSource } : {}),
  };
}

function normalizeStyleOperation(
  value: unknown,
  path: string,
): WebEditorStyleOperation | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireRecord(value, path);
  if (record.type !== 'update_style') throw new Error(`${path}.type is invalid`);
  const before = normalizeStyleMap(record.before, `${path}.before`, true);
  const after = normalizeStyleMap(record.after, `${path}.after`, true);
  const removed = boundedStringArray(
    record.removed,
    `${path}.removed`,
    WEB_EDITOR_RESOURCE_LIMITS.styleProperties,
    WEB_EDITOR_RESOURCE_LIMITS.styleKeyBytes,
  );
  if (!before && !after && removed.length === 0) return undefined;
  return {
    type: 'update_style',
    before: before ?? Object.create(null),
    after: after ?? Object.create(null),
    removed,
  };
}

export function normalizeApplyPayload(raw: unknown): NormalizedWebEditorApplyPayload {
  assertJsonWithinLimits(raw, 'payload', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.applyPayloadBytes,
  });
  const record = requireRecord(raw, 'payload');
  const pageUrl = normalizeBoundedPageUrl(record.pageUrl, 'payload.pageUrl', true)!;
  const targetFile = boundedString(
    record.targetFile,
    'payload.targetFile',
    WEB_EDITOR_RESOURCE_LIMITS.fileBytes,
  );
  const fingerprintRecord = requireRecord(record.fingerprint, 'payload.fingerprint');
  const fingerprint: WebEditorFingerprint = {
    tag:
      boundedString(
        fingerprintRecord.tag,
        'payload.fingerprint.tag',
        WEB_EDITOR_RESOURCE_LIMITS.labelBytes,
      ) ?? 'unknown',
    classes: boundedStringArray(
      fingerprintRecord.classes,
      'payload.fingerprint.classes',
      WEB_EDITOR_RESOURCE_LIMITS.classes,
      WEB_EDITOR_RESOURCE_LIMITS.classBytes,
    ),
  };
  const fingerprintId = boundedString(
    fingerprintRecord.id,
    'payload.fingerprint.id',
    WEB_EDITOR_RESOURCE_LIMITS.identifierBytes,
  );
  const fingerprintText = boundedString(
    fingerprintRecord.text,
    'payload.fingerprint.text',
    WEB_EDITOR_RESOURCE_LIMITS.textBytes,
  );
  if (fingerprintId) fingerprint.id = fingerprintId;
  if (fingerprintText) fingerprint.text = fingerprintText;

  const instructionRecord = requireRecord(record.instruction, 'payload.instruction');
  const instructionType = instructionRecord.type;
  if (instructionType !== 'update_text' && instructionType !== 'update_style') {
    throw new Error('Invalid instruction.type');
  }
  const description = boundedString(
    instructionRecord.description,
    'payload.instruction.description',
    WEB_EDITOR_RESOURCE_LIMITS.descriptionBytes,
    { required: true },
  )!;
  const text = boundedString(
    instructionRecord.text,
    'payload.instruction.text',
    WEB_EDITOR_RESOURCE_LIMITS.textBytes,
    { trim: false },
  );
  const style = normalizeStyleMap(instructionRecord.style, 'payload.instruction.style', false);
  const techStackHint = boundedStringArray(
    record.techStackHint,
    'payload.techStackHint',
    WEB_EDITOR_RESOURCE_LIMITS.techStackHints,
    WEB_EDITOR_RESOURCE_LIMITS.hintBytes,
  );
  const selectorCandidates = boundedStringArray(
    record.selectorCandidates,
    'payload.selectorCandidates',
    WEB_EDITOR_RESOURCE_LIMITS.selectors,
    WEB_EDITOR_RESOURCE_LIMITS.selectorBytes,
  );
  const debugSource = normalizeDebugSource(record.debugSource, 'payload.debugSource');
  const operation = normalizeStyleOperation(record.operation, 'payload.operation');
  return {
    pageUrl,
    ...(targetFile ? { targetFile } : {}),
    fingerprint,
    ...(techStackHint.length > 0 ? { techStackHint } : {}),
    instruction: {
      type: instructionType,
      description,
      ...(text !== undefined ? { text } : {}),
      ...(style ? { style } : {}),
    },
    ...(selectorCandidates.length > 0 ? { selectorCandidates } : {}),
    ...(debugSource ? { debugSource } : {}),
    ...(operation ? { operation } : {}),
  };
}

export function normalizeApplyBatchPayload(raw: unknown): WebEditorApplyBatchPayload {
  assertJsonWithinLimits(raw, 'payload', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.applyBatchPayloadBytes,
  });
  const record = requireRecord(raw, 'payload');
  const rawElements = record.elements;
  if (!Array.isArray(rawElements)) throw new Error('payload.elements must be an array');
  if (rawElements.length > WEB_EDITOR_RESOURCE_LIMITS.batchElements) {
    throw new Error('payload.elements exceeds the Web Editor item limit');
  }
  const elements: ElementChangeSummary[] = [];
  for (let index = 0; index < rawElements.length; index += 1) {
    elements.push(normalizeElementChangeSummary(rawElements[index], `payload.elements[${index}]`));
  }
  const excludedKeys = boundedStringArray(
    record.excludedKeys,
    'payload.excludedKeys',
    WEB_EDITOR_RESOURCE_LIMITS.excludedKeys,
    WEB_EDITOR_RESOURCE_LIMITS.identifierBytes,
  );
  const pageUrl = normalizeBoundedPageUrl(record.pageUrl, 'payload.pageUrl');
  return { tabId: 0, elements, excludedKeys, ...(pageUrl ? { pageUrl } : {}) };
}

export function normalizeStoredExcludedKeys(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  assertJsonWithinLimits(value, 'stored excluded keys', {
    maxBytes: 64 * 1024,
  });
  return boundedStringArray(
    value,
    'stored excluded keys',
    WEB_EDITOR_RESOURCE_LIMITS.excludedKeys,
    WEB_EDITOR_RESOURCE_LIMITS.identifierBytes,
  );
}

export function normalizeTxChangedPayload(
  raw: unknown,
  senderTabId: number,
): WebEditorTxChangedPayload {
  assertJsonWithinLimits(raw, 'payload', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.txSessionPayloadBytes,
  });
  const record = requireRecord(raw, 'payload');
  const action = record.action;
  if (
    action !== 'push' &&
    action !== 'merge' &&
    action !== 'undo' &&
    action !== 'redo' &&
    action !== 'clear' &&
    action !== 'rollback'
  ) {
    throw new Error('payload.action is invalid');
  }
  if (!Array.isArray(record.elements)) throw new Error('payload.elements must be an array');
  if (record.elements.length > WEB_EDITOR_RESOURCE_LIMITS.batchElements) {
    throw new Error('payload.elements exceeds the Web Editor item limit');
  }
  const elements: ElementChangeSummary[] = [];
  for (let index = 0; index < record.elements.length; index += 1) {
    elements.push(
      normalizeElementChangeSummary(record.elements[index], `payload.elements[${index}]`),
    );
  }
  if (typeof record.hasApplicableChanges !== 'boolean') {
    throw new Error('payload.hasApplicableChanges must be a boolean');
  }
  const pageUrl = normalizeBoundedPageUrl(record.pageUrl, 'payload.pageUrl');
  const payload: WebEditorTxChangedPayload = {
    tabId: senderTabId,
    action,
    elements,
    undoCount: normalizeBoundedCount(record.undoCount, 'payload.undoCount'),
    redoCount: normalizeBoundedCount(record.redoCount, 'payload.redoCount'),
    hasApplicableChanges: record.hasApplicableChanges,
    ...(pageUrl ? { pageUrl } : {}),
  };
  assertJsonWithinLimits(payload, 'normalized TX_CHANGED payload', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.txSessionPayloadBytes,
  });
  return payload;
}

export function normalizeSelectionChangedPayload(
  raw: unknown,
  senderTabId: number,
): WebEditorSelectionChangedPayload {
  assertJsonWithinLimits(raw, 'payload', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.selectionSessionPayloadBytes,
  });
  const record = requireRecord(raw, 'payload');
  if (record.selected === undefined) throw new Error('payload.selected is required');
  const pageUrl = normalizeBoundedPageUrl(record.pageUrl, 'payload.pageUrl');
  let selected: WebEditorSelectionChangedPayload['selected'] = null;
  if (record.selected !== null) {
    const selectedRecord = requireRecord(record.selected, 'payload.selected');
    const elementKey = normalizeBoundedIdentifier(
      selectedRecord.elementKey,
      'payload.selected.elementKey',
      true,
    )!;
    const label =
      boundedString(
        selectedRecord.label,
        'payload.selected.label',
        WEB_EDITOR_RESOURCE_LIMITS.labelBytes,
      ) ?? elementKey;
    const fullLabel =
      boundedString(
        selectedRecord.fullLabel,
        'payload.selected.fullLabel',
        WEB_EDITOR_RESOURCE_LIMITS.fullLabelBytes,
      ) ?? label;
    const tagName = boundedString(
      selectedRecord.tagName,
      'payload.selected.tagName',
      WEB_EDITOR_RESOURCE_LIMITS.tagNameBytes,
      { required: true },
    )!;
    selected = {
      elementKey,
      locator: normalizeElementLocator(selectedRecord.locator, 'payload.selected.locator'),
      label,
      fullLabel,
      tagName,
      updatedAt: normalizeNonNegativeInteger(
        selectedRecord.updatedAt,
        'payload.selected.updatedAt',
      ),
    };
  }
  const payload: WebEditorSelectionChangedPayload = {
    tabId: senderTabId,
    selected,
    ...(pageUrl ? { pageUrl } : {}),
  };
  assertJsonWithinLimits(payload, 'normalized SELECTION_CHANGED payload', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.selectionSessionPayloadBytes,
  });
  return payload;
}

export function normalizeOpenSourcePayload(raw: unknown): NormalizedOpenSourcePayload {
  assertJsonWithinLimits(raw, 'payload', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.openSourcePayloadBytes,
  });
  const record = requireRecord(raw, 'payload');
  const debugSource = requireRecord(record.debugSource, 'payload.debugSource');
  const file = boundedString(
    debugSource.file,
    'payload.debugSource.file',
    WEB_EDITOR_RESOURCE_LIMITS.fileBytes,
    { required: true },
  )!;
  const line =
    debugSource.line === undefined
      ? undefined
      : normalizeNonNegativeInteger(debugSource.line, 'payload.debugSource.line');
  const column =
    debugSource.column === undefined
      ? undefined
      : normalizeNonNegativeInteger(debugSource.column, 'payload.debugSource.column');
  return {
    file,
    ...(line !== undefined && line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  };
}

export function normalizeHighlightPayload(raw: unknown): NormalizedHighlightPayload {
  assertJsonWithinLimits(raw, 'payload', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.highlightPayloadBytes,
  });
  const record = requireRecord(raw, 'payload');
  const tabId = normalizePositiveTabId(record.tabId);
  if (record.mode === 'clear') return { tabId, mode: 'clear' };
  if (record.mode !== 'hover') throw new Error('Invalid mode');
  const elementKey = normalizeBoundedIdentifier(record.elementKey, 'payload.elementKey', true)!;
  const locator = normalizeElementLocator(record.locator, 'payload.locator');
  const primarySelector = locator.selectors[0];
  if (!primarySelector) throw new Error('No valid selector in locator');
  return { tabId, mode: 'hover', elementKey, locator, primarySelector };
}

export function normalizeRevertPayload(raw: unknown): WebEditorRevertElementPayload {
  assertJsonWithinLimits(raw, 'payload', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.simpleRoutePayloadBytes,
    maxDepth: 4,
    maxValues: 16,
    maxContainerEntries: 8,
  });
  const record = requireRecord(raw, 'payload');
  return {
    tabId: normalizePositiveTabId(record.tabId),
    elementKey: normalizeBoundedIdentifier(record.elementKey, 'payload.elementKey', true)!,
  };
}

export function normalizeClearSelectionPayload(raw: unknown): { tabId: number } {
  assertJsonWithinLimits(raw, 'payload', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.simpleRoutePayloadBytes,
    maxDepth: 3,
    maxValues: 8,
    maxContainerEntries: 4,
  });
  const record = requireRecord(raw, 'payload');
  return { tabId: normalizePositiveTabId(record.tabId) };
}

export function normalizeStatusQueryMessage(raw: unknown): {
  requestId: string;
  sessionId: string;
} {
  assertJsonWithinLimits(raw, 'message', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.simpleRoutePayloadBytes,
    maxDepth: 3,
    maxValues: 12,
    maxContainerEntries: 8,
  });
  const record = requireRecord(raw, 'message');
  return {
    requestId: normalizeBoundedIdentifier(record.requestId, 'requestId', true)!,
    sessionId: normalizeBoundedIdentifier(record.sessionId, 'sessionId', true)!,
  };
}

export function normalizeCancelExecutionPayload(raw: unknown): WebEditorCancelExecutionPayload {
  assertJsonWithinLimits(raw, 'payload', {
    maxBytes: WEB_EDITOR_RESOURCE_LIMITS.simpleRoutePayloadBytes,
    maxDepth: 3,
    maxValues: 8,
    maxContainerEntries: 4,
  });
  const record = requireRecord(raw, 'payload');
  const sessionId = normalizeBoundedIdentifier(record.sessionId, 'sessionId', true)!;
  const requestId = normalizeBoundedIdentifier(record.requestId, 'requestId', true)!;
  return {
    sessionId,
    requestId,
  };
}

/** Incrementally enforces the final prompt budget before retaining each line. */
export class BoundedPromptBuilder {
  readonly #lines: string[] = [];
  #bytes = 0;

  push(line: string): void {
    const separatorBytes = this.#lines.length > 0 ? 1 : 0;
    const remaining = WEB_EDITOR_RESOURCE_LIMITS.promptBytes - this.#bytes - separatorBytes;
    if (remaining < 0 || utf8Bytes(line, remaining) > remaining) {
      throw new Error('Web Editor agent prompt exceeds the byte limit');
    }
    this.#bytes += separatorBytes + utf8Bytes(line);
    this.#lines.push(line);
  }

  build(): string {
    return this.#lines.join('\n');
  }
}
