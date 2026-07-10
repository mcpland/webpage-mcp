import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cdpMocks = vi.hoisted(() => ({
  withSession: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: cdpMocks.withSession,
    sendCommand: cdpMocks.sendCommand,
  },
}));

import { createChromeArtifactService } from '@/entrypoints/background/record-replay-v3/engine/kernel/artifacts';
import {
  createIndexedDbArtifactStore,
  type ArtifactStore,
} from '@/entrypoints/background/record-replay-v3/storage/artifacts';
import {
  closeRrV3Db,
  deleteRrV3Db,
} from '@/entrypoints/background/record-replay-v3/storage/db';

describe('createChromeArtifactService', () => {
  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();

    cdpMocks.withSession.mockReset();
    cdpMocks.sendCommand.mockReset();
    cdpMocks.withSession.mockImplementation(async (_tabId, _owner, fn) => await fn());
    cdpMocks.sendCommand.mockResolvedValue({ data: 'background-shot' });

    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 7, windowId: 2 }),
        captureVisibleTab: vi.fn().mockResolvedValue('data:image/png;base64,visible-shot'),
      },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await deleteRrV3Db();
    closeRrV3Db();
  });

  it('uses CDP without visible-tab fallback for background screenshots', async () => {
    const service = createChromeArtifactService();
    const result = await service.screenshot(7, { background: true });

    expect(result).toEqual({ ok: true, base64: 'background-shot' });
    expect(cdpMocks.withSession).toHaveBeenCalledWith(7, 'rr-v3-artifact-screenshot', expect.any(Function));
    expect(cdpMocks.sendCommand).toHaveBeenCalledWith(7, 'Page.captureScreenshot', { format: 'png' });
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('returns an error without visible-tab fallback when background CDP capture fails', async () => {
    cdpMocks.sendCommand.mockRejectedValueOnce(new Error('debugger unavailable'));
    const service = createChromeArtifactService();
    const result = await service.screenshot(7, { background: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('debugger unavailable');
    }
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('uses captureVisibleTab for foreground screenshots', async () => {
    const service = createChromeArtifactService();
    const result = await service.screenshot(7);

    expect(result).toEqual({ ok: true, base64: 'visible-shot' });
    expect(chrome.tabs.get).toHaveBeenCalledWith(7);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(2, {
      format: 'png',
      quality: undefined,
    });
    expect(cdpMocks.withSession).not.toHaveBeenCalled();
  });

  it('persists saved screenshots in IndexedDB across service instances', async () => {
    const service = createChromeArtifactService({
      now: () => 1_700_000_000_000,
    });

    const saveResult = await service.saveScreenshot(
      'run-artifacts' as never,
      'node-a' as never,
      'c2NyZWVuc2hvdA==',
      'failure.png',
    );

    expect(saveResult).toMatchObject({ savedAs: 'failure.png' });
    expect('artifactId' in saveResult && saveResult.artifactId).toBeTruthy();

    const nextService = createChromeArtifactService();
    const artifacts = await nextService.listArtifacts?.('run-artifacts' as never);
    expect(artifacts).toEqual([
      expect.objectContaining({
        savedAs: 'failure.png',
        sizeBytes: 10,
        originalSizeBytes: 10,
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        truncated: false,
        provenance: { source: 'runtimeCapture', trust: 'untrusted' },
        redaction: expect.objectContaining({
          status: 'lowConfidence',
          confidence: 'low',
        }),
      }),
    ]);
  });

  it('redacts sensitive filenames before persisting artifacts', async () => {
    const service = createChromeArtifactService();

    const saveResult = await service.saveScreenshot(
      'run-redact' as never,
      'node-a' as never,
      'c2NyZWVuc2hvdA==',
      '/Users/alice/Downloads/password=my-secret-token.png',
    );

    expect(saveResult).toMatchObject({ savedAs: '[REDACTED].png' });
    const artifacts = await service.listArtifacts?.('run-redact' as never);
    expect(artifacts?.[0]?.savedAs).not.toContain('/Users/alice');
    expect(artifacts?.[0]?.savedAs).not.toContain('password');
    expect(artifacts?.[0]?.savedAs).not.toContain('secret');
    expect(artifacts?.[0]?.savedAs).not.toContain('token');
    expect(artifacts?.[0]?.provenance).toEqual({
      source: 'runtimeCapture',
      trust: 'untrusted',
    });
    expect(artifacts?.[0]?.redaction).toMatchObject({
      status: 'lowConfidence',
      confidence: 'low',
    });
  });

  it('maps artifact storage quota failures to RESOURCE_LIMIT_EXCEEDED', async () => {
    const quotaError = Object.assign(new Error('quota exceeded while writing artifact'), {
      name: 'QuotaExceededError',
    });
    const store: ArtifactStore = {
      saveScreenshot: vi.fn().mockRejectedValue(quotaError),
      get: vi.fn(),
      listByRun: vi.fn(),
      deleteByRun: vi.fn(),
      cleanupExpired: vi.fn(),
      enforceRetention: vi.fn(),
    };
    const service = createChromeArtifactService({ store });

    const saveResult = await service.saveScreenshot(
      'run-quota' as never,
      'node-a' as never,
      'c2NyZWVuc2hvdA==',
    );

    expect(saveResult).toMatchObject({
      error: {
        code: 'RESOURCE_LIMIT_EXCEEDED',
        retryable: false,
        data: {
          source: 'artifact_store',
          originalCode: 'QuotaExceededError',
        },
      },
    });
  });

  it('applies TTL and run-scoped cleanup', async () => {
    let now = 1_000;
    const store = createIndexedDbArtifactStore({ ttlMs: 10 }, () => now);
    const service = createChromeArtifactService({ store });

    await service.saveScreenshot('run-ttl' as never, 'node-a' as never, 'b2xk');
    now = 1_011;

    expect(await service.cleanupArtifacts?.()).toEqual({ deleted: 1 });
    expect(await service.listArtifacts?.('run-ttl' as never)).toEqual([]);

    await service.saveScreenshot('run-delete' as never, 'node-a' as never, 'bmV3');
    await service.saveScreenshot('run-delete' as never, 'node-b' as never, 'bmV3Mg==');
    expect(await service.deleteRunArtifacts?.('run-delete' as never)).toEqual({ deleted: 2 });
    expect(await service.listArtifacts?.('run-delete' as never)).toEqual([]);
  });

  it('enforces total size retention by pruning oldest artifacts', async () => {
    let now = 10;
    const store = createIndexedDbArtifactStore({ maxTotalBytes: 6 }, () => now);
    const service = createChromeArtifactService({ store });

    await service.saveScreenshot('run-size' as never, 'node-a' as never, 'YWJjZA=='); // 4 bytes
    now = 20;
    await service.saveScreenshot('run-size' as never, 'node-b' as never, 'ZWZnaA=='); // 4 bytes

    const artifacts = await service.listArtifacts?.('run-size' as never);
    expect(artifacts).toHaveLength(1);
    expect(artifacts?.[0]?.savedAs).toContain('node-b');
  });

  it('caps zero-byte artifact summaries by total record count', async () => {
    let now = 10;
    const store = createIndexedDbArtifactStore(
      { maxArtifactBytes: 1, maxTotalArtifacts: 2 },
      () => now,
    );

    await store.saveScreenshot({
      runId: 'run-old' as never,
      nodeId: 'node-a' as never,
      base64: 'YWJjZA==',
    });
    now = 20;
    await store.saveScreenshot({
      runId: 'run-middle' as never,
      nodeId: 'node-a' as never,
      base64: 'YWJjZA==',
    });
    now = 30;
    await store.saveScreenshot({
      runId: 'run-new' as never,
      nodeId: 'node-a' as never,
      base64: 'YWJjZA==',
    });

    await expect(store.listByRun('run-old' as never)).resolves.toEqual([]);
    await expect(store.listByRun('run-middle' as never)).resolves.toHaveLength(1);
    await expect(store.listByRun('run-new' as never)).resolves.toHaveLength(1);
  });

  it('stores a truncated summary when artifacts exceed the normalized size budget', async () => {
    const store = createIndexedDbArtifactStore(
      { maxTotalBytes: 3, maxArtifactBytes: 10 },
      () => 10,
    );
    const service = createChromeArtifactService({ store });

    const saveResult = await service.saveScreenshot(
      'run-too-large' as never,
      'node-a' as never,
      'YWJjZA==', // 4 bytes
    );

    expect(saveResult).toMatchObject({ savedAs: expect.stringContaining('node-a') });
    expect(await service.listArtifacts?.('run-too-large' as never)).toEqual([
      expect.objectContaining({
        sizeBytes: 0,
        originalSizeBytes: 4,
        truncated: true,
        redaction: expect.objectContaining({
          status: 'lowConfidence',
          confidence: 'low',
        }),
      }),
    ]);
  });

  it('keeps the just-saved artifact when same-timestamp records exceed retention', async () => {
    const store = createIndexedDbArtifactStore(
      { maxTotalBytes: 4, maxArtifactsPerRun: 1 },
      () => 10,
    );
    const service = createChromeArtifactService({ store });

    await service.saveScreenshot('run-same-time' as never, 'node-a' as never, 'YWJjZA==');
    await service.saveScreenshot('run-same-time' as never, 'node-b' as never, 'ZWZnaA==');

    const artifacts = await service.listArtifacts?.('run-same-time' as never);
    expect(artifacts).toHaveLength(1);
    expect(artifacts?.[0]?.savedAs).toContain('node-b');
  });
});
