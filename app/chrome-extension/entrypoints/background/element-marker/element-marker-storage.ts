// IndexedDB storage for element markers (URL -> marked selectors)
// Uses the shared IndexedDbClient for robust transaction handling.

import { IndexedDbClient } from '@/utils/indexeddb-client';
import type { ElementMarker, UpsertMarkerRequest } from '@/common/element-marker-types';

const DB_NAME = 'element_marker_storage';
const DB_VERSION = 1;
const STORE = 'markers';

const idb = new IndexedDbClient(DB_NAME, DB_VERSION, (db, oldVersion) => {
  switch (oldVersion) {
    case 0: {
      const store = db.createObjectStore(STORE, { keyPath: 'id' });
      // Useful indexes for lookups
      store.createIndex('by_host', 'host', { unique: false });
      store.createIndex('by_origin', 'origin', { unique: false });
      store.createIndex('by_path', 'path', { unique: false });
    }
  }
});

function normalizeUrl(raw: string): { url: string; origin: string; host: string; path: string } {
  try {
    const u = new URL(raw);
    return { url: raw, origin: u.origin, host: u.hostname, path: u.pathname };
  } catch {
    return { url: raw, origin: '', host: '', path: '' };
  }
}

function now(): number {
  return Date.now();
}

export async function listAllMarkers(): Promise<ElementMarker[]> {
  return idb.getAll<ElementMarker>(STORE);
}

export async function listMarkersForUrl(url: string): Promise<ElementMarker[]> {
  const { origin, path, host } = normalizeUrl(url);
  const all = await idb.getAll<ElementMarker>(STORE);
  // Simple matching policy:
  // - exact: origin + path must match exactly
  // - prefix: origin matches and marker.path is a prefix of current path
  // - host: host matches regardless of path
  return all.filter((m) => {
    if (!m) return false;
    if (m.matchType === 'exact') return m.origin === origin && m.path === path;
    if (m.matchType === 'host') return !!m.host && m.host === host;
    // default 'prefix'
    return m.origin === origin && (m.path ? path.startsWith(m.path) : true);
  });
}

export async function saveMarker(req: UpsertMarkerRequest): Promise<ElementMarker> {
  const { url: rawUrl, selector } = req;
  if (!rawUrl || !selector) throw new Error('url and selector are required');
  const { url, origin, host, path } = normalizeUrl(rawUrl);
  const ts = now();
  const marker: ElementMarker = {
    id: req.id || (globalThis.crypto?.randomUUID?.() ?? `${ts}_${Math.random()}`),
    url,
    origin,
    host,
    path,
    matchType: req.matchType || 'prefix',
    name: req.name || selector,
    selector,
    selectorType: req.selectorType || 'css',
    listMode: req.listMode || false,
    action: req.action || 'custom',
    createdAt: ts,
    updatedAt: ts,
  };
  await idb.put<ElementMarker>(STORE, marker);
  return marker;
}

export async function updateMarker(marker: ElementMarker): Promise<void> {
  const existing = await idb.get<ElementMarker>(STORE, marker.id);
  if (!existing) throw new Error('marker not found');

  // Preserve createdAt from existing record, only update updatedAt
  const updated: ElementMarker = {
    ...marker,
    createdAt: existing.createdAt, // Never overwrite createdAt
    updatedAt: now(),
  };
  await idb.put<ElementMarker>(STORE, updated);
}

export async function deleteMarker(id: string): Promise<void> {
  await idb.delete(STORE, id);
}
