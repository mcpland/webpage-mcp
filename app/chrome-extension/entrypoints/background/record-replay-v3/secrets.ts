import type { JsonObject, JsonValue } from "./domain/json";

export const WORKFLOW_SECRET_STORE_KEY = "webpageMcpWorkflowSecrets";

type WorkflowSecretScope = "session" | "profile" | "workflow";

export interface WorkflowSecretRefValue {
  secretRef: string;
  scope?: WorkflowSecretScope;
}

export class WorkflowSecretRefError extends Error {
  readonly code: string;
  readonly path: string;
  readonly secretRef?: string;

  constructor(
    code: string,
    message: string,
    options: { path: string; secretRef?: string },
  ) {
    super(message);
    this.name = "WorkflowSecretRefError";
    this.code = code;
    this.path = options.path;
    this.secretRef = options.secretRef;
  }
}

interface StoredWorkflowSecret {
  value?: unknown;
  expiresAt?: unknown;
  revoked?: unknown;
  scope?: unknown;
  rotationId?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item));
}

function normalizeSecretScope(value: unknown): WorkflowSecretScope | undefined {
  return value === "session" || value === "profile" || value === "workflow" ? value : undefined;
}

export function isWorkflowSecretRefValue(value: unknown): value is WorkflowSecretRefValue {
  return isRecord(value) && typeof value.secretRef === "string" && value.secretRef.trim().length > 0;
}

function normalizeSecretRef(value: WorkflowSecretRefValue, path: string): WorkflowSecretRefValue {
  const secretRef = value.secretRef.trim();
  if (!secretRef) {
    throw new WorkflowSecretRefError("SECRET_REF_INVALID", "secretRef must be a non-empty string", {
      path,
    });
  }
  const scope = normalizeSecretScope(value.scope);
  return { secretRef, ...(scope ? { scope } : {}) };
}

async function readSecretStoreFromArea(
  area: chrome.storage.StorageArea | undefined,
): Promise<Record<string, unknown>> {
  if (!area?.get) {
    return {};
  }
  try {
    const result = (await area.get(WORKFLOW_SECRET_STORE_KEY)) as Record<string, unknown>;
    const store = result?.[WORKFLOW_SECRET_STORE_KEY];
    return isRecord(store) ? store : {};
  } catch {
    return {};
  }
}

async function readSecretStore(): Promise<Record<string, unknown>> {
  const storage = globalThis.chrome?.storage;
  const sessionStore = await readSecretStoreFromArea(storage?.session);
  const localStore = await readSecretStoreFromArea(storage?.local);
  return {
    ...localStore,
    ...sessionStore,
  };
}

function unwrapStoredSecret(raw: unknown): StoredWorkflowSecret | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (
    isRecord(raw) &&
    (Object.prototype.hasOwnProperty.call(raw, "value") ||
      Object.prototype.hasOwnProperty.call(raw, "expiresAt") ||
      Object.prototype.hasOwnProperty.call(raw, "revoked"))
  ) {
    return raw;
  }
  return { value: raw };
}

function assertSecretScopeMatches(
  stored: StoredWorkflowSecret,
  ref: WorkflowSecretRefValue,
  path: string,
): void {
  const storedScope = normalizeSecretScope(stored.scope);
  if (!storedScope && !ref.scope) {
    return;
  }
  if (storedScope !== ref.scope) {
    throw new WorkflowSecretRefError(
      "SECRET_REF_SCOPE_MISMATCH",
      `Secret reference scope does not match stored secret scope: ${ref.secretRef}`,
      { path, secretRef: ref.secretRef },
    );
  }
}

function resolveStoredSecretValue(
  store: Record<string, unknown>,
  ref: WorkflowSecretRefValue,
  path: string,
): JsonValue {
  const stored = unwrapStoredSecret(store[ref.secretRef]);
  if (!stored) {
    throw new WorkflowSecretRefError(
      "SECRET_REF_NOT_FOUND",
      `Secret reference was not found: ${ref.secretRef}`,
      { path, secretRef: ref.secretRef },
    );
  }
  if (stored.revoked === true) {
    throw new WorkflowSecretRefError(
      "SECRET_REF_REVOKED",
      `Secret reference has been revoked: ${ref.secretRef}`,
      { path, secretRef: ref.secretRef },
    );
  }
  assertSecretScopeMatches(stored, ref, path);
  if (typeof stored.expiresAt === "string") {
    const expiresAtMs = Date.parse(stored.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      throw new WorkflowSecretRefError(
        "SECRET_REF_EXPIRED",
        `Secret reference has expired: ${ref.secretRef}`,
        { path, secretRef: ref.secretRef },
      );
    }
  }
  if (!isJsonValue(stored.value)) {
    throw new WorkflowSecretRefError(
      "SECRET_REF_INVALID_VALUE",
      `Secret reference does not contain a JSON-serializable value: ${ref.secretRef}`,
      { path, secretRef: ref.secretRef },
    );
  }
  return stored.value;
}

function resolveNestedSecretRefs(
  value: JsonValue,
  store: Record<string, unknown>,
  path: string,
): JsonValue {
  if (isWorkflowSecretRefValue(value)) {
    return resolveStoredSecretValue(store, normalizeSecretRef(value, path), path);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveNestedSecretRefs(item, store, `${path}/${index}`));
  }
  if (isRecord(value)) {
    const resolved: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      resolved[key] = resolveNestedSecretRefs(nested as JsonValue, store, `${path}/${key}`);
    }
    return resolved;
  }
  return value;
}

function assertNestedSecretRefsResolvable(
  value: JsonValue,
  store: Record<string, unknown>,
  path: string,
): void {
  if (isWorkflowSecretRefValue(value)) {
    resolveStoredSecretValue(store, normalizeSecretRef(value, path), path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNestedSecretRefsResolvable(item, store, `${path}/${index}`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      assertNestedSecretRefsResolvable(nested as JsonValue, store, `${path}/${key}`);
    }
  }
}

export async function assertWorkflowSecretRefsResolvable(args: JsonObject | undefined): Promise<void> {
  if (!args) {
    return;
  }
  const store = await readSecretStore();
  assertNestedSecretRefsResolvable(args, store, "/args");
}

export async function resolveWorkflowSecretRefs(
  args: JsonObject | undefined,
): Promise<JsonObject | undefined> {
  if (!args) {
    return undefined;
  }
  const store = await readSecretStore();
  return resolveNestedSecretRefs(args, store, "/args") as JsonObject;
}
