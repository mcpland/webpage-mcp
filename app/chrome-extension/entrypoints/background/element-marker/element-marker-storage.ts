// IndexedDB storage for element markers (URL -> marked selectors).
// Every public operation is independently bounded because callers include
// runtime-message handlers as well as internal browser tools.

import type { ElementMarker, UpsertMarkerRequest } from '@/common/element-marker-types';
import { IndexedDbClient } from '@/utils/indexeddb-client';

const DB_NAME = 'element_marker_storage';
const DB_VERSION = 1;
const STORE = 'markers';

export const ELEMENT_MARKER_MAX_COUNT = 256;
export const ELEMENT_MARKER_MAX_SCAN_COUNT = ELEMENT_MARKER_MAX_COUNT * 2;
export const ELEMENT_MARKER_MAX_MATCHES_PER_URL = 64;
export const ELEMENT_MARKER_MAX_LIST_BYTES = 2 * 1024 * 1024;
export const ELEMENT_MARKER_MAX_MATCH_BYTES = 512 * 1024;
export const ELEMENT_MARKER_MAX_RECORD_BYTES = 12 * 1024;
export const ELEMENT_MARKER_MAX_ID_BYTES = 128;
export const ELEMENT_MARKER_MAX_URL_BYTES = 4 * 1024;
export const ELEMENT_MARKER_MAX_NAME_BYTES = 512;
export const ELEMENT_MARKER_MAX_SELECTOR_BYTES = 8 * 1024;

const MATCH_TYPES = new Set(['exact', 'prefix', 'host']);
const SELECTOR_TYPES = new Set(['css', 'xpath']);
const ACTIONS = new Set(['click', 'fill', 'custom']);
const textEncoder = new TextEncoder();

const idb = new IndexedDbClient(DB_NAME, DB_VERSION, (db, oldVersion) => {
  switch (oldVersion) {
    case 0: {
      const store = db.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('by_host', 'host', { unique: false });
      store.createIndex('by_origin', 'origin', { unique: false });
      store.createIndex('by_path', 'path', { unique: false });
    }
  }
});

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function boundedString(
  value: unknown,
  field: string,
  maxBytes: number,
  options: { optional?: boolean } = {},
): string | undefined {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) {
    if (options.optional) return undefined;
    throw new Error(`${field} is required`);
  }
  if (utf8Bytes(normalized) > maxBytes) {
    throw new Error(`${field} exceeds the ${maxBytes}-byte limit`);
  }
  return normalized;
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: Set<string>,
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value as T;
}

function booleanValue(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function normalizeUrl(raw: unknown): {
  url: string;
  origin: string;
  host: string;
  path: string;
} {
  const input = boundedString(raw, 'url', ELEMENT_MARKER_MAX_URL_BYTES) as string;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('url must be an absolute URL');
  }
  const url = parsed.href;
  if (utf8Bytes(url) > ELEMENT_MARKER_MAX_URL_BYTES) {
    throw new Error(`url exceeds the ${ELEMENT_MARKER_MAX_URL_BYTES}-byte limit`);
  }
  return { url, origin: parsed.origin, host: parsed.hostname, path: parsed.pathname };
}

function markerJsonBytes(marker: ElementMarker): number {
  return utf8Bytes(JSON.stringify(marker));
}

function assertRecordBudget(marker: ElementMarker): ElementMarker {
  if (markerJsonBytes(marker) > ELEMENT_MARKER_MAX_RECORD_BYTES) {
    throw new Error(`marker exceeds the ${ELEMENT_MARKER_MAX_RECORD_BYTES}-byte limit`);
  }
  return marker;
}

function buildMarker(
  input: UpsertMarkerRequest | ElementMarker,
  id: string,
  createdAt: number,
  updatedAt: number,
): ElementMarker {
  if (!input || typeof input !== 'object') throw new Error('marker must be an object');
  const normalizedUrl = normalizeUrl(input.url);
  const selector = boundedString(
    input.selector,
    'selector',
    ELEMENT_MARKER_MAX_SELECTOR_BYTES,
  ) as string;
  const rawName = boundedString(input.name, 'name', ELEMENT_MARKER_MAX_NAME_BYTES, {
    optional: true,
  });
  const marker: ElementMarker = {
    id: boundedString(id, 'id', ELEMENT_MARKER_MAX_ID_BYTES) as string,
    ...normalizedUrl,
    matchType: enumValue(input.matchType, 'matchType', MATCH_TYPES, 'prefix'),
    name: rawName ?? (utf8Bytes(selector) <= ELEMENT_MARKER_MAX_NAME_BYTES ? selector : 'Marker'),
    selector,
    selectorType: enumValue(input.selectorType, 'selectorType', SELECTOR_TYPES, 'css'),
    listMode: booleanValue(input.listMode, 'listMode', false),
    action: enumValue(input.action, 'action', ACTIONS, 'custom'),
    createdAt,
    updatedAt,
  };
  return assertRecordBudget(marker);
}

function normalizeStoredMarker(value: unknown): ElementMarker | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const marker = value as ElementMarker;
  if (
    !Number.isFinite(marker.createdAt) ||
    marker.createdAt < 0 ||
    !Number.isFinite(marker.updatedAt) ||
    marker.updatedAt < 0
  ) {
    return undefined;
  }
  try {
    return buildMarker(marker, marker.id, marker.createdAt, marker.updatedAt);
  } catch {
    return undefined;
  }
}

interface BoundedMarkerScanOptions {
  maxResults: number;
  maxBytes: number;
  predicate?: (marker: ElementMarker) => boolean;
}

export interface ElementMarkerListResult {
  markers: ElementMarker[];
  truncated: boolean;
}

async function scanMarkers(options: BoundedMarkerScanOptions): Promise<ElementMarkerListResult> {
  return idb.tx<ElementMarkerListResult>(STORE, 'readonly', (store) =>
    new Promise<ElementMarkerListResult>((resolve, reject) => {
      const markers: ElementMarker[] = [];
      let scanned = 0;
      let resultBytes = 2;
      const request = store.openCursor();

      request.onerror = () => reject(new Error(`marker scan failed: ${request.error?.message}`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve({ markers, truncated: false });
          return;
        }
        if (scanned >= ELEMENT_MARKER_MAX_SCAN_COUNT) {
          resolve({ markers, truncated: true });
          return;
        }
        scanned += 1;

        const marker = normalizeStoredMarker(cursor.value);
        if (marker && (!options.predicate || options.predicate(marker))) {
          const separatorBytes = markers.length === 0 ? 0 : 1;
          const nextBytes = resultBytes + separatorBytes + markerJsonBytes(marker);
          if (markers.length >= options.maxResults || nextBytes > options.maxBytes) {
            resolve({ markers, truncated: true });
            return;
          }
          markers.push(marker);
          resultBytes = nextBytes;
        }
        cursor.continue();
      };
    }),
  );
}

export async function listAllMarkers(): Promise<ElementMarker[]> {
  return (await listAllMarkersWithMetadata()).markers;
}

export async function listAllMarkersWithMetadata(): Promise<ElementMarkerListResult> {
  return scanMarkers({
    maxResults: ELEMENT_MARKER_MAX_COUNT,
    maxBytes: ELEMENT_MARKER_MAX_LIST_BYTES,
  });
}

export async function listMarkersForUrl(url: string): Promise<ElementMarker[]> {
  return (await listMarkersForUrlWithMetadata(url)).markers;
}

export async function listMarkersForUrlWithMetadata(
  url: string,
): Promise<ElementMarkerListResult> {
  const current = normalizeUrl(url);
  return scanMarkers({
    maxResults: ELEMENT_MARKER_MAX_MATCHES_PER_URL,
    maxBytes: ELEMENT_MARKER_MAX_MATCH_BYTES,
    predicate: (marker) => {
      if (marker.matchType === 'exact') {
        return marker.origin === current.origin && marker.path === current.path;
      }
      if (marker.matchType === 'host') return !!marker.host && marker.host === current.host;
      return marker.origin === current.origin && (marker.path ? current.path.startsWith(marker.path) : true);
    },
  });
}

export async function saveMarker(req: UpsertMarkerRequest): Promise<ElementMarker> {
  if (!req || typeof req !== 'object') throw new Error('marker must be an object');
  const generatedId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random()}`;
  const id = boundedString(req.id || generatedId, 'id', ELEMENT_MARKER_MAX_ID_BYTES) as string;

  return idb.tx<ElementMarker>(STORE, 'readwrite', async (store) => {
    const existing = await idb.promisifyRequest<ElementMarker | undefined>(
      store.get(id),
      STORE,
      'get marker before save',
    );
    if (!existing) {
      const count = await idb.promisifyRequest<number>(store.count(), STORE, 'count markers');
      if (count >= ELEMENT_MARKER_MAX_COUNT) {
        throw new Error(`marker count exceeds the ${ELEMENT_MARKER_MAX_COUNT}-record limit`);
      }
    }

    const ts = Date.now();
    const existingCreatedAt =
      existing && Number.isFinite(existing.createdAt) ? existing.createdAt : undefined;
    const marker = buildMarker(req, id, existingCreatedAt ?? ts, ts);
    await idb.promisifyRequest(store.put(marker), STORE, 'save marker');
    return marker;
  });
}

export async function updateMarker(marker: ElementMarker): Promise<void> {
  if (!marker || typeof marker !== 'object') throw new Error('marker must be an object');
  const id = boundedString(marker.id, 'id', ELEMENT_MARKER_MAX_ID_BYTES) as string;

  await idb.tx<void>(STORE, 'readwrite', async (store) => {
    const existing = await idb.promisifyRequest<ElementMarker | undefined>(
      store.get(id),
      STORE,
      'get marker before update',
    );
    if (!existing) throw new Error('marker not found');
    const updated = buildMarker(marker, id, existing.createdAt, Date.now());
    await idb.promisifyRequest(store.put(updated), STORE, 'update marker');
  });
}

export async function deleteMarker(id: string): Promise<void> {
  const normalizedId = boundedString(id, 'id', ELEMENT_MARKER_MAX_ID_BYTES) as string;
  await idb.delete(STORE, normalizedId);
}
