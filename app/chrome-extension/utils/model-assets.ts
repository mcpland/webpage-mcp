export interface PinnedModelArtifact {
  modelIdentifier: string;
  revision: string;
  path: string;
  sha256: string;
  size: number;
  url: string;
  legacyCacheUrl: string;
}

interface ModelArtifactManifest {
  revision: string;
  files: Record<
    string,
    {
      sha256: string;
      size: number;
    }
  >;
}

/**
 * Immutable Hugging Face revisions and LFS object metadata.
 *
 * Source: the Hugging Face model API with `blobs=true`. The LFS SHA-256 is
 * also returned as `x-linked-etag` by the pinned resolve endpoint.
 */
export const PINNED_MODEL_ARTIFACTS: Readonly<Record<string, ModelArtifactManifest>> = {
  'Xenova/multilingual-e5-small': {
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    files: {
      'onnx/model_quantized.onnx': {
        sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
        size: 118_308_185,
      },
    },
  },
  'Xenova/multilingual-e5-base': {
    revision: '1ec9243030a27d1a115d5c340572074c125b58b2',
    files: {
      'onnx/model_quantized.onnx': {
        sha256: 'df7a9a29309e3ad491e1783adf8baee710262cc06079c7cbab63c630277fac94',
        size: 278_647_662,
      },
    },
  },
};

function normalizeModelIdentifier(modelIdentifier: string): string {
  return modelIdentifier.includes('/') ? modelIdentifier : `Xenova/${modelIdentifier}`;
}

export function resolvePinnedModelArtifact(
  modelIdentifier: string,
  onnxModelFile: string,
): PinnedModelArtifact {
  const normalizedIdentifier = normalizeModelIdentifier(modelIdentifier);
  const manifest = PINNED_MODEL_ARTIFACTS[normalizedIdentifier];

  if (!manifest) {
    throw new Error(
      `Remote model "${normalizedIdentifier}" is not in the pinned model manifest. ` +
        'Remote models must declare an immutable revision and SHA-256 before they can be loaded.',
    );
  }

  const path = `onnx/${onnxModelFile}`;
  const file = manifest.files[path];
  if (!file) {
    throw new Error(
      `Remote model artifact "${normalizedIdentifier}/${path}" is not in the pinned model manifest.`,
    );
  }

  const encodedRevision = encodeURIComponent(manifest.revision);
  const encodedPath = path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const baseUrl = `https://huggingface.co/${normalizedIdentifier}/resolve`;

  return {
    modelIdentifier: normalizedIdentifier,
    revision: manifest.revision,
    path,
    sha256: file.sha256,
    size: file.size,
    url: `${baseUrl}/${encodedRevision}/${encodedPath}`,
    legacyCacheUrl: `${baseUrl}/main/${encodedPath}`,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyPinnedModelArtifact(
  data: ArrayBuffer,
  artifact: Pick<PinnedModelArtifact, 'modelIdentifier' | 'path' | 'sha256' | 'size'>,
): Promise<void> {
  const label = `${artifact.modelIdentifier}/${artifact.path}`;

  if (data.byteLength !== artifact.size) {
    throw new Error(
      `Model integrity check failed for ${label}: expected ${artifact.size} bytes, got ${data.byteLength}.`,
    );
  }

  if (!globalThis.crypto?.subtle) {
    throw new Error(`Model integrity check failed for ${label}: Web Crypto SHA-256 is unavailable.`);
  }

  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  const actualSha256 = bytesToHex(new Uint8Array(digest));
  if (actualSha256 !== artifact.sha256) {
    throw new Error(
      `Model integrity check failed for ${label}: expected SHA-256 ${artifact.sha256}, got ${actualSha256}.`,
    );
  }
}
