import { STORAGE_KEYS } from "@/common/constants";

export const SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION = 1 as const;

export type SemanticMaintenanceKind =
  | "data-cleanup"
  | "index-recovery"
  | "index-rebuild";

export interface RequiredSemanticMaintenanceMarker {
  schemaVersion: typeof SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION;
  state: "required";
  attemptId: string;
  kind: SemanticMaintenanceKind;
  startedAt: number;
}

export interface ClearSemanticMaintenanceMarker {
  schemaVersion: typeof SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION;
  state: "clear";
  attemptId: string;
  completedAt: number;
}

export type SemanticMaintenanceMarker =
  | RequiredSemanticMaintenanceMarker
  | ClearSemanticMaintenanceMarker;

export type SemanticMaintenanceGate =
  | { state: "clear"; marker: ClearSemanticMaintenanceMarker | null }
  | { state: "required"; marker: RequiredSemanticMaintenanceMarker };

export class SemanticMaintenanceMarkerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticMaintenanceMarkerValidationError";
  }
}

const MAINTENANCE_KINDS = new Set<SemanticMaintenanceKind>([
  "data-cleanup",
  "index-recovery",
  "index-rebuild",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isAttemptId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function parseSemanticMaintenanceMarker(
  value: unknown,
): SemanticMaintenanceMarker {
  if (!isRecord(value)) {
    throw new SemanticMaintenanceMarkerValidationError(
      "Semantic maintenance marker is not an object",
    );
  }
  if (
    value.schemaVersion !== SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION ||
    !isAttemptId(value.attemptId)
  ) {
    throw new SemanticMaintenanceMarkerValidationError(
      "Semantic maintenance marker metadata is invalid",
    );
  }

  if (value.state === "required") {
    if (
      !hasExactKeys(value, [
        "schemaVersion",
        "state",
        "attemptId",
        "kind",
        "startedAt",
      ]) ||
      typeof value.kind !== "string" ||
      !MAINTENANCE_KINDS.has(value.kind as SemanticMaintenanceKind) ||
      !isTimestamp(value.startedAt)
    ) {
      throw new SemanticMaintenanceMarkerValidationError(
        "Required semantic maintenance marker is invalid",
      );
    }
    return {
      schemaVersion: SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION,
      state: "required",
      attemptId: value.attemptId,
      kind: value.kind as SemanticMaintenanceKind,
      startedAt: value.startedAt,
    };
  }

  if (value.state === "clear") {
    if (
      !hasExactKeys(value, [
        "schemaVersion",
        "state",
        "attemptId",
        "completedAt",
      ]) ||
      !isTimestamp(value.completedAt)
    ) {
      throw new SemanticMaintenanceMarkerValidationError(
        "Clear semantic maintenance marker is invalid",
      );
    }
    return {
      schemaVersion: SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION,
      state: "clear",
      attemptId: value.attemptId,
      completedAt: value.completedAt,
    };
  }

  throw new SemanticMaintenanceMarkerValidationError(
    "Semantic maintenance marker state is invalid",
  );
}

function sameMarker(
  left: SemanticMaintenanceMarker,
  right: SemanticMaintenanceMarker,
): boolean {
  if (
    left.schemaVersion !== right.schemaVersion ||
    left.state !== right.state ||
    left.attemptId !== right.attemptId
  ) {
    return false;
  }
  return left.state === "required" && right.state === "required"
    ? left.kind === right.kind && left.startedAt === right.startedAt
    : left.state === "clear" &&
        right.state === "clear" &&
        left.completedAt === right.completedAt;
}

async function readStoredMarker(): Promise<SemanticMaintenanceMarker | null> {
  const storageKey = STORAGE_KEYS.SEMANTIC_CLEANUP_REQUIRED;
  const stored = await chrome.storage.local.get([storageKey]);
  if (!Object.prototype.hasOwnProperty.call(stored, storageKey)) return null;
  return parseSemanticMaintenanceMarker(stored[storageKey]);
}

export async function readSemanticMaintenanceMarker(): Promise<SemanticMaintenanceGate> {
  const marker = await readStoredMarker();
  if (!marker || marker.state === "clear") {
    return { state: "clear", marker };
  }
  return { state: "required", marker };
}

async function writeAndVerifyMarker(
  marker: SemanticMaintenanceMarker,
): Promise<void> {
  const storageKey = STORAGE_KEYS.SEMANTIC_CLEANUP_REQUIRED;
  await chrome.storage.local.set({ [storageKey]: marker });
  const stored = await readStoredMarker();
  if (!stored || !sameMarker(stored, marker)) {
    throw new Error("Semantic maintenance marker readback mismatched");
  }
}

function createAttemptId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const random = new Uint32Array(4);
  crypto.getRandomValues(random);
  return `${Date.now()}-${Array.from(random, (value) =>
    value.toString(16).padStart(8, "0"),
  ).join("")}`;
}

export async function armSemanticMaintenance(
  kind: SemanticMaintenanceKind,
): Promise<RequiredSemanticMaintenanceMarker> {
  if (!MAINTENANCE_KINDS.has(kind)) {
    throw new Error("Unsupported semantic maintenance kind");
  }
  const marker: RequiredSemanticMaintenanceMarker = {
    schemaVersion: SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION,
    state: "required",
    attemptId: createAttemptId(),
    kind,
    startedAt: Date.now(),
  };
  await writeAndVerifyMarker(marker);
  return marker;
}

export async function completeSemanticMaintenance(
  ownedMarker: RequiredSemanticMaintenanceMarker,
): Promise<ClearSemanticMaintenanceMarker> {
  const current = await readStoredMarker();
  if (
    !current ||
    current.state !== "required" ||
    current.attemptId !== ownedMarker.attemptId
  ) {
    throw new Error(
      "Semantic maintenance marker is no longer owned by this attempt",
    );
  }
  if (!sameMarker(current, ownedMarker)) {
    throw new Error("Semantic maintenance marker ownership metadata changed");
  }

  const clearMarker: ClearSemanticMaintenanceMarker = {
    schemaVersion: SEMANTIC_MAINTENANCE_MARKER_SCHEMA_VERSION,
    state: "clear",
    attemptId: ownedMarker.attemptId,
    completedAt: Date.now(),
  };
  try {
    await writeAndVerifyMarker(clearMarker);
  } catch (completionError) {
    try {
      let currentAfterFailure: SemanticMaintenanceMarker | null = null;
      try {
        currentAfterFailure = await readStoredMarker();
      } catch {
        // A failed read cannot prove that another owner replaced the marker.
        // The per-worker maintenance queue is exclusive, so restore our owned
        // requirement and verify it before reporting the failed completion.
      }
      if (
        currentAfterFailure &&
        currentAfterFailure.attemptId !== ownedMarker.attemptId
      ) {
        throw completionError;
      }
      if (
        !currentAfterFailure ||
        !sameMarker(currentAfterFailure, ownedMarker)
      ) {
        await writeAndVerifyMarker(ownedMarker);
      }
    } catch (restoreError) {
      if (restoreError === completionError) throw completionError;
      throw new AggregateError(
        [completionError, restoreError],
        "Semantic maintenance completion failed and the required marker could not be restored",
      );
    }
    throw completionError;
  }
  return clearMarker;
}
