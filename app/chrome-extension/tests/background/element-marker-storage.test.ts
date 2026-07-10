import { beforeEach, describe, expect, it } from 'vitest';

import type { ElementMarker } from '@/common/element-marker-types';
import {
  ELEMENT_MARKER_MAX_COUNT,
  ELEMENT_MARKER_MAX_LIST_BYTES,
  ELEMENT_MARKER_MAX_MATCH_BYTES,
  ELEMENT_MARKER_MAX_MATCHES_PER_URL,
  ELEMENT_MARKER_MAX_SELECTOR_BYTES,
  listAllMarkers,
  listAllMarkersWithMetadata,
  listMarkersForUrlWithMetadata,
  saveMarker,
  updateMarker,
} from '@/entrypoints/background/element-marker/element-marker-storage';

const DB_NAME = 'element_marker_storage';
const STORE = 'markers';

function openMarkerDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runWrite(operation: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openMarkerDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    operation(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
}

async function clearMarkers(): Promise<void> {
  await listAllMarkers();
  await runWrite((store) => store.clear());
}

function storedMarker(index: number, selector = `#target-${index}`): ElementMarker {
  const url = new URL(`/page/${index}`, 'https://example.test/');
  return {
    id: `marker-${index.toString().padStart(4, '0')}`,
    url: url.href,
    origin: url.origin,
    host: url.hostname,
    path: url.pathname,
    matchType: 'host',
    name: `Marker ${index}`,
    selector,
    selectorType: 'css',
    listMode: false,
    action: 'custom',
    createdAt: index + 1,
    updatedAt: index + 1,
  };
}

describe('bounded element marker storage', () => {
  beforeEach(clearMarkers);

  it('canonicalizes records and rejects oversized or malformed fields', async () => {
    const saved = await saveMarker({
      id: 'marker-id',
      url: 'https://example.test/path#fragment',
      name: 'Example',
      selector: '#example',
      matchType: 'exact',
    });

    await updateMarker({
      ...saved,
      origin: 'https://forged.test',
      host: 'forged.test',
      path: '/forged',
      name: 'Updated',
      createdAt: 0,
    });
    expect(await listAllMarkers()).toEqual([
      expect.objectContaining({
        id: 'marker-id',
        url: 'https://example.test/path#fragment',
        origin: 'https://example.test',
        host: 'example.test',
        path: '/path',
        name: 'Updated',
        createdAt: saved.createdAt,
      }),
    ]);

    await expect(
      saveMarker({
        id: 'unnamed-marker',
        url: 'https://example.test/unnamed',
        name: '',
        selector: '#unnamed',
      }),
    ).resolves.toMatchObject({ name: '#unnamed' });

    await expect(
      saveMarker({ url: 'not a URL', name: 'Bad', selector: '#bad' }),
    ).rejects.toThrow('absolute URL');
    await expect(
      saveMarker({
        url: 'https://example.test/',
        name: 'Too large',
        selector: '界'.repeat(ELEMENT_MARKER_MAX_SELECTOR_BYTES),
      }),
    ).rejects.toThrow('selector exceeds');
    await expect(
      saveMarker({
        url: 'https://example.test/',
        name: 'Bad enum',
        selector: '#bad',
        matchType: 'regexp' as never,
      }),
    ).rejects.toThrow('matchType is invalid');
  });

  it('enforces the count quota atomically across concurrent saves', async () => {
    await runWrite((store) => {
      for (let index = 0; index < ELEMENT_MARKER_MAX_COUNT - 2; index += 1) {
        store.put(storedMarker(index));
      }
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        saveMarker({
          id: `concurrent-${index}`,
          url: `https://concurrent-${index}.test/`,
          name: `Concurrent ${index}`,
          selector: '#target',
        }),
      ),
    );

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(2);
    expect(await listAllMarkers()).toHaveLength(ELEMENT_MARKER_MAX_COUNT);
  });

  it('bounds management and URL-matched result counts and bytes', async () => {
    const largeSelector = `[data-value="${'x'.repeat(7 * 1024)}"]`;
    await runWrite((store) => {
      for (let index = 0; index < ELEMENT_MARKER_MAX_COUNT + 40; index += 1) {
        store.put(storedMarker(index, largeSelector));
      }
    });

    const allResult = await listAllMarkersWithMetadata();
    const matchedResult = await listMarkersForUrlWithMetadata(
      'https://example.test/current',
    );
    const all = allResult.markers;
    const matched = matchedResult.markers;

    expect(allResult.truncated).toBe(true);
    expect(all.length).toBeLessThanOrEqual(ELEMENT_MARKER_MAX_COUNT);
    expect(new TextEncoder().encode(JSON.stringify(all)).byteLength).toBeLessThanOrEqual(
      ELEMENT_MARKER_MAX_LIST_BYTES,
    );
    expect(matched.length).toBeLessThanOrEqual(ELEMENT_MARKER_MAX_MATCHES_PER_URL);
    expect(matchedResult.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(matched)).byteLength).toBeLessThanOrEqual(
      ELEMENT_MARKER_MAX_MATCH_BYTES,
    );
  });
});
