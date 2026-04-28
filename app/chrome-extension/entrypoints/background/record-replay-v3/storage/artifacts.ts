/**
 * @fileoverview Durable V3 artifact storage
 * @description IndexedDB-backed debug artifacts with retention and redaction.
 */

import type { NodeId, RunId } from "../domain/ids";
import { isSensitiveKeyName } from "../flows/sensitive";
import { RR_V3_STORES, withTransaction } from "./db";

export type ArtifactKind = "screenshot";

export interface ArtifactRecord {
  id: string;
  runId: RunId;
  nodeId: NodeId;
  kind: ArtifactKind;
  filename: string;
  mimeType: "image/png" | "image/jpeg";
  dataBase64: string;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ArtifactRetentionPolicy {
  ttlMs: number;
  maxTotalBytes: number;
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
}

export interface ArtifactStore {
  saveScreenshot(input: SaveScreenshotArtifactInput): Promise<ArtifactRecord>;
  get(id: string): Promise<ArtifactRecord | null>;
  listByRun(runId: RunId): Promise<ArtifactRecord[]>;
  deleteByRun(runId: RunId): Promise<number>;
  cleanupExpired(now?: number): Promise<number>;
  enforceRetention(): Promise<number>;
}

export const DEFAULT_ARTIFACT_RETENTION: ArtifactRetentionPolicy = {
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxArtifactsPerRun: 100,
};

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function normalizeRetentionPolicy(
  overrides: Partial<ArtifactRetentionPolicy>,
): ArtifactRetentionPolicy {
  const merged = { ...DEFAULT_ARTIFACT_RETENTION, ...overrides };
  const maxTotalBytes = positiveInteger(
    merged.maxTotalBytes,
    DEFAULT_ARTIFACT_RETENTION.maxTotalBytes,
  );
  return {
    ttlMs: positiveInteger(merged.ttlMs, DEFAULT_ARTIFACT_RETENTION.ttlMs),
    maxTotalBytes,
    maxArtifactBytes: Math.min(
      maxTotalBytes,
      positiveInteger(
        merged.maxArtifactBytes,
        DEFAULT_ARTIFACT_RETENTION.maxArtifactBytes,
      ),
    ),
    maxArtifactsPerRun: positiveInteger(
      merged.maxArtifactsPerRun,
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
  const raw = filename && filename.trim() ? filename : fallback;
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
  for (const [key, value] of Object.entries(metadata)) {
    const safeKey = isSensitiveKeyName(key)
      ? "[REDACTED]"
      : clampFilename(key).slice(0, 80);
    if (!safeKey) continue;
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[safeKey] = value;
    } else if (typeof value === "string") {
      out[safeKey] = redactSensitiveText(value).slice(0, 500);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function newestFirstKeepingProtected(
  protectedIds: ReadonlySet<string>,
): (a: ArtifactRecord, b: ArtifactRecord) => number {
  return (a, b) => {
    const aProtected = protectedIds.has(a.id);
    const bProtected = protectedIds.has(b.id);
    if (aProtected !== bProtected) {
      return aProtected ? -1 : 1;
    }
    return b.createdAt - a.createdAt;
  };
}

async function getAllArtifacts(): Promise<ArtifactRecord[]> {
  return withTransaction(RR_V3_STORES.ARTIFACTS, "readonly", async (stores) => {
    const store = stores[RR_V3_STORES.ARTIFACTS];
    return requestToPromise(store.getAll() as IDBRequest<ArtifactRecord[]>);
  });
}

async function deleteArtifacts(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  return withTransaction(
    RR_V3_STORES.ARTIFACTS,
    "readwrite",
    async (stores) => {
      const store = stores[RR_V3_STORES.ARTIFACTS];
      await Promise.all(ids.map((id) => requestToPromise(store.delete(id))));
      return ids.length;
    },
  );
}

export function createIndexedDbArtifactStore(
  policyOverrides: Partial<ArtifactRetentionPolicy> = {},
  now: () => number = () => Date.now(),
): ArtifactStore {
  const policy = normalizeRetentionPolicy(policyOverrides);
  const enforceRetention = async (
    protectedIds: ReadonlySet<string> = new Set(),
  ): Promise<number> => {
    const records = await getAllArtifacts();
    const idsToDelete = new Set<string>();
    const newestFirst = newestFirstKeepingProtected(protectedIds);

    const byRun = new Map<string, ArtifactRecord[]>();
    for (const record of records) {
      const list = byRun.get(record.runId) || [];
      list.push(record);
      byRun.set(record.runId, list);
    }
    for (const list of byRun.values()) {
      list.sort(newestFirst);
      for (const stale of list.slice(policy.maxArtifactsPerRun)) {
        if (!protectedIds.has(stale.id)) {
          idsToDelete.add(stale.id);
        }
      }
    }

    const retained = records
      .filter((record) => !idsToDelete.has(record.id))
      .sort(newestFirst);
    let totalBytes = retained.reduce(
      (sum, record) => sum + Math.max(0, record.sizeBytes),
      0,
    );
    for (const record of retained.slice().reverse()) {
      if (totalBytes <= policy.maxTotalBytes) break;
      if (protectedIds.has(record.id)) continue;
      idsToDelete.add(record.id);
      totalBytes -= Math.max(0, record.sizeBytes);
    }

    return deleteArtifacts(Array.from(idsToDelete));
  };

  const storeApi: ArtifactStore = {
    async saveScreenshot(input) {
      const createdAt = now();
      const safeBase64 = input.base64.trim();
      const sizeBytes = estimateBase64Bytes(safeBase64);
      if (sizeBytes <= 0) {
        throw new Error("Artifact screenshot is empty");
      }
      if (sizeBytes > policy.maxArtifactBytes) {
        throw new Error(
          `Artifact screenshot exceeds maxArtifactBytes (${sizeBytes} > ${policy.maxArtifactBytes})`,
        );
      }

      const fallbackName = `${input.runId}_${input.nodeId}_${createdAt}.png`;
      const filename = sanitizeArtifactFilename(input.filename, fallbackName);
      const id = `${input.runId}/${input.nodeId}/${createdAt}_${Math.random().toString(36).slice(2, 8)}`;
      const record: ArtifactRecord = {
        id,
        runId: input.runId,
        nodeId: input.nodeId,
        kind: "screenshot",
        filename,
        mimeType: input.mimeType ?? "image/png",
        dataBase64: safeBase64,
        sizeBytes,
        createdAt,
        expiresAt: createdAt + Math.max(1, policy.ttlMs),
        metadata: sanitizeMetadata(input.metadata),
      };

      await withTransaction(
        RR_V3_STORES.ARTIFACTS,
        "readwrite",
        async (stores) => {
          const store = stores[RR_V3_STORES.ARTIFACTS];
          await requestToPromise(store.put(record));
        },
      );
      await storeApi.cleanupExpired(createdAt);
      await enforceRetention(new Set([record.id]));
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
          const records = await requestToPromise(
            index.getAll(runId) as IDBRequest<ArtifactRecord[]>,
          );
          return records.sort((a, b) => a.createdAt - b.createdAt);
        },
      );
    },

    async deleteByRun(runId) {
      const records = await storeApi.listByRun(runId);
      return deleteArtifacts(records.map((record) => record.id));
    },

    async cleanupExpired(cleanupNow = now()) {
      const expired = (await getAllArtifacts()).filter(
        (record) => record.expiresAt <= cleanupNow,
      );
      return deleteArtifacts(expired.map((record) => record.id));
    },

    enforceRetention,
  };

  return storeApi;
}
