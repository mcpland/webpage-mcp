import { webcrypto } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PINNED_MODEL_ARTIFACTS,
  resolvePinnedModelArtifact,
  verifyPinnedModelArtifact,
} from '@/utils/model-assets';

describe('remote model asset integrity', () => {
  beforeAll(() => {
    vi.stubGlobal('crypto', webcrypto);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('uses immutable revisions and expected LFS metadata for every model', () => {
    for (const [modelIdentifier, manifest] of Object.entries(PINNED_MODEL_ARTIFACTS)) {
      expect(manifest.revision).toMatch(/^[0-9a-f]{40}$/);

      const artifact = resolvePinnedModelArtifact(modelIdentifier, 'model_quantized.onnx');
      expect(artifact.url).toContain(`/resolve/${manifest.revision}/`);
      expect(artifact.url).not.toContain('/resolve/main/');
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.size).toBeGreaterThan(0);
    }
  });

  it('normalizes known Xenova identifiers without weakening the allowlist', () => {
    const artifact = resolvePinnedModelArtifact(
      'multilingual-e5-small',
      'model_quantized.onnx',
    );

    expect(artifact.modelIdentifier).toBe('Xenova/multilingual-e5-small');
    expect(artifact.revision).toBe('761b726dd34fb83930e26aab4e9ac3899aa1fa78');
  });

  it('fails closed for unpinned repositories and files', () => {
    expect(() => resolvePinnedModelArtifact('attacker/model', 'model_quantized.onnx')).toThrow(
      'is not in the pinned model manifest',
    );
    expect(() =>
      resolvePinnedModelArtifact('Xenova/multilingual-e5-small', 'model.onnx'),
    ).toThrow('is not in the pinned model manifest');
  });

  it('accepts only bytes matching both the size and SHA-256', async () => {
    const bytes = new TextEncoder().encode('abc');
    const artifact = {
      modelIdentifier: 'test/model',
      path: 'onnx/model.onnx',
      size: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    };

    await expect(verifyPinnedModelArtifact(bytes.buffer, artifact)).resolves.toBeUndefined();
    await expect(
      verifyPinnedModelArtifact(bytes.buffer, { ...artifact, size: 4 }),
    ).rejects.toThrow('expected 4 bytes, got 3');
    await expect(
      verifyPinnedModelArtifact(bytes.buffer, { ...artifact, sha256: '0'.repeat(64) }),
    ).rejects.toThrow('expected SHA-256');
  });

  it('fails closed when SHA-256 is unavailable', async () => {
    const bytes = new TextEncoder().encode('abc');
    vi.stubGlobal('crypto', {});

    await expect(
      verifyPinnedModelArtifact(bytes.buffer, {
        modelIdentifier: 'test/model',
        path: 'onnx/model.onnx',
        size: 3,
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      }),
    ).rejects.toThrow('Web Crypto SHA-256 is unavailable');

    vi.stubGlobal('crypto', webcrypto);
  });
});
