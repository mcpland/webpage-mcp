import { describe, expect, it, vi } from 'vitest';

import {
  NETWORK_CAPTURE_LIMITS,
  boundCaptureResult,
  canAttachBeforeNavigation,
  fillMissingCaptureTabTitle,
  jsonByteLength,
  normalizeCaptureTimings,
  normalizeEventTime,
  responseBodyKnownTooLarge,
  sanitizeHeaderRecord,
  serializeBoundedFormData,
  truncateUtf8,
  utf8ByteLength,
} from '@/entrypoints/background/tools/browser/network-capture-limits';

describe('network capture resource limits', () => {
  it('normalizes disabled, non-finite, and excessive lifecycle timings', () => {
    expect(normalizeCaptureTimings({ maxCaptureTime: 0, inactivityTimeout: -1 })).toEqual({
      maxCaptureTime: NETWORK_CAPTURE_LIMITS.defaultCaptureTimeMs,
      inactivityTimeout: NETWORK_CAPTURE_LIMITS.defaultInactivityMs,
    });
    expect(
      normalizeCaptureTimings({ maxCaptureTime: Number.POSITIVE_INFINITY, inactivityTimeout: NaN }),
    ).toEqual({
      maxCaptureTime: NETWORK_CAPTURE_LIMITS.defaultCaptureTimeMs,
      inactivityTimeout: NETWORK_CAPTURE_LIMITS.defaultInactivityMs,
    });
    expect(normalizeCaptureTimings({ maxCaptureTime: 99_999_999, inactivityTimeout: 99_999_999 }))
      .toEqual({
        maxCaptureTime: NETWORK_CAPTURE_LIMITS.maxCaptureTimeMs,
        inactivityTimeout: NETWORK_CAPTURE_LIMITS.maxInactivityMs,
      });
  });

  it('truncates strings and structured headers by UTF-8 bytes', () => {
    const bounded = truncateUtf8('界'.repeat(100), 10);
    expect(utf8ByteLength(bounded)).toBeLessThanOrEqual(10);

    const headers = sanitizeHeaderRecord(
      Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `x-header-${index}`,
          '值'.repeat(NETWORK_CAPTURE_LIMITS.maxHeaderValueBytes),
        ]),
      ),
    );
    expect(Object.keys(headers).length).toBeLessThanOrEqual(
      NETWORK_CAPTURE_LIMITS.maxHeaderEntries,
    );
    expect(jsonByteLength(headers)).toBeLessThanOrEqual(NETWORK_CAPTURE_LIMITS.maxHeadersBytes);
  });

  it('serializes form data without materializing unbounded values', () => {
    const serialized = serializeBoundedFormData({
      huge: Array.from({ length: 100 }, () => 'x'.repeat(100_000)),
    });
    expect(utf8ByteLength(serialized)).toBeLessThanOrEqual(
      NETWORK_CAPTURE_LIMITS.maxRequestBodyBytes,
    );
  });

  it('skips response bodies whose known encoded or declared size is excessive', () => {
    expect(
      responseBodyKnownTooLarge({
        encodedDataLength: NETWORK_CAPTURE_LIMITS.maxResponseBodyBytes + 1,
      }),
    ).toBe(true);
    expect(
      responseBodyKnownTooLarge({
        responseHeaders: {
          'Content-Length': String(NETWORK_CAPTURE_LIMITS.maxResponseBodyBytes + 1),
        },
      }),
    ).toBe(true);
    expect(responseBodyKnownTooLarge({ encodedDataLength: 1_024 })).toBe(false);
  });

  it('caps the final JSON result and normalizes invalid event clocks', () => {
    const result = boundCaptureResult({
      success: true,
      requests: Array.from({ length: 20 }, (_, index) => ({
        id: index,
        body: 'x'.repeat(512 * 1024),
      })),
    });
    expect(result.resultTruncated).toBe(true);
    expect(jsonByteLength(result)).toBeLessThanOrEqual(NETWORK_CAPTURE_LIMITS.maxCaptureBytes);
    expect(normalizeEventTime(-1)).toBeUndefined();
    expect(normalizeEventTime(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('excludes extension stores from pre-navigation debugger attachment', () => {
    expect(canAttachBeforeNavigation('https://example.com/')).toBe(true);
    expect(canAttachBeforeNavigation('about:blank')).toBe(true);
    expect(canAttachBeforeNavigation('chrome://newtab/')).toBe(false);
    expect(canAttachBeforeNavigation('https://chromewebstore.google.com/detail/foo')).toBe(false);
    expect(canAttachBeforeNavigation('https://chrome.google.com/webstore/detail/foo')).toBe(false);
    expect(canAttachBeforeNavigation('https://microsoftedge.microsoft.com/addons/detail/foo')).toBe(
      false,
    );
  });

  it('fills missing tabTitle only from HTTP(S) tabs', async () => {
    const originalTabs = (globalThis.chrome as any).tabs;
    const tabsGet = vi.fn();
    (globalThis.chrome as any).tabs = { ...originalTabs, get: tabsGet };
    try {
      tabsGet.mockResolvedValueOnce({ url: 'file:///tmp/secret.txt', title: 'Secret File' });
      const nonPublic = { tabTitle: '' };
      await fillMissingCaptureTabTitle(7, nonPublic);
      expect(nonPublic.tabTitle).toBe('');

      tabsGet.mockResolvedValueOnce({ url: 'https://example.com/', title: 'Public Title' });
      const pub = { tabTitle: '' };
      await fillMissingCaptureTabTitle(7, pub);
      expect(pub.tabTitle).toBe('Public Title');
    } finally {
      (globalThis.chrome as any).tabs = originalTabs;
    }
  });
});
