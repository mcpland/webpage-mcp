/**
 * @fileoverview Durable V3 artifact storage
 * @description IndexedDB-backed debug artifacts with retention and redaction.
 */

import type { NodeId, RunId } from "../domain/ids";
import { jsonUtf8ByteLength } from "../domain/json-limits";
import { isSensitiveKeyName } from "../flows/sensitive";
import { RR_V3_STORES, withTransaction } from "./db";

export type ArtifactKind = "screenshot";
export type ArtifactProvenanceSource = "runtimeCapture" | "pageContent";
export type ArtifactTrust = "untrusted";
export type ArtifactRedactionStatus = "redacted" | "notRequired" | "lowConfidence";
export type ArtifactRedactionConfidence = "high" | "medium" | "low";

export interface ArtifactProvenance {
  source: ArtifactProvenanceSource;
  trust: ArtifactTrust;
}

export interface ArtifactRedaction {
  status: ArtifactRedactionStatus;
  confidence: ArtifactRedactionConfidence;
  warnings?: string[];
}

export interface ArtifactRecord {
  id: string;
  runId: RunId;
  nodeId: NodeId;
  kind: ArtifactKind;
  filename: string;
  mimeType: "image/png" | "image/jpeg";
  dataBase64: string;
  sizeBytes: number;
  originalSizeBytes?: number;
  truncated?: boolean;
  createdAt: number;
  expiresAt: number;
  ttlMs?: number;
  provenance?: ArtifactProvenance;
  redaction?: ArtifactRedaction;
  metadata?: Record<string, string | number | boolean | null>;
}

export type ArtifactMetadataRecord = Omit<ArtifactRecord, "dataBase64">;

export interface ArtifactRetentionPolicy {
  ttlMs: number;
  maxTotalBytes: number;
  maxTotalArtifacts: number;
  maxArtifactBytes: number;
  maxArtifactsPerRun: number;
}

export interface SaveScreenshotArtifactInput {
  runId: RunId;
  nodeId: NodeId;
  base64: string;
  filename?: string;
  mimeType?: "image/png" | "image/jpeg";
  metadata?: Record<string, unknown>;
  provenance?: ArtifactProvenance;
  redaction?: ArtifactRedaction;
}

export interface ArtifactStore {
  saveScreenshot(input: SaveScreenshotArtifactInput): Promise<ArtifactRecord>;
  get(id: string): Promise<ArtifactRecord | null>;
  listByRun(runId: RunId): Promise<ArtifactMetadataRecord[]>;
  deleteByRun(runId: RunId): Promise<number>;
  cleanupExpired(now?: number): Promise<number>;
  enforceRetention(): Promise<number>;
}

export const DEFAULT_ARTIFACT_RETENTION: ArtifactRetentionPolicy = {
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxTotalArtifacts: 1_000,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxArtifactsPerRun: 100,
};

const DEFAULT_SCREENSHOT_REDACTION_WARNING =
  "Screenshot pixel content has low-confidence redaction; binary data is not inlined in MCP debug responses.";
const MAX_ARTIFACT_METADATA_LIST_UTF8_BYTES = 4 * 1024 * 1024;

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  hardMax: number,
): number {
  return Number.isFinite(value)
    ? Math.min(hardMax, Math.max(1, Math.floor(value as number)))
    : fallback;
}

function normalizeRetentionPolicy(
  overrides: Partial<ArtifactRetentionPolicy>,
): ArtifactRetentionPolicy {
  const maxTotalBytes = boundedPositiveInteger(
    overrides.maxTotalBytes,
    DEFAULT_ARTIFACT_RETENTION.maxTotalBytes,
    DEFAULT_ARTIFACT_RETENTION.maxTotalBytes,
  );
  return {
    ttlMs: boundedPositiveInteger(
      overrides.ttlMs,
      DEFAULT_ARTIFACT_RETENTION.ttlMs,
      DEFAULT_ARTIFACT_RETENTION.ttlMs,
    ),
    maxTotalBytes,
    maxTotalArtifacts: boundedPositiveInteger(
      overrides.maxTotalArtifacts,
      DEFAULT_ARTIFACT_RETENTION.maxTotalArtifacts,
      DEFAULT_ARTIFACT_RETENTION.maxTotalArtifacts,
    ),
    maxArtifactBytes: Math.min(
      maxTotalBytes,
      boundedPositiveInteger(
        overrides.maxArtifactBytes,
        DEFAULT_ARTIFACT_RETENTION.maxArtifactBytes,
        DEFAULT_ARTIFACT_RETENTION.maxArtifactBytes,
      ),
    ),
    maxArtifactsPerRun: boundedPositiveInteger(
      overrides.maxArtifactsPerRun,
      DEFAULT_ARTIFACT_RETENTION.maxArtifactsPerRun,
      DEFAULT_ARTIFACT_RETENTION.maxArtifactsPerRun,
    ),
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function estimateBase64Bytes(base64: string): number {
  const normalized = base64.trim();
  if (!normalized) return 0;
  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
      ? 1
      : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function basename(value: string): string {
  const trimmed = value.trim();
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function clampFilename(value: string): string {
  return value.replace(/[^\w.\-()[\] ]+/g, "_").slice(0, 160);
}

function redactSensitiveText(value: string): string {
  const queryRedacted = value.replace(
    /([?&;]|^)([^=?&;\s]*(?:authorization|auth|bearer|cookie|credential|key|password|secret|session|token)[^=?&;\s]*)=([^?&;\s]+)/gi,
    (_match, prefix: string, key: string) => `${prefix}${key}=[REDACTED]`,
  );

  return queryRedacted
    .split(/([_.\-\s()[\]])/)
    .map((part) => (isSensitiveKeyName(part) ? "[REDACTED]" : part))
    .join("");
}

export function sanitizeArtifactFilename(
  filename: string | undefined,
  fallback: string,
): string {
  const boundedFilename =
    typeof filename === "string" ? filename.slice(0, 2_048).trim() : "";
  const raw = boundedFilename || fallback.slice(0, 2_048).trim();
  const base = basename(raw);
  const dotIndex = base.lastIndexOf(".");
  const hasExtension = dotIndex > 0 && dotIndex < base.length - 1;
  const stem = hasExtension ? base.slice(0, dotIndex) : base;
  const extension = hasExtension
    ? clampFilename(base.slice(dotIndex)).slice(0, 16)
    : "";
  const redacted = redactSensitiveText(stem);
  const clamped = clampFilename(redacted).replace(
    /(?:\[REDACTED\]){2,}/g,
    "[REDACTED]",
  );
  return clamped ? `${clamped}${extension}` : fallback;
}

function sanitizeMetadata(
  metadata?: Record<string, unknown>,
): Record<string, string | number | boolean | null> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  let acceptedEntries = 0;
  let inspectedEntries = 0;
  for (const key in metadata) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) continue;
    inspectedEntries += 1;
    if (acceptedEntries >= 32 || inspectedEntries > 128) break;
    const value = metadata[key];
    const boundedKey = key.slice(0, 512);
    const safeKey = isSensitiveKeyName(boundedKey)
      ? "[REDACTED]"
      : clampFilename(boundedKey).slice(0, 80);
    if (!safeKey) continue;
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[safeKey] = value;
      acceptedEntries += 1;
    } else if (typeof value === "string") {
      out[safeKey] = redactSensitiveText(value.slice(0, 2_000)).slice(0, 500);
      acceptedEntries += 1;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeWarning(value: string): string {
  return redactSensitiveText(value.slice(0, 1_200)).slice(0, 300);
}

function normalizeArtifactProvenance(
  provenance?: ArtifactProvenance,
): ArtifactProvenance {
  return {
    source:
      provenance?.source === "pageContent" ? "pageContent" : "runtimeCapture",
    trust: "untrusted",
  };
}

function normalizeArtifactRedaction(
  redaction: ArtifactRedaction | undefined,
  warnings: string[] = [],
): ArtifactRedaction {
  const status =
    redaction?.status === "redacted" ||
    redaction?.status === "notRequired" ||
    redaction?.status === "lowConfidence"
      ? redaction.status
      : "lowConfidence";
  const confidence =
    redaction?.confidence === "high" ||
    redaction?.confidence === "medium" ||
    redaction?.confidence === "low"
      ? redaction.confidence
      : status === "lowConfidence"
        ? "low"
        : "medium";
  const safeWarnings: string[] = [];
  const appendWarnings = (values: readonly unknown[]) => {
    const inspected = Math.min(values.length, 16);
    for (let index = 0; index < inspected && safeWarnings.length < 5; index += 1) {
      const warning = values[index];
      if (typeof warning !== "string") continue;
      const trimmed = warning.slice(0, 1_200).trim();
      if (trimmed) safeWarnings.push(sanitizeWarning(trimmed));
    }
  };
  appendWarnings(warnings);
  if (Array.isArray(redaction?.warnings)) {
    appendWarnings(redaction.warnings);
  }

  return {
    status,
    confidence,
    ...(safeWarnings.length > 0 ? { warnings: safeWarnings } : {}),
  };
}

function retainedSize(record: ArtifactRecord, maxTotalBytes: number): number {
  if (!Number.isFinite(record.sizeBytes) || record.sizeBytes <= 0) return 0;
  return Math.min(maxTotalBytes + 1, Math.floor(record.sizeBytes));
}

function omitArtifactPayload(record: ArtifactRecord): ArtifactMetadataRecord {
  const metadata = { ...record } as Partial<ArtifactRecord>;
  delete metadata.dataBase64;
  return metadata as ArtifactMetadataRecord;
}

export function createIndexedDbArtifactStore(
  policyOverrides: Partial<ArtifactRetentionPolicy> = {},
  now: () => number = () => Date.now(),
): ArtifactStore {
  const policy = normalizeRetentionPolicy(policyOverrides);
  const enforceRetentionInStore = async (
    store: IDBObjectStore,
    protectedIds: ReadonlySet<string> = new Set(),
  ): Promise<number> => {
    const runCounts = new Map<string, number>();
    let retainedArtifacts = 0;
    let retainedBytes = 0;

    // Reserve protected records before scanning so a same-timestamp record
    // cannot consume their retention budget first.
    for (const id of protectedIds) {
      const record = await requestToPromise(
        store.get(id) as IDBRequest<ArtifactRecord | undefined>,
      );
      if (!record) continue;
      retainedArtifacts += 1;
      retainedBytes += retainedSize(record, policy.maxTotalBytes);
      runCounts.set(record.runId, (runCounts.get(record.runId) ?? 0) + 1);
    }

    return new Promise<number>((resolve, reject) => {
      let deleted = 0;
      const request = store.index("createdAt").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(deleted);
          return;
        }
        const record = cursor.value as ArtifactRecord;
        if (protectedIds.has(record.id)) {
          cursor.continue();
          return;
        }

        const runCount = runCounts.get(record.runId) ?? 0;
        const sizeBytes = retainedSize(record, policy.maxTotalBytes);
        const canRetain =
          retainedArtifacts < policy.maxTotalArtifacts &&
          runCount < policy.maxArtifactsPerRun &&
          sizeBytes <= policy.maxTotalBytes - retainedBytes;
        if (canRetain) {
          retainedArtifacts += 1;
          retainedBytes += sizeBytes;
          runCounts.set(record.runId, runCount + 1);
        } else {
          cursor.delete();
          deleted += 1;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  };

  const deleteExpiredInStore = (
    store: IDBObjectStore,
    cutoff: number,
  ): Promise<number> => {
    return new Promise<number>((resolve, reject) => {
      let deleted = 0;
      const request = store
        .index("expiresAt")
        .openKeyCursor(IDBKeyRange.upperBound(cutoff));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(deleted);
          return;
        }
        store.delete(cursor.primaryKey);
        deleted += 1;
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  };

  const enforceRetention = async (): Promise<number> => {
    return withTransaction(
      RR_V3_STORES.ARTIFACTS,
      "readwrite",
      async (stores) =>
        enforceRetentionInStore(stores[RR_V3_STORES.ARTIFACTS]),
    );
  };

  const storeApi: ArtifactStore = {
    async saveScreenshot(input) {
      const createdAt = now();
      const rawBase64 = typeof input.base64 === "string" ? input.base64 : "";
      const maxEncodedChars =
        Math.ceil((DEFAULT_ARTIFACT_RETENTION.maxArtifactBytes * 4) / 3) + 4;
      const canNormalizePayload = rawBase64.length <= maxEncodedChars;
      const safeBase64 = canNormalizePayload ? rawBase64.trim() : "";
      const originalSizeBytes = canNormalizePayload
        ? estimateBase64Bytes(safeBase64)
        : Math.floor((rawBase64.length * 3) / 4);
      if (originalSizeBytes <= 0) {
        throw new Error("Artifact screenshot is empty");
      }
      const truncated = originalSizeBytes > policy.maxArtifactBytes;
      const sizeBytes = truncated ? 0 : originalSizeBytes;
      const ttlMs = Math.max(1, policy.ttlMs);

      const fallbackName = `${input.runId}_${input.nodeId}_${createdAt}.png`;
      const filename = sanitizeArtifactFilename(input.filename, fallbackName);
      const id = `${input.runId}/${input.nodeId}/${createdAt}_${Math.random().toString(36).slice(2, 8)}`;
      const redactionWarnings = [
        DEFAULT_SCREENSHOT_REDACTION_WARNING,
        ...(truncated
          ? [
              `Artifact payload omitted because original size ${originalSizeBytes} exceeds maxArtifactBytes ${policy.maxArtifactBytes}.`,
            ]
          : []),
      ];
      const record: ArtifactRecord = {
        id,
        runId: input.runId,
        nodeId: input.nodeId,
        kind: "screenshot",
        filename,
        mimeType: input.mimeType ?? "image/png",
        dataBase64: truncated ? "" : safeBase64,
        sizeBytes,
        originalSizeBytes,
        truncated,
        createdAt,
        expiresAt: createdAt + ttlMs,
        ttlMs,
        provenance: normalizeArtifactProvenance(input.provenance),
        redaction: normalizeArtifactRedaction(input.redaction, redactionWarnings),
        metadata: sanitizeMetadata(input.metadata),
      };

      await withTransaction(
        RR_V3_STORES.ARTIFACTS,
        "readwrite",
        async (stores) => {
          const store = stores[RR_V3_STORES.ARTIFACTS];
          await requestToPromise(store.put(record));
          await deleteExpiredInStore(store, createdAt);
          await enforceRetentionInStore(store, new Set([record.id]));
        },
      );
      return record;
    },

    async get(id) {
      return withTransaction(
        RR_V3_STORES.ARTIFACTS,
        "readonly",
        async (stores) => {
          const store = stores[RR_V3_STORES.ARTIFACTS];
          const result = await requestToPromise(
            store.get(id) as IDBRequest<ArtifactRecord | undefined>,
          );
          return result ?? null;
        },
      );
    },

    async listByRun(runId) {
      return withTransaction(
        RR_V3_STORES.ARTIFACTS,
        "readonly",
        async (stores) => {
          const store = stores[RR_V3_STORES.ARTIFACTS];
          const index = store.index("runId");
          return new Promise<ArtifactMetadataRecord[]>((resolve, reject) => {
            const records: ArtifactMetadataRecord[] = [];
            let aggregateBytes = 2;
            const request = index.openCursor(IDBKeyRange.only(runId));
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor || records.length >= policy.maxArtifactsPerRun) {
                resolve(records.sort((a, b) => a.createdAt - b.createdAt));
                return;
              }
              const record = omitArtifactPayload(
                cursor.value as ArtifactRecord,
              );
              const recordBytes = jsonUtf8ByteLength(
                record,
                MAX_ARTIFACT_METADATA_LIST_UTF8_BYTES,
              );
              const addedBytes = recordBytes + (records.length > 0 ? 1 : 0);
              if (
                addedBytes >
                MAX_ARTIFACT_METADATA_LIST_UTF8_BYTES - aggregateBytes
              ) {
                resolve(records.sort((a, b) => a.createdAt - b.createdAt));
                return;
              }
              aggregateBytes += addedBytes;
              records.push(record);
              cursor.continue();
            };
            request.onerror = () => reject(request.error);
          });
        },
      );
    },

    async deleteByRun(runId) {
      return withTransaction(
        RR_V3_STORES.ARTIFACTS,
        "readwrite",
        async (stores) => {
          const store = stores[RR_V3_STORES.ARTIFACTS];
          return new Promise<number>((resolve, reject) => {
            let deleted = 0;
            const request = store
              .index("runId")
              .openKeyCursor(IDBKeyRange.only(runId));
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) {
                resolve(deleted);
                return;
              }
              store.delete(cursor.primaryKey);
              deleted += 1;
              cursor.continue();
            };
            request.onerror = () => reject(request.error);
          });
        },
      );
    },

    async cleanupExpired(cleanupNow = now()) {
      const cutoff = Number.isFinite(cleanupNow) ? cleanupNow : now();
      return withTransaction(
        RR_V3_STORES.ARTIFACTS,
        "readwrite",
        async (stores) => {
          const store = stores[RR_V3_STORES.ARTIFACTS];
          return deleteExpiredInStore(store, cutoff);
        },
      );
    },

    enforceRetention,
  };

  return storeApi;
}
